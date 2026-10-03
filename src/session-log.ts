import * as fs from "node:fs";
import * as path from "node:path";
import { countLineFeeds } from "./line-feeds";
import type { Character, World } from "./worlds-types";
import { characterLabel, worldLabel } from "./world-utils";

export const LOG_FILE_NAME = "moolin.log";

// Sidecar beside the log: one little-endian float64 (epoch ms) per logged
// line, in order, so each line's arrival time can be restored on reconnect.
// The log itself stays a plain byte stream with nothing extra embedded.
export const TIMES_FILE_SUFFIX = ".times";
const TIME_BYTES = 8;

function timesFileFor(logFile: string): string {
  return logFile + TIMES_FILE_SUFFIX;
}

// Makes a world or character name safe to use as one directory name: path
// separators and characters Windows forbids become "_", and a name that would
// be empty, "." or ".." (or start with a dot, i.e. hidden) gets a "_" prefix.
export function sanitizePathSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (cleaned === "") return "_";
  return cleaned.startsWith(".") ? `_${cleaned}` : cleaned;
}

// <root>/<world>/<character>/moolin.log, or <root>/<world>/moolin.log when
// connecting without a character.
export function logPathFor(root: string, world: World, character: Character | null): string {
  const segments = [sanitizePathSegment(worldLabel(world))];
  if (character) segments.push(sanitizePathSegment(characterLabel(character)));
  return path.join(root, ...segments, LOG_FILE_NAME);
}

// The last `maxBytes` of the file as bytes, cut forward to a line boundary
// when the start had to be dropped (so it never begins mid-line, mid-escape
// or mid-UTF-8 sequence). Empty if the file is missing.
export function readLogTail(file: string, maxBytes: number): Uint8Array {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return new Uint8Array();
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const bytes = buffer.subarray(0, read);
    if (start === 0) return new Uint8Array(bytes);
    const newline = bytes.indexOf(0x0a);
    return new Uint8Array(newline === -1 ? [] : bytes.subarray(newline + 1));
  } finally {
    fs.closeSync(fd);
  }
}

// The arrival times of the last `lineCount` logged lines, in order, read from
// the sidecar. A line with no recorded time comes back as null: lines from
// before the sidecar existed are left-padded with null so the result always
// has exactly `lineCount` entries, aligned to the log tail (whose line feeds
// are, by definition, the file's last `lineCount` line feeds). A torn final
// record — the app died mid-write, leaving a size that isn't a whole number of
// records — still stands for its line, as a trailing null; records are counted
// from the start of the file, which repairTimesFile keeps valid on reopen.
export function readTimesTail(file: string, lineCount: number): Array<number | null> {
  if (lineCount <= 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return new Array(lineCount).fill(null);
  }
  try {
    const size = fs.fstatSync(fd).size;
    const available = Math.floor(size / TIME_BYTES);
    const torn = size % TIME_BYTES !== 0;
    const take = Math.min(lineCount - (torn ? 1 : 0), available);
    const buffer = Buffer.alloc(take * TIME_BYTES);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, (available - take) * TIME_BYTES + read);
      if (n === 0) break;
      read += n;
    }
    const got = Math.floor(read / TIME_BYTES);
    const times: Array<number | null> = new Array(lineCount - got - (torn ? 1 : 0)).fill(null);
    for (let i = 0; i < got; i++) {
      // NaN marks a line that carries no timestamp (e.g. Moolin's own status
      // lines); it still gets an entry so the file stays aligned to line feeds.
      const value = buffer.readDoubleLE(i * TIME_BYTES);
      times.push(Number.isNaN(value) ? null : value);
    }
    if (torn) times.push(null);
    return times;
  } finally {
    fs.closeSync(fd);
  }
}

// Makes a sidecar left with a torn final record (see readTimesTail) whole
// again before anything is appended to it: the partial record is replaced by
// a NaN (unknown time) one, so its line keeps an entry and every later record
// stays aligned to a multiple of TIME_BYTES. A missing file is left missing.
function repairTimesFile(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  const partial = size % TIME_BYTES;
  if (partial === 0) return;
  fs.truncateSync(file, size - partial);
  const record = Buffer.alloc(TIME_BYTES);
  record.writeDoubleLE(Number.NaN);
  fs.appendFileSync(file, record);
}

// A log's recent bytes plus the matching per-line arrival times; the times
// align one-to-one with the line feeds in `bytes` (see readTimesTail).
export interface LogHistory {
  bytes: Uint8Array;
  times: Array<number | null>;
}

// Writes all of `bytes` at the end of `fd`'s file (opened for append),
// looping in case the OS takes it in parts.
function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) written += fs.writeSync(fd, bytes, written);
}

// An open, append-only log file that one window owns.
//
// Writes are synchronous so the log and its sidecar always reach the disk
// together: a window that reads them straight after another's close() (e.g.
// reconnecting to the same world) sees the two at the same point, where
// buffered streams could each still be flushing to a different one. Output
// arrives at the pace people read, so blocking on it is cheap.
export class SessionLog {
  private fd: number | null = null;
  private timesFd: number | null = null;
  private closed = false;

  constructor(
    readonly file: string,
    private readonly release: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  // What the log already holds, plus each line's arrival time, for
  // pre-populating the scrollback. Call before the first append.
  history(maxBytes: number): LogHistory {
    const bytes = readLogTail(this.file, maxBytes);
    const times = readTimesTail(timesFileFor(this.file), countLineFeeds(bytes));
    return { bytes, times };
  }

  // Appends exactly what the terminal was shown, escape sequences included,
  // and records `time` (epoch ms, or null for a line with no timestamp) in the
  // sidecar for each line it completes.
  append(data: string | Uint8Array, time: number | null): void {
    if (this.closed) return;
    try {
      if (this.fd === null) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        repairTimesFile(timesFileFor(this.file));
        this.fd = fs.openSync(this.file, "a");
        this.timesFd = fs.openSync(timesFileFor(this.file), "a");
      }
      writeAll(this.fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      const lineFeeds = countLineFeeds(data);
      if (lineFeeds > 0 && this.timesFd !== null) {
        const buffer = Buffer.alloc(lineFeeds * TIME_BYTES);
        // null → NaN on disk, read back as null (see readTimesTail).
        for (let i = 0; i < lineFeeds; i++) buffer.writeDoubleLE(time ?? Number.NaN, i * TIME_BYTES);
        writeAll(this.timesFd, buffer);
      }
    } catch (error) {
      this.fail(error as Error);
    }
  }

  // Closes the files and gives up ownership, letting another window claim them.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of [this.fd, this.timesFd]) {
      if (fd === null) continue;
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing is buffered, so there is nothing left to lose.
      }
    }
    this.fd = null;
    this.timesFd = null;
    this.release();
  }

  // Logging is best-effort: a disk problem is reported once and logging
  // stops, rather than taking the connection down with it.
  private fail(error: Error): void {
    this.onError(error);
    this.close();
  }
}

// Hands out each log file to at most one window at a time. Several windows
// can be connected to the same world and character; only the first to claim
// the file reads and writes it, so output isn't logged once per window.
export class SessionLogRegistry {
  private readonly owned = new Set<string>();

  constructor(private readonly onError: (file: string, error: Error) => void = () => {}) {}

  // The log for `file`, or null if another window already owns it.
  claim(file: string): SessionLog | null {
    const key = path.resolve(file);
    if (this.owned.has(key)) return null;
    this.owned.add(key);
    return new SessionLog(
      file,
      () => this.owned.delete(key),
      (error) => this.onError(file, error),
    );
  }
}
