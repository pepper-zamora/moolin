import * as fs from "fs";
import * as path from "path";
import type { Character, World } from "./worlds-types";
import { characterLabel, worldLabel } from "./world-utils";

export const LOG_FILE_NAME = "moolin.log";

// Makes a world or character name safe to use as one directory name: path
// separators and characters Windows forbids become "_", and a name that would
// be empty, "." or ".." (or start with a dot, i.e. hidden) gets a "_" prefix.
export function sanitizePathSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim().replace(/[. ]+$/, "");
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

// An open, append-only log file that one window owns.
export class SessionLog {
  private stream: fs.WriteStream | null = null;
  private closed = false;

  constructor(
    readonly file: string,
    private readonly release: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  // What the log already holds, for pre-populating the scrollback. Call
  // before the first append.
  history(maxBytes: number): Uint8Array {
    return readLogTail(this.file, maxBytes);
  }

  // Appends exactly what the terminal was shown, escape sequences included.
  append(data: string | Uint8Array): void {
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
    }
    this.stream.write(data);
  }

  // Flushes and gives up ownership, letting another window claim the file.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.end();
    this.stream = null;
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
