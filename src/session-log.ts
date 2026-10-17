import * as fs from "node:fs";
import * as path from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./file-modes";
import { countLineFeeds } from "./line-feeds";
import { LineDeduper } from "./line-dedupe";
import { PLAIN, convertLog, encodeRecord, prepareForAppend, readLogHistory } from "./log-format";
import type { LogHistory, LogMode } from "./log-format";
import type { Character, World } from "./worlds-types";
import { characterLabel, worldLabel } from "./world-utils";

export type { LogHistory, LogMode } from "./log-format";

export const LOG_FILE_NAME = "moolin.log";

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
// since). If the rename fails the existing folder is used as it is.
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
  const existing = folders.find((name) => name.startsWith(prefix));
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

// What identifies a world/character's log: by id, so a rename (which moves the
// folder) can't give the same log two keys.
export function logKeyFor(world: World, character: Character | null): string {
  return character ? `${world.id}/${character.id}` : world.id;
}

// Writes all of `bytes` at the end of `fd`'s file (opened for append),
// looping in case the OS takes it in parts.
function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) written += fs.writeSync(fd, bytes, written);
}

// Opens a file for appending, readable by its owner alone.
function openPrivate(file: string): number {
  const fd = fs.openSync(file, "a", PRIVATE_FILE_MODE);
  try {
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch {
    // Not supported everywhere (Windows); the mode above is all there is.
  }
  return fd;
}

// An open, append-only log file, shared by the windows connected to its
// character (see SessionLogRegistry), in the format described
// in log-format.ts: plain, or sealed with the data key, whichever `mode` says.
//
// Writes are synchronous so a window that reads the log straight after
// another's close() (e.g. reconnecting to the same world) sees everything
// written. Output arrives at the pace people read, so blocking on it is cheap.
export class SessionLog {
  private fd: number | null = null;
  private closed = false;
  // Whether the file has been brought to this log's mode and mended after a
  // crash (see prepare).
  private prepared = false;
  // The file's header and the next record's number, known once prepared.
  private header = "";
  private nextSeq = 0;

  constructor(
    readonly file: string,
    private readonly mode: LogMode,
    private readonly release: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  // What the log already holds, plus each line's arrival time, for
  // pre-populating the scrollback. Call before the first append. Empty if the
  // log can't be read, which is reported and stops logging.
  history(maxBytes: number): LogHistory {
    try {
      this.prepare();
      return readLogHistory(this.file, this.mode, maxBytes);
    } catch (error) {
      this.fail(error as Error);
      return { bytes: new Uint8Array(), times: [] };
    }
  }

  // Appends exactly what the terminal was shown, escape sequences included
  // (written as base64, so they never reach a terminal that shows the file),
  // with `time` (epoch ms, or null for a line with no timestamp) for each line
  // feed in it.
  append(data: string | Uint8Array, time: number | null): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (bytes.length === 0) return;
    try {
      if (this.fd === null) {
        this.prepare();
        this.fd = openPrivate(this.file);
      }
      const times = new Array<number | null>(countLineFeeds(bytes)).fill(time);
      writeAll(this.fd, Buffer.from(encodeRecord(this.mode, this.header, this.nextSeq, bytes, times), "latin1"));
      this.nextSeq++;
    } catch (error) {
      this.fail(error as Error);
    }
  }

  // Closes the file, and tells the registry it is no longer open.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Nothing is buffered, so there is nothing left to lose.
      }
    }
    this.fd = null;
    this.release();
  }

  // False once closed, including after a disk error stopped logging.
  get isOpen(): boolean {
    return !this.closed;
  }

  // Before the log is first read or appended to: creates its folder, brings a
  // log in the other mode to this mode, and cuts off a last line a crash left
  // unfinished.
  private prepare(): void {
    if (this.prepared) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: PRIVATE_DIR_MODE });
    convertLog(this.file, this.mode, this.mode.kind === "encrypted" ? this.mode.dataKey : null);
    ({ header: this.header, nextSeq: this.nextSeq } = prepareForAppend(this.file, this.mode));
    this.prepared = true;
  }

  // Logging is best-effort: a disk problem is reported once and logging
  // stops, rather than taking the connection down with it.
  private fail(error: Error): void {
    this.onError(error);
    this.close();
  }
}

// A log's file with the windows writing it. Windows connected to the same
// world and character share one, so the character has one history; the lines
// each window receives are written once (see LineDeduper).
class SharedLog {
  readonly dedupe = new LineDeduper();
  // How many windows are attached.
  users = 0;

  constructor(readonly log: SessionLog) {}
}

// What a window holds of a shared log, from attaching to it until `close`.
export class LogAttachment {
  private closed = false;

  constructor(
    private readonly shared: SharedLog,
    private readonly clock: () => number,
  ) {
    shared.users++;
  }

  get file(): string {
    return this.shared.log.file;
  }

  // False once closed, and once the log has stopped on a disk error.
  get isOpen(): boolean {
    return !this.closed && this.shared.log.isOpen;
  }

  history(maxBytes: number): LogHistory {
    return this.shared.log.history(maxBytes);
  }

  // Appends what the window was shown. With another window attached, only the
  // lines that window hasn't already written are, and the unfinished end of the
  // output waits for its line feed. A line with no time is Moolin's own, so it
  // is written as it is, after whatever the window was waiting to write.
  append(data: string | Uint8Array, time: number | null): void {
    if (!this.isOpen) return;
    const { log, dedupe, users } = this.shared;
    if (users < 2) {
      log.append(data, time);
      return;
    }
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (time === null) {
      log.append(dedupe.flush(this), this.clock());
      log.append(bytes, null);
    } else {
      log.append(dedupe.push(this, bytes, this.clock()), time);
    }
  }

  // Stops writing. The last window to leave closes the file; one leaving with
  // a single window left writes what both were holding, since there is nothing
  // left to match it against.
  close(): void {
    if (this.closed) return;
    const wasOpen = this.isOpen;
    this.closed = true;
    const { log, dedupe } = this.shared;
    if (wasOpen && this.shared.users >= 2) {
      log.append(dedupe.leave(this), this.clock());
      if (this.shared.users === 2) log.append(dedupe.flushAll(), this.clock());
    }
    if (--this.shared.users === 0) log.close();
  }
}

// Hands out each world/character's log, which every window connected to it
// attaches to; the file is closed when the last one leaves. Windows can't
// write a file at the same time, and the lines every connection of a character
// receives would be logged once per window, so the windows share one log and
// the copies of a line are dropped on the way in.
export class SessionLogRegistry {
  private readonly open = new Map<string, SharedLog>();
  private paused = false;

  // `modeNow` says how logs are written right now: plain, or encrypted with a
  // key, or null while the key is not available (then no log can be opened).
  constructor(
    private readonly onError: (file: string, error: Error) => void = () => {},
    private readonly modeNow: () => LogMode | null = () => PLAIN,
    private readonly clock: () => number = Date.now,
  ) {}

  // Whether any log is open, which stops the logs being converted.
  anyOpen(): boolean {
    return this.open.size > 0;
  }

  // While logs are being converted or the way they are written is changing, no
  // window may attach to one (it would read or write a file mid-conversion, or in
  // the mode being left). Refuses while one is open. Always `resume` after.
  pause(): boolean {
    if (this.open.size > 0) return false;
    this.paused = true;
    return true;
  }

  resume(): void {
    this.paused = false;
  }

  // The log identified by `key` (see logKeyFor), opened if no window has it
  // open. `locate` finds its file, and is only called when it is opened, since
  // it may rename folders a window already attached would be writing in.
  attach(key: string, locate: () => string): LogAttachment {
    let shared = this.open.get(key);
    if (!shared) {
      if (this.paused) throw new Error("Moolin is changing its encryption settings: try again in a moment");
      const mode = this.modeNow();
      if (!mode) throw new Error("the logs are locked: unlock Moolin to log");
      const file = locate();
      const log: SessionLog = new SessionLog(
        file,
        mode,
        () => {
          if (this.open.get(key)?.log === log) this.open.delete(key);
        },
        (error) => this.onError(file, error),
      );
      shared = new SharedLog(log);
      this.open.set(key, shared);
    }
    return new LogAttachment(shared, this.clock);
  }
}

// The log one window writes to. A window attaches to its target's log as it
// connects and lets go of it when the connection ends (or the window closes).
export class WindowLog {
  private log: LogAttachment | null = null;

  constructor(
    private readonly registry: SessionLogRegistry,
    private readonly root: string,
  ) {}

  // Lets go of any log held, then attaches to `world`/`character`'s. Returns up
  // to `maxBytes` of its history to show.
  open(world: World, character: Character | null, maxBytes: number): LogHistory {
    this.release();
    this.log = this.registry.attach(logKeyFor(world, character), () => locateLogFile(this.root, world, character));
    return this.log.history(maxBytes);
  }

  // Whether this window is writing a log.
  get logging(): boolean {
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
