// The session log's file format (main process only). A log is text that is
// safe to `cat` into a terminal whatever the server sent, since the bytes a
// server sends are never written as they are: the first line says what the
// file is, and every line after it is one record, base64.
//
//   MOOLIN-LOG 1 plain                       or   MOOLIN-LOG 1 encrypted <key id>
//   <base64 of a record>
//   <base64 of a record>
//
// A record is what one write added to the scrollback: its length, its bytes,
// and the arrival time of each line feed in it (so there is no separate file of
// times to keep in step). In an encrypted log each record is also sealed with
// the data key (AES-256-GCM, the header line as its authenticated context, so a
// record can't be moved into another file or mode). Because a record is a line
// that ends in a newline, a crash can only leave the last line unfinished, and
// that is dropped when the log is next opened.
//
// Logs from before this format (the server's raw bytes, with an optional
// `.times` file of arrival times beside them) are recognised by having no such
// first line, and converted on first use.
import * as fs from "node:fs";
import { PRIVATE_FILE_MODE } from "./file-modes";
import { keyIdOf, open, seal } from "./crypto-keys";
import { countLineFeeds } from "./line-feeds";

export type LogMode = { kind: "plain" } | { kind: "encrypted"; dataKey: Buffer };
export const PLAIN: LogMode = { kind: "plain" };

export type LogFormat = { kind: "plain" } | { kind: "encrypted"; keyId: string };

// What a log has held: its bytes, and the time of each line feed in them.
export interface LogHistory {
  bytes: Uint8Array;
  times: Array<number | null>;
}

// A log's bytes before this format, and the file of times beside them.
export const LEGACY_TIMES_SUFFIX = ".times";
export const LEGACY_OPEN_SUFFIX = ".open";

const MAGIC = "MOOLIN-LOG 1";
const TIME_BYTES = 8;
const BLOCK_BYTES = 1024 * 1024;
const HEADER_SCAN_BYTES = 128;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class WrongLogKeyError extends Error {
  constructor() {
    super("The log was encrypted with a different key");
    this.name = "WrongLogKeyError";
  }
}

export function formatOf(mode: LogMode): LogFormat {
  return mode.kind === "plain" ? { kind: "plain" } : { kind: "encrypted", keyId: keyIdOf(mode.dataKey) };
}

export function headerFor(format: LogFormat): string {
  return format.kind === "plain" ? `${MAGIC} plain` : `${MAGIC} encrypted ${format.keyId}`;
}

export function parseHeader(line: string): LogFormat | null {
  if (line === `${MAGIC} plain`) return { kind: "plain" };
  const match = /^MOOLIN-LOG 1 encrypted ([0-9a-f]{16})$/.exec(line);
  return match ? { kind: "encrypted", keyId: match[1] } : null;
}

export function encodeRecord(
  mode: LogMode,
  header: string,
  data: Uint8Array,
  times: ReadonlyArray<number | null>,
): string {
  const plain = Buffer.alloc(4 + data.length + TIME_BYTES * times.length);
  plain.writeUInt32LE(data.length, 0);
  plain.set(data, 4);
  for (let i = 0; i < times.length; i++) {
    plain.writeDoubleLE(times[i] ?? Number.NaN, 4 + data.length + i * TIME_BYTES);
  }
  const body = mode.kind === "plain" ? plain : seal(mode.dataKey, plain, Buffer.from(header));
  return `${body.toString("base64")}\n`;
}

// Throws for a line that isn't a record of this file: damaged, from another
// file or mode, or sealed with another key.
export function decodeRecord(
  line: string,
  mode: LogMode,
  header: string,
): { data: Buffer; times: Array<number | null> } {
  if (!BASE64.test(line)) throw new Error("not base64");
  const body = Buffer.from(line, "base64");
  const plain = mode.kind === "plain" ? body : open(mode.dataKey, body, Buffer.from(header));
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
  return { data, times };
}

export type Inspection = "missing" | "empty" | "legacy" | LogFormat;

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

// What is in `file`: nothing, a log from before this format, or a log of this
// one, in which mode. A file that is only the start of a header (the app died
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
    if (newline === -1)
      return MAGIC.startsWith(head.slice(0, MAGIC.length)) && size < HEADER_SCAN_BYTES ? "empty" : "legacy";
    return parseHeader(head.slice(0, newline)) ?? "legacy";
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

// Opens the log for appending, and makes it fit to append to: a file with no
// complete header gets one, and an unfinished last line (the app died writing
// it) is cut off. `mode` must be the one the file is in (see convertLog).
export function prepareForAppend(file: string, mode: LogMode): void {
  const header = headerFor(formatOf(mode));
  const found = inspectLog(file);
  if (found === "missing" || found === "empty") {
    fs.writeFileSync(file, `${header}\n`, { mode: PRIVATE_FILE_MODE });
    return;
  }
  if (found === "legacy") throw new Error("the log is in an older format and has not been converted");
  if (found.kind !== formatOf(mode).kind || (found.kind === "encrypted" && found.keyId !== keyIdOf(modeKey(mode)))) {
    throw new WrongLogKeyError();
  }
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

function modeKey(mode: LogMode): Buffer {
  if (mode.kind !== "encrypted") throw new Error("a plain log has no key");
  return mode.dataKey;
}

// The most recent `maxBytes` of what the log holds, cut forward to a line
// boundary if the start had to be dropped (so it never begins mid-line or
// mid-escape-sequence), with the time of each line feed in it. Empty for a log
// that is missing or empty. A record that can't be read is skipped. Throws if
// the log is in the other mode, needs another key, or is not yet converted.
export function readLogHistory(file: string, mode: LogMode, maxBytes: number): LogHistory {
  const empty: LogHistory = { bytes: new Uint8Array(), times: [] };
  const found = inspectLog(file);
  if (found === "missing" || found === "empty") return empty;
  const wanted = formatOf(mode);
  if (found === "legacy") throw new Error("the log is in an older format and has not been converted");
  if (
    found.kind !== wanted.kind ||
    (found.kind === "encrypted" && wanted.kind === "encrypted" && found.keyId !== wanted.keyId)
  ) {
    throw new WrongLogKeyError();
  }
  const header = headerFor(wanted);

  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const headerEnd = header.length + 1;
    // A record is a little over a third bigger than its bytes, so a window of
    // twice as much covers `maxBytes` of them, and is doubled if it did not.
    for (let window = Math.max(maxBytes * 2, BLOCK_BYTES); ; window *= 2) {
      const start = Math.max(headerEnd, size - window);
      let block = readAt(fd, start, size - start);
      if (start > headerEnd) {
        const firstNewline = block.indexOf(0x0a);
        block = firstNewline === -1 ? Buffer.alloc(0) : block.subarray(firstNewline + 1);
      }
      const lastNewline = block.lastIndexOf(0x0a);
      block = lastNewline === -1 ? Buffer.alloc(0) : block.subarray(0, lastNewline + 1);

      const pieces: Buffer[] = [];
      const times: Array<number | null> = [];
      let total = 0;
      for (const line of block.toString("latin1").split("\n")) {
        if (line === "") continue;
        try {
          const record = decodeRecord(line, mode, header);
          pieces.push(record.data);
          times.push(...record.times);
          total += record.data.length;
        } catch {
          // Skipped; the lines around it are still good.
        }
      }
      if (total >= maxBytes || start === headerEnd || window > size)
        return cutToTail(Buffer.concat(pieces), times, maxBytes);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// The last `maxBytes` of `bytes` from the first line feed on, with the times
// of the line feeds left.
function cutToTail(bytes: Buffer, times: Array<number | null>, maxBytes: number): LogHistory {
  if (bytes.length <= maxBytes) return { bytes: new Uint8Array(bytes), times };
  const dropped = bytes.length - maxBytes;
  const newline = bytes.indexOf(0x0a, dropped - 1);
  if (newline === -1) return { bytes: new Uint8Array(), times: [] };
  const kept = bytes.subarray(newline + 1);
  const droppedLineFeeds = countLineFeeds(bytes.subarray(0, newline + 1));
  return { bytes: new Uint8Array(kept), times: times.slice(droppedLineFeeds) };
}

// Reads a legacy log's file of times: one float64 per line feed, NaN for none.
function readLegacyTimes(file: string): Array<number | null> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file + LEGACY_TIMES_SUFFIX);
  } catch {
    return [];
  }
  const times: Array<number | null> = [];
  for (let i = 0; i + TIME_BYTES <= raw.length; i += TIME_BYTES) {
    const time = raw.readDoubleLE(i);
    times.push(Number.isNaN(time) ? null : time);
  }
  return times;
}

function countFileLineFeeds(file: string): number {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(BLOCK_BYTES);
    let count = 0;
    for (let position = 0; ; ) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (n === 0) return count;
      count += countLineFeeds(buffer.subarray(0, n));
      position += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Writes `file` anew in `target`, through a temporary file renamed over it, so
// a crash leaves the old one whole. `fill` appends the records.
function rewrite(
  file: string,
  target: LogMode,
  fill: (append: (data: Uint8Array, times: Array<number | null>) => void) => void,
): void {
  const header = headerFor(formatOf(target));
  const temp = `${file}.convert-${process.pid}`;
  const fd = fs.openSync(temp, "w", PRIVATE_FILE_MODE);
  try {
    fs.writeSync(fd, `${header}\n`);
    fill((data, times) => {
      if (data.length > 0) fs.writeSync(fd, encodeRecord(target, header, data, times));
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

// Puts `file` in `target`'s mode, converting a legacy log or one in the other
// mode (`sourceKey` opens an encrypted one). Returns whether it changed
// anything. Throws if the log can't be read with the key, and leaves it as it
// was.
export function convertLog(file: string, target: LogMode, sourceKey: Buffer | null): boolean {
  const found = inspectLog(file);
  if (found === "missing") return false;
  const wanted = formatOf(target);
  if (found === "empty") {
    rewrite(file, target, () => {});
    return true;
  }
  if (found === "legacy") {
    migrateLegacy(file, target);
    return true;
  }
  if (found.kind === wanted.kind && (found.kind === "plain" || found.keyId === (wanted as { keyId: string }).keyId)) {
    return false;
  }

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

// A log from before this format: the raw bytes, and perhaps a file of times
// aligned to the end of it (a log older than the times file has fewer times
// than line feeds, the earlier lines having none).
function migrateLegacy(file: string, target: LogMode): void {
  const times = readLegacyTimes(file);
  // Line feed number i has times[i + offset], when there is one.
  const offset = times.length - countFileLineFeeds(file);
  let lineFeed = 0;
  rewrite(file, target, (append) => {
    const emit = (data: Buffer): void => {
      const recordTimes: Array<number | null> = [];
      for (let i = countLineFeeds(data); i > 0; i--) recordTimes.push(times[lineFeed++ + offset] ?? null);
      append(data, recordTimes);
    };
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(BLOCK_BYTES);
      let carry = Buffer.alloc(0);
      for (let position = 0; ; ) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, position);
        if (n === 0) break;
        position += n;
        const chunk = Buffer.concat([carry, buffer.subarray(0, n)]);
        // Cut after the last line feed, so records are whole lines where they can be.
        const cut = Math.max(chunk.lastIndexOf(0x0a), chunk.lastIndexOf(0x0b), chunk.lastIndexOf(0x0c));
        if (cut === -1) {
          carry = chunk;
        } else {
          emit(chunk.subarray(0, cut + 1));
          carry = Buffer.from(chunk.subarray(cut + 1));
        }
      }
      emit(carry);
    } finally {
      fs.closeSync(fd);
    }
  });
  fs.rmSync(file + LEGACY_TIMES_SUFFIX, { force: true });
  fs.rmSync(file + LEGACY_OPEN_SUFFIX, { force: true });
}
