import * as fs from "node:fs";
import * as path from "node:path";
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

function countNewlines(data: string | Uint8Array): number {
  let count = 0;
  if (typeof data === "string") {
    for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) === 0x0a) count++;
  } else {
    for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) count++;
  }
  return count;
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
// the sidecar. A line with no recorded time — an older log written before the
// sidecar existed, or a torn final write — comes back as null, left-padded so
// the result always has exactly `lineCount` entries, aligned to the log tail
// (whose newlines are, by definition, the file's last `lineCount` newlines).
export function readTimesTail(file: string, lineCount: number): Array<number | null> {
  if (lineCount <= 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return new Array(lineCount).fill(null);
  }
  try {
    const available = Math.floor(fs.fstatSync(fd).size / TIME_BYTES);
    const take = Math.min(lineCount, available);
    const buffer = Buffer.alloc(take * TIME_BYTES);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, (available - take) * TIME_BYTES + read);
      if (n === 0) break;
      read += n;
    }
    const got = Math.floor(read / TIME_BYTES);
    const times: Array<number | null> = new Array(lineCount - got).fill(null);
    for (let i = 0; i < got; i++) {
      // NaN marks a line that carries no timestamp (e.g. Moolin's own status
      // lines); it still gets an entry so the file stays aligned to newlines.
      const value = buffer.readDoubleLE(i * TIME_BYTES);
      times.push(Number.isNaN(value) ? null : value);
    }
    return times;
  } finally {
    fs.closeSync(fd);
  }
}

// A log's recent bytes plus the matching per-line arrival times; the times
// align one-to-one with the newlines in `bytes` (see readTimesTail).
export interface LogHistory {
  bytes: Uint8Array;
  times: Array<number | null>;
}

// An open, append-only log file that one window owns.
export class SessionLog {
  private stream: fs.WriteStream | null = null;
  private timesStream: fs.WriteStream | null = null;
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
    const times = readTimesTail(timesFileFor(this.file), countNewlines(bytes));
    return { bytes, times };
  }

  // Appends exactly what the terminal was shown, escape sequences included,
  // and records `time` (epoch ms, or null for a line with no timestamp) in the
  // sidecar for each line it completes.
  append(data: string | Uint8Array, time: number | null): void {
    if (this.closed) return;
    if (!this.stream) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      } catch (error) {
        this.fail(error as Error);
        return;
      }
      this.stream = fs.createWriteStream(this.file, { flags: "a" });
      this.stream.on("error", (error) => this.fail(error));
      this.timesStream = fs.createWriteStream(timesFileFor(this.file), { flags: "a" });
      this.timesStream.on("error", (error) => this.fail(error));
    }
    this.stream.write(data);
    const newlines = countNewlines(data);
    if (newlines > 0 && this.timesStream) {
      const buffer = Buffer.alloc(newlines * TIME_BYTES);
      // null → NaN on disk, read back as null (see readTimesTail).
      for (let i = 0; i < newlines; i++) buffer.writeDoubleLE(time ?? Number.NaN, i * TIME_BYTES);
      this.timesStream.write(buffer);
    }
  }

  // Flushes and gives up ownership, letting another window claim the file.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.end();
    this.stream = null;
    this.timesStream?.end();
    this.timesStream = null;
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
