// The session log's file format (main process only). A log is text that is
// safe to `cat` into a terminal whatever the server sent, since the bytes a
// server sends are never written as they are: the first line says what the
// file is, and every line after it is one record, base64.
//
//   MOOLIN-LOG 1 plain             or   MOOLIN-LOG 1 encrypted <key id> <file id>
//   0 <base64 of a record>
//   1 <base64 of a record>
//
// A record is what one write added to the scrollback: its length, its bytes,
// and the arrival time of each line feed in it (so there is no separate file of
// times to keep in step). Its line is a sequence number, a space, then the
// base64: 0, 1, 2 and so on down the file. In an encrypted log the header also
// carries a random id for the file, and each record is sealed with the data key
// (AES-256-GCM) with the header and the record's sequence number as its
// authenticated context. So a record can't be moved into another log (a
// different id), or repeated, or put out of order (a number that is not higher
// than the one before is skipped when reading). What can't be detected is a
// record, or the end of the log, being deleted. Because a record is a line that
// ends in a newline, a crash can only leave the last line unfinished, and that
// is dropped when the log is next opened.
//
// Each record gets a random 96-bit nonce under the one data key, which stays
// safe for up to about 2^32 records (NIST's limit for random GCM nonces).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { PRIVATE_FILE_MODE } from "./file-modes";
import { keyIdOf, open, seal } from "./crypto-keys";
import { countLineFeeds } from "./line-feeds";
import type { LogCursor } from "./history-paging";

export type { LogCursor } from "./history-paging";

export type LogMode = { kind: "plain" } | { kind: "encrypted"; dataKey: Buffer };
export const PLAIN: LogMode = { kind: "plain" };

export type LogFormat = { kind: "plain" } | { kind: "encrypted"; keyId: string; fileId: string };

// What a log has held: its bytes, and the time of each line feed in them.
export interface LogHistory {
  bytes: Uint8Array;
  times: Array<number | null>;
}

const MAGIC = "MOOLIN-LOG 1";
const TIME_BYTES = 8;
const BLOCK_BYTES = 1024 * 1024;
const HEADER_SCAN_BYTES = 128;
const RECORD_LINE = /^(\d{1,15}) ([A-Za-z0-9+/]*={0,2})$/;
const NOT_A_LOG = "the file is not a Moolin log";

export class WrongLogKeyError extends Error {
  constructor() {
    super("The log was encrypted with a different key");
    this.name = "WrongLogKeyError";
  }
}

// Whether a log in `format` is one `mode` writes: the same kind, and for an
// encrypted one the same key.
export function matchesMode(format: LogFormat, mode: LogMode): boolean {
  if (format.kind === "plain") return mode.kind === "plain";
  return mode.kind === "encrypted" && format.keyId === keyIdOf(mode.dataKey);
}

export function headerFor(format: LogFormat): string {
  return format.kind === "plain" ? `${MAGIC} plain` : `${MAGIC} encrypted ${format.keyId} ${format.fileId}`;
}

// The header for a new file in `mode`, with a fresh id if it is encrypted.
export function newHeader(mode: LogMode): string {
  if (mode.kind === "plain") return headerFor({ kind: "plain" });
  const fileId = crypto.randomBytes(8).toString("hex");
  return headerFor({ kind: "encrypted", keyId: keyIdOf(mode.dataKey), fileId });
}

export function parseHeader(line: string): LogFormat | null {
  if (line === `${MAGIC} plain`) return { kind: "plain" };
  const match = /^MOOLIN-LOG 1 encrypted ([0-9a-f]{16}) ([0-9a-f]{16})$/.exec(line);
  return match ? { kind: "encrypted", keyId: match[1], fileId: match[2] } : null;
}

// What an encrypted record is bound to: its file, and its place in it.
function contextOf(header: string, seq: number): Buffer {
  return Buffer.from(`${header}\n${seq}`);
}

export function encodeRecord(
  mode: LogMode,
  header: string,
  seq: number,
  data: Uint8Array,
  times: ReadonlyArray<number | null>,
): string {
  const plain = Buffer.alloc(4 + data.length + TIME_BYTES * times.length);
  plain.writeUInt32LE(data.length, 0);
  plain.set(data, 4);
  for (let i = 0; i < times.length; i++) {
    plain.writeDoubleLE(times[i] ?? Number.NaN, 4 + data.length + i * TIME_BYTES);
  }
  const body = mode.kind === "plain" ? plain : seal(mode.dataKey, plain, contextOf(header, seq));
  return `${seq} ${body.toString("base64")}\n`;
}

// Throws for a line that isn't a record of this file: damaged, from another
// file or mode, or sealed with another key.
export function decodeRecord(
  line: string,
  mode: LogMode,
  header: string,
): { seq: number; data: Buffer; times: Array<number | null> } {
  const match = RECORD_LINE.exec(line);
  if (!match) throw new Error("not a record");
  const seq = Number(match[1]);
  const body = Buffer.from(match[2], "base64");
  const plain = mode.kind === "plain" ? body : open(mode.dataKey, body, contextOf(header, seq));
  if (plain.length < 4) throw new Error("record too short");
  const length = plain.readUInt32LE(0);
  if (4 + length > plain.length) throw new Error("record length is wrong");
  const data = plain.subarray(4, 4 + length);
  const lineFeeds = countLineFeeds(data);
  if (plain.length !== 4 + length + TIME_BYTES * lineFeeds) throw new Error("record times are wrong");
  const times: Array<number | null> = [];
  for (let i = 0; i < lineFeeds; i++) {
    const time = plain.readDoubleLE(4 + length + i * TIME_BYTES);
    times.push(Number.isNaN(time) ? null : time);
  }
  return { seq, data, times };
}

export type Inspection = "missing" | "empty" | "foreign" | LogFormat;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

// Whether `head` (a file with no newline) is the start of a header the app died
// writing, so the file holds nothing yet.
function isTornHeader(head: string): boolean {
  return (
    `${MAGIC} plain`.startsWith(head) ||
    `${MAGIC} encrypted `.startsWith(head) ||
    /^MOOLIN-LOG 1 encrypted [0-9a-f]{0,16}( [0-9a-f]{0,16})?$/.test(head)
  );
}

// What is in `file`: nothing, a log, or something else (which is never written
// to or converted). A file that is only the start of a header (the app died
// writing it) counts as empty.
export function inspectLog(file: string): Inspection {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "missing";
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return "empty";
    const head = readAt(fd, 0, Math.min(size, HEADER_SCAN_BYTES)).toString("latin1");
    const newline = head.indexOf("\n");
    if (newline === -1) return size < HEADER_SCAN_BYTES && isTornHeader(head) ? "empty" : "foreign";
    return parseHeader(head.slice(0, newline)) ?? "foreign";
  } finally {
    fs.closeSync(fd);
  }
}

// Calls `onLine` for every complete line (ending in a newline) of `file`, a
// block at a time. An unfinished last line is not given. Stops early if `onLine`
// returns false.
function forEachLine(file: string, onLine: (line: string) => boolean | undefined): void {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(BLOCK_BYTES);
    let carry = Buffer.alloc(0);
    for (let position = 0; ; ) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (n === 0) return;
      position += n;
      let chunk = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n);
      for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a)) {
        if (onLine(chunk.subarray(0, newline).toString("latin1")) === false) return;
        chunk = chunk.subarray(newline + 1);
      }
      carry = Buffer.from(chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Makes the log fit to append to: a file with no complete header gets one, and
// an unfinished last line (the app died writing it) is cut off. `mode` must be
// the one the file is in (see convertLog). Returns the file's header, which its
// records are sealed against, and the sequence number of the next record.
export function prepareForAppend(file: string, mode: LogMode): { header: string; nextSeq: number } {
  const found = inspectLog(file);
  if (found === "missing" || found === "empty") {
    const header = newHeader(mode);
    fs.writeFileSync(file, `${header}\n`, { mode: PRIVATE_FILE_MODE });
    return { header, nextSeq: 0 };
  }
  if (found === "foreign") throw new Error(NOT_A_LOG);
  if (!matchesMode(found, mode)) throw new WrongLogKeyError();
  cutUnfinishedLine(file);
  return { header: headerFor(found), nextSeq: lastSeq(file) + 1 };
}

function cutUnfinishedLine(file: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0 || readAt(fd, size - 1, 1)[0] === 0x0a) return;
    // Find the last newline, looking back a block at a time.
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - BLOCK_BYTES);
      const block = readAt(fd, start, end - start);
      const newline = block.lastIndexOf(0x0a);
      if (newline !== -1) {
        fs.ftruncateSync(fd, start + newline + 1);
        return;
      }
      end = start;
    }
    fs.ftruncateSync(fd, 0);
  } finally {
    fs.closeSync(fd);
  }
}

// The sequence number of the last record in a log that ends in a newline, or -1
// if it has none. Read from the end; a last line that can't be read that way
// sends it through the whole file.
function lastSeq(file: string): number {
  const fd = fs.openSync(file, "r");
  let tail = Buffer.alloc(0);
  try {
    const size = fs.fstatSync(fd).size;
    // The last line is what follows the second-to-last newline.
    for (let end = size - 1; end > 0 && tail.indexOf(0x0a) === -1; ) {
      const start = Math.max(0, end - BLOCK_BYTES);
      tail = Buffer.concat([readAt(fd, start, end - start), tail]);
      end = start;
    }
  } finally {
    fs.closeSync(fd);
  }
  const line = tail.subarray(tail.lastIndexOf(0x0a) + 1).toString("latin1");
  const match = RECORD_LINE.exec(line);
  if (match) return Number(match[1]);
  if (tail.indexOf(0x0a) === -1 && parseHeader(line)) return -1;
  let last = -1;
  forEachLine(file, (each) => {
    const found = RECORD_LINE.exec(each);
    if (found) last = Number(found[1]);
    return undefined;
  });
  return last;
}

// A piece of the log, with the cursor for what lies before it (null when
// nothing readable does).
export interface LogPage extends LogHistory {
  before: LogCursor | null;
}

export interface PageLimits {
  // The most bytes to return.
  maxBytes: number;
  // The most lines (line feeds) to return, if fewer than `maxBytes` allows.
  maxLines?: number;
  // When no line boundary lies within reach, return everything read (which may
  // begin mid-line) rather than nothing, so a reader paging back always moves on.
  lenient?: boolean;
}

const EMPTY_PAGE: LogPage = { bytes: new Uint8Array(), times: [], before: null };

interface Piece {
  offset: number;
  data: Buffer;
  times: Array<number | null>;
}

// The most recent `maxBytes` of what the log holds, cut forward to a line
// boundary if the start had to be dropped (so it never begins mid-line or
// mid-escape-sequence), with the time of each line feed in it. Empty for a log
// that is missing or empty. A record that can't be read, or whose number is not
// higher than the one before it, is skipped. Throws if the log is in the other
// mode, needs another key, or is not a log.
export function readLogHistory(file: string, mode: LogMode, maxBytes: number): LogHistory {
  const { bytes, times } = readLogPage(file, mode, null, { maxBytes });
  return { bytes, times };
}

// A page of the log that ends at `before` (the end of the log if null), at most
// `limits` long and cut forward to a line boundary like readLogHistory, with the
// cursor for the page before it.
export function readLogPage(file: string, mode: LogMode, before: LogCursor | null, limits: PageLimits): LogPage {
  const found = inspectLog(file);
  if (found === "missing" || found === "empty") return EMPTY_PAGE;
  if (found === "foreign") throw new Error(NOT_A_LOG);
  if (!matchesMode(found, mode)) throw new WrongLogKeyError();
  const header = headerFor(found);
  const { maxBytes, maxLines = Number.POSITIVE_INFINITY, lenient = false } = limits;

  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const headerEnd = header.length + 1;
    if (before && (before.offset < headerEnd || before.offset > size)) return EMPTY_PAGE;
    const end = before ? before.offset : size;

    // The record the cursor is inside holds the newest of the page, up to the cursor.
    let newest: Piece | null = null;
    if (before && before.skip > 0) {
      const line = readAt(fd, before.offset, Math.min(size - before.offset, BLOCK_BYTES * 4));
      const newline = line.indexOf(0x0a);
      try {
        if (newline !== -1) {
          const record = decodeRecord(line.toString("latin1", 0, newline), mode, header);
          const data = record.data.subarray(0, before.skip);
          newest = { offset: before.offset, data, times: record.times.slice(0, countLineFeeds(data)) };
        }
      } catch {
        // Skipped, like any record that can't be read.
      }
    }

    // A record is a little over a third bigger than its bytes, so a window of
    // twice as much covers `maxBytes` of them, and is doubled if it did not.
    for (let window = Math.max(maxBytes * 2, BLOCK_BYTES); ; window *= 2) {
      let start = Math.max(headerEnd, end - window);
      let block = readAt(fd, start, end - start);
      if (start > headerEnd) {
        const firstNewline = block.indexOf(0x0a);
        start = firstNewline === -1 ? end : start + firstNewline + 1;
        block = firstNewline === -1 ? Buffer.alloc(0) : block.subarray(firstNewline + 1);
      }
      const lastNewline = block.lastIndexOf(0x0a);
      block = lastNewline === -1 ? Buffer.alloc(0) : block.subarray(0, lastNewline + 1);

      const pieces: Piece[] = [];
      let total = 0;
      let lines = 0;
      let previous = -1;
      for (let position = 0; position < block.length; ) {
        const newline = block.indexOf(0x0a, position);
        const offset = start + position;
        const text = block.toString("latin1", position, newline);
        position = newline + 1;
        if (text === "") continue;
        try {
          const record = decodeRecord(text, mode, header);
          if (record.seq <= previous) continue;
          previous = record.seq;
          pieces.push({ offset, data: record.data, times: record.times });
          total += record.data.length;
          lines += record.times.length;
        } catch {
          // Skipped; the lines around it are still good.
        }
      }
      if (newest) {
        pieces.push(newest);
        total += newest.data.length;
        lines += newest.times.length;
      }
      const atStart = start === headerEnd;
      if (total >= maxBytes || lines >= maxLines || atStart || window > size)
        return cutPage(pieces, atStart, { maxBytes, maxLines, lenient });
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The newest `maxBytes` and `maxLines` of `pieces`, from the first line feed on,
// with the cursor for what was left out. `atStart` says nothing older exists.
function cutPage(pieces: Piece[], atStart: boolean, limits: Required<PageLimits>): LogPage {
  const bytes = Buffer.concat(pieces.map((piece) => piece.data));
  const times = pieces.flatMap((piece) => piece.times);
  let drop = Math.max(0, bytes.length - limits.maxBytes);
  if (times.length > limits.maxLines) drop = Math.max(drop, endOfLine(bytes, times.length - limits.maxLines));
  let cut = 0;
  if (drop > 0) {
    const newline = bytes.indexOf(0x0a, drop - 1);
    if (newline !== -1 && newline + 1 < bytes.length) cut = newline + 1;
    else if (!limits.lenient) return EMPTY_PAGE;
  }
  return {
    bytes: new Uint8Array(bytes.subarray(cut)),
    times: times.slice(countLineFeeds(bytes.subarray(0, cut))),
    before: cut === 0 && atStart ? null : cursorAt(pieces, cut),
  };
}

// The index just past the `count`th line feed (LF, VT or FF) in `bytes`.
function endOfLine(bytes: Buffer, count: number): number {
  let seen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if ((byte === 0x0a || byte === 0x0b || byte === 0x0c) && ++seen === count) return i + 1;
  }
  return bytes.length;
}

// The cursor for byte `index` of the pieces' bytes taken together.
function cursorAt(pieces: Piece[], index: number): LogCursor | null {
  let from = 0;
  for (const piece of pieces) {
    if (index < from + piece.data.length) return { offset: piece.offset, skip: index - from };
    from += piece.data.length;
  }
  return null;
}

// Writes `file` anew in `target`, through a temporary file renamed over it, so
// a crash leaves the old one whole. `fill` appends the records.
function rewrite(
  file: string,
  target: LogMode,
  fill: (append: (data: Uint8Array, times: Array<number | null>) => void) => void,
): void {
  const header = newHeader(target);
  let seq = 0;
  const temp = `${file}.convert-${process.pid}`;
  const fd = fs.openSync(temp, "w", PRIVATE_FILE_MODE);
  try {
    fs.writeSync(fd, `${header}\n`);
    fill((data, times) => {
      if (data.length > 0) fs.writeSync(fd, encodeRecord(target, header, seq++, data, times));
    });
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.renameSync(temp, file);
}

// Puts `file` in `target`'s mode, converting a log in the other mode
// (`sourceKey` opens an encrypted one). Returns whether it changed
// anything. Throws if the log can't be read with the key, and leaves it as it
// was.
export function convertLog(file: string, target: LogMode, sourceKey: Buffer | null): boolean {
  const found = inspectLog(file);
  if (found === "missing") return false;
  if (found === "empty") {
    rewrite(file, target, () => {});
    return true;
  }
  if (found === "foreign") throw new Error(NOT_A_LOG);
  if (matchesMode(found, target)) return false;

  let source: LogMode;
  if (found.kind === "plain") {
    source = PLAIN;
  } else {
    if (!sourceKey || keyIdOf(sourceKey) !== found.keyId) throw new WrongLogKeyError();
    source = { kind: "encrypted", dataKey: sourceKey };
  }
  const sourceHeader = headerFor(found);
  let first = true;
  rewrite(file, target, (append) => {
    forEachLine(file, (line) => {
      if (first) {
        first = false;
        return; // the header
      }
      const record = decodeRecord(line, source, sourceHeader);
      append(record.data, record.times);
    });
  });
  return true;
}
