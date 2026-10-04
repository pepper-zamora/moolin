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

// Present while a window has the log open for writing, holding the sizes of
// the log and sidecar when it was opened. Removed on a clean close, so one
// found on opening means the app died with the log open, and says where that
// session's output starts (see recoverFromCrash).
export const OPEN_FILE_SUFFIX = ".open";

function timesFileFor(logFile: string): string {
  return logFile + TIMES_FILE_SUFFIX;
}

function openFileFor(logFile: string): string {
  return logFile + OPEN_FILE_SUFFIX;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
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

// The start of a log folder's name that identifies its world or character:
// up to 8 characters of its id, then a dot (as Firefox prefixes profile
// folders). It keeps folders apart when names differ only in case (one
// folder on Windows and macOS) or are the same, and lets a renamed world or
// character find its folder again.
function idPrefix(id: string): string {
  return `${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "_"}.`;
}

function folderName(id: string, label: string): string {
  return idPrefix(id) + sanitizePathSegment(label);
}

// <root>/<id>.<world>/<id>.<character>/moolin.log, or
// <root>/<id>.<world>/moolin.log when connecting without a character.
export function logPathFor(root: string, world: World, character: Character | null): string {
  const segments = [folderName(world.id, worldLabel(world))];
  if (character) segments.push(folderName(character.id, characterLabel(character)));
  return path.join(root, ...segments, LOG_FILE_NAME);
}

// Picks the folder in `dir` for one world or character, renaming an existing
// one to match: a folder with its id prefix under an old name (it was renamed
// since), or failing that a folder named just its label (from before folders
// had id prefixes). If the rename fails the existing folder is used as it is.
function locateFolder(dir: string, id: string, label: string): string {
  const wanted = folderName(id, label);
  let folders: string[];
  try {
    folders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return wanted; // `dir` doesn't exist yet
  }
  const prefix = idPrefix(id);
  const existing =
    folders.find((name) => name.startsWith(prefix)) ?? folders.find((name) => name === sanitizePathSegment(label));
  if (existing === undefined || existing === wanted) return wanted;
  try {
    fs.renameSync(path.join(dir, existing), path.join(dir, wanted));
    return wanted;
  } catch {
    return existing;
  }
}

// Like logPathFor, but finds (and renames to match) the folders the log is
// already in, if any (see locateFolder).
export function locateLogFile(root: string, world: World, character: Character | null): string {
  let dir = path.join(root, locateFolder(root, world.id, worldLabel(world)));
  if (character) dir = path.join(dir, locateFolder(dir, character.id, characterLabel(character)));
  return path.join(dir, LOG_FILE_NAME);
}

// What claims a world/character's log: by id, so a rename (which moves the
// folder) can't let two windows write the same files.
export function logKeyFor(world: World, character: Character | null): string {
  return character ? `${world.id}/${character.id}` : world.id;
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

function nanRecords(count: number): Buffer {
  const buffer = Buffer.alloc(count * TIME_BYTES);
  for (let i = 0; i < count; i++) buffer.writeDoubleLE(Number.NaN, i * TIME_BYTES);
  return buffer;
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
  fs.appendFileSync(file, nanRecords(1));
}

// The line feeds in `file` from byte `start` on, read a piece at a time.
function countLineFeedsFrom(file: string, start: number): number {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count = 0;
    for (let position = start; ; ) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (n === 0) return count;
      count += countLineFeeds(buffer.subarray(0, n));
      position += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// After a crash, the log and sidecar can disagree about the last session:
// the app may have died between writing some output and recording its
// times, or part-way through either. The open-file marker says how big both
// were when that session began, so the sidecar should now hold one record
// for each line feed the log gained since. Missing records are added as
// unknown (NaN) and extra ones dropped, at the end, where the damage is;
// older lines (including any logged before the sidecar existed, which have
// no records) keep theirs. Only that session's output is scanned, not the
// whole log. Returns false if the marker can't be read.
function recoverFromCrash(logFile: string): boolean {
  let start: { log: number; times: number };
  try {
    start = JSON.parse(fs.readFileSync(openFileFor(logFile), "utf8"));
  } catch {
    return false;
  }
  if (!Number.isInteger(start?.log) || !Number.isInteger(start?.times)) return false;
  const timesFile = timesFileFor(logFile);
  const logSize = fileSize(logFile);
  const lineFeeds = logSize > start.log ? countLineFeedsFrom(logFile, start.log) : 0;
  const expected = Math.floor(start.times / TIME_BYTES) + lineFeeds;
  const records = Math.floor(fileSize(timesFile) / TIME_BYTES);
  if (records >= expected) {
    fs.truncateSync(timesFile, expected * TIME_BYTES);
  } else {
    fs.truncateSync(timesFile, records * TIME_BYTES); // also drops a torn record
    fs.appendFileSync(timesFile, nanRecords(expected - records));
  }
  return true;
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
  // Whether the files have been checked for damage from a crash (see prepare).
  private prepared = false;

  constructor(
    readonly file: string,
    private readonly release: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  // What the log already holds, plus each line's arrival time, for
  // pre-populating the scrollback. Call before the first append.
  history(maxBytes: number): LogHistory {
    try {
      this.prepare();
    } catch (error) {
      this.fail(error as Error);
    }
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
        this.prepare();
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.fd = fs.openSync(this.file, "a");
        this.timesFd = fs.openSync(timesFileFor(this.file), "a");
        const sizes = { log: fs.fstatSync(this.fd).size, times: fs.fstatSync(this.timesFd).size };
        fs.writeFileSync(openFileFor(this.file), JSON.stringify(sizes));
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
    const wasOpen = this.fd !== null;
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
    // Everything is on disk, so the next open needn't check for a crash.
    if (wasOpen) {
      try {
        fs.rmSync(openFileFor(this.file), { force: true });
      } catch {
        // Left behind, the next open just rechecks this session's output.
      }
    }
    this.release();
  }

  // False once closed, including after a disk error stopped logging.
  get isOpen(): boolean {
    return !this.closed;
  }

  // Before the log is first read or appended to, repairs whatever a crash
  // left behind: realigns the sidecar to the log if the last session didn't
  // close cleanly, and otherwise mends a torn final record.
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    if (!recoverFromCrash(this.file)) repairTimesFile(timesFileFor(this.file));
    fs.rmSync(openFileFor(this.file), { force: true });
  }

  // Logging is best-effort: a disk problem is reported once and logging
  // stops, rather than taking the connection down with it.
  private fail(error: Error): void {
    this.onError(error);
    this.close();
  }
}

// Hands out each log to at most one window at a time. Several windows can be
// connected to the same world and character; only the first to claim the
// log reads and writes it, so output isn't logged once per window.
export class SessionLogRegistry {
  private readonly owned = new Set<string>();

  constructor(private readonly onError: (file: string, error: Error) => void = () => {}) {}

  // The log identified by `key` (see logKeyFor), or null if another window
  // already owns it. `locate` finds its file, and is only called once the
  // claim succeeds, since it may rename folders the owner is writing in.
  claim(key: string, locate: () => string): SessionLog | null {
    if (this.owned.has(key)) return null;
    this.owned.add(key);
    let file: string;
    try {
      file = locate();
    } catch (error) {
      this.owned.delete(key);
      throw error;
    }
    return new SessionLog(
      file,
      () => this.owned.delete(key),
      (error) => this.onError(file, error),
    );
  }
}

// The log one window writes to. A window claims its target's log as it
// connects and releases it when the connection ends (or the window closes),
// so another window can then take it over. A window that finds the log
// already taken shows no history and logs nothing.
export class WindowLog {
  private log: SessionLog | null = null;

  constructor(
    private readonly registry: SessionLogRegistry,
    private readonly root: string,
  ) {}

  // Releases any log held, then claims `world`/`character`'s. Returns up to
  // `maxBytes` of its history to show, or nothing if another window has it.
  open(world: World, character: Character | null, maxBytes: number): LogHistory {
    this.release();
    this.log = this.registry.claim(logKeyFor(world, character), () => locateLogFile(this.root, world, character));
    return this.log ? this.log.history(maxBytes) : { bytes: new Uint8Array(), times: [] };
  }

  // Whether this window holds a log (and so is writing to it).
  get owned(): boolean {
    return this.log?.isOpen ?? false;
  }

  // The file of the log held, for diagnostics.
  get file(): string | null {
    return this.log?.file ?? null;
  }

  append(data: string | Uint8Array, time: number | null): void {
    this.log?.append(data, time);
  }

  release(): void {
    this.log?.close();
    this.log = null;
  }
}
