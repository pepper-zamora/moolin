import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Character, MruEntry, World } from "./worlds-types";
import { DEFAULT_LOGIN_TEMPLATE, isValidPort } from "./world-utils";
import { log } from "./logger";

const DEFAULT_WORLDS_PATH = path.join("~", "Documents", "Moolin", "worlds");

export interface WorldsState {
  worlds: World[];
  mru: MruEntry[];
}

// `error` is set when the file exists but couldn't be read or parsed, and
// neither could its backup. The state is then empty, and writes are refused
// so the user's file (which may just have a typo from hand-editing) isn't
// overwritten.
//
// If the backup could be read instead, `state` is the backup's and
// `recovered` names the unreadable file. Writes are then allowed: the first
// one moves the unreadable file aside rather than overwriting it.
export interface WorldsReadResult {
  state: WorldsState;
  error?: string;
  recovered?: { file: string; error: string };
}

// The previous version of the worlds file, kept beside it by every write.
export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`;
}

export function resolveWorldsPath(cliArg: string | undefined): string {
  const raw = cliArg ?? DEFAULT_WORLDS_PATH;
  if (raw === "~" || raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw);
}

function optional<T>(value: unknown, isType: (v: unknown) => v is T, fallback: T): T | undefined {
  if (value === undefined) return fallback;
  return isType(value) ? value : undefined;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseCharacter(value: unknown): Character | null {
  if (!isObject(value) || !isString(value.id) || value.id.length === 0) return null;
  const name = optional(value.name, isString, "");
  const password = optional(value.password, isString, "");
  if (name === undefined || password === undefined) return null;
  return { id: value.id, name, password };
}

// Validates one world record from disk (or from a renderer) and fills in
// defaults for any fields missing since the file was written, so a field
// added in a later version doesn't break older files. Returns null for
// anything malformed, so a hand-edited or corrupted entry can't flow straight
// into net.connect(). An out-of-range port is cleared rather than rejected,
// since that's just an unfinished edit.
export function parseWorld(value: unknown): World | null {
  if (!isObject(value) || !isString(value.id) || value.id.length === 0) return null;
  const name = optional(value.name, isString, "");
  const host = optional(value.host, isString, "");
  const tls = optional(value.tls, isBoolean, false);
  const tlsAllowUntrusted = optional(value.tlsAllowUntrusted, isBoolean, false);
  const autoLogin = optional(value.autoLogin, isBoolean, false);
  const loginTemplate = optional(value.loginTemplate, isString, DEFAULT_LOGIN_TEMPLATE);
  const echoCommands = optional(value.echoCommands, isBoolean, true);
  const rawCharacters = value.characters === undefined ? [] : value.characters;
  if (
    name === undefined ||
    host === undefined ||
    tls === undefined ||
    tlsAllowUntrusted === undefined ||
    autoLogin === undefined ||
    loginTemplate === undefined ||
    echoCommands === undefined ||
    !Array.isArray(rawCharacters)
  ) {
    return null;
  }

  const characters: Character[] = [];
  for (const raw of rawCharacters) {
    const character = parseCharacter(raw);
    if (character) characters.push(character);
    else log("warn", "worlds", "dropping malformed character entry from world", value.id);
  }
  return {
    id: value.id,
    name,
    host,
    port: isValidPort(value.port) ? value.port : null,
    tls,
    tlsAllowUntrusted,
    autoLogin,
    loginTemplate,
    echoCommands,
    characters,
  };
}

function parseMruEntry(value: unknown): MruEntry | null {
  if (!isObject(value) || !isString(value.worldId)) return null;
  if (value.characterId !== undefined && !isString(value.characterId)) return null;
  return value.characterId === undefined
    ? { worldId: value.worldId }
    : { worldId: value.worldId, characterId: value.characterId };
}

// Reads the worlds file, falling back to its backup if the file exists but
// is unreadable (see WorldsReadResult). A missing file means no worlds; the
// backup isn't consulted then, so deleting the file starts afresh.
export function readWorldsFile(filePath: string): WorldsReadResult {
  const result = readStateFile(filePath);
  if (!result.error) return { state: result.state };
  const backup = readStateFile(backupPathFor(filePath));
  if (backup.error || backup.missing) return { state: result.state, error: result.error };
  log("warn", "worlds", result.error, "- using the backup");
  return { state: backup.state, recovered: { file: filePath, error: result.error } };
}

function readStateFile(filePath: string): WorldsReadResult & { missing?: boolean } {
  const empty = (): WorldsState => ({ worlds: [], mru: [] });
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: empty(), missing: true };
    return { state: empty(), error: `Could not read ${filePath}: ${(err as Error).message}` };
  }
  if (raw.length === 0) return { state: empty() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: empty(), error: `Could not parse ${filePath}: ${(err as Error).message}` };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.worlds)) {
    return { state: empty(), error: `Could not parse ${filePath}: missing "worlds" list` };
  }

  const worlds: World[] = [];
  for (const rawWorld of parsed.worlds) {
    const world = parseWorld(rawWorld);
    if (world) worlds.push(world);
    else log("warn", "worlds", "dropping malformed world entry from", filePath, ":", JSON.stringify(rawWorld));
  }
  const rawMru: unknown[] = Array.isArray(parsed.mru) ? parsed.mru : [];
  const mru = rawMru.map(parseMruEntry).filter((entry): entry is MruEntry => entry !== null);
  return { state: { worlds, mru } };
}

// "worlds.unreadable-20261004-153000", for setting an unreadable file aside.
function unreadablePathFor(filePath: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${filePath}.unreadable-${stamp}`;
}

// Write-temp-then-rename so a process killed mid-write can never leave a
// truncated/corrupt file behind for the next reader. The file being replaced
// is first copied to the backup (a copy, so there's never a moment with no
// worlds file), or, if it was unreadable (`read.recovered`), moved aside
// under a dated name so the backup it was recovered from stays intact.
function writeState(filePath: string, state: WorldsState, read: WorldsReadResult): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  if (read.recovered) {
    const aside = unreadablePathFor(filePath, new Date());
    fs.renameSync(filePath, aside);
    log("warn", "worlds", "moved unreadable", filePath, "to", aside);
  } else if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPathFor(filePath));
    } catch (err) {
      // A backup is a nicety; not having one mustn't stop the save.
      log("warn", "worlds", "could not back up", filePath, ":", (err as Error).message);
    }
  }
  fs.renameSync(tmpPath, filePath);
}

// The read-modify-write helpers below need no locking: one moolin process
// owns every window (see main.ts's single-instance lock), and these run
// synchronously in it, so no two can interleave.

// Throws if the existing file couldn't be read, rather than replace it.
export function saveWorlds(filePath: string, worlds: World[]): void {
  const read = readWorldsFile(filePath);
  if (read.error) throw new Error(read.error);
  writeState(filePath, { ...read.state, worlds }, read);
}

// Returns the new MRU list, or null if the file couldn't be read (in which
// case it is left alone) or written. Never throws: it runs as a connection
// is made, where a failure to record it mustn't stop the connection.
export function updateMru(filePath: string, updater: (mru: MruEntry[]) => MruEntry[]): MruEntry[] | null {
  const read = readWorldsFile(filePath);
  if (read.error) {
    log("warn", "worlds", "not updating MRU:", read.error);
    return null;
  }
  const mru = updater(read.state.mru);
  try {
    writeState(filePath, { ...read.state, mru }, read);
  } catch (err) {
    log("error", "worlds", "could not update MRU in", filePath, ":", (err as Error).message);
    return null;
  }
  return mru;
}
