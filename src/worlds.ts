import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Character, ConversationPattern, GlobalSettings, MruEntry, TriState, World } from "./worlds-types";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_LOGIN_TEMPLATE, isValidPort } from "./world-utils";
import { log } from "./logger";
import { type KeyEnvelope, keyIdOf, open, parseEnvelope, seal } from "./crypto-keys";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./file-modes";

const DEFAULT_WORLDS_PATH = path.join("~", "Documents", "Moolin", "worlds");

export interface WorldsState {
  worlds: World[];
  mru: MruEntry[];
  globalSettings: GlobalSettings;
}

// `error` is set when the file exists but couldn't be read or parsed, and
// neither could its backup. The state is then empty, and writes are refused
// so the user's file (which may just have a typo from hand-editing) isn't
// overwritten.
//
// If the backup could be read instead, `state` is the backup's and
// `recovered` names the unreadable file. Writes are then allowed: the first
// one moves the unreadable file aside rather than overwriting it.
//
// A file with an `encryption` block holds its passwords sealed (each character's
// `passwordEncrypted` stands in for `password`). `encryption` carries that block
// when there is one. Read without the data key such a file is `locked`: its
// characters have empty passwords, and it can't be written (that would lose them).
export interface WorldsReadResult {
  state: WorldsState;
  error?: string;
  recovered?: { file: string; error: string };
  encryption?: KeyEnvelope;
  locked?: boolean;
}

// Binds a sealed password to its character, so passwords can't be swapped
// between characters in an edited file.
function passwordAad(characterId: string): Buffer {
  return Buffer.from(`moolin password v1 ${characterId}`);
}

// Turns each character's `passwordEncrypted` back into `password` in a record
// read from an encrypted file. Without the key the passwords are left empty.
// Returns an error message if one doesn't open with the key.
function unsealPasswords(rawWorlds: unknown[], dataKey: Buffer | null): string | null {
  for (const rawWorld of rawWorlds) {
    if (!isObject(rawWorld) || !Array.isArray(rawWorld.characters)) continue;
    for (const rawCharacter of rawWorld.characters) {
      if (!isObject(rawCharacter)) continue;
      const sealed = rawCharacter.passwordEncrypted;
      delete rawCharacter.passwordEncrypted;
      if (!dataKey) {
        rawCharacter.password = "";
        continue;
      }
      if (sealed === undefined) continue; // a password typed into the file by hand
      try {
        if (!isString(sealed) || !isString(rawCharacter.id)) throw new Error("not text");
        rawCharacter.password = open(dataKey, Buffer.from(sealed, "base64"), passwordAad(rawCharacter.id)).toString(
          "utf8",
        );
      } catch {
        return "a password in it could not be decrypted with the key (the file may have been altered)";
      }
    }
  }
  return null;
}

// The worlds as written to disk: with a key, each password sealed.
function sealPasswords(worlds: World[], dataKey: Buffer | null): unknown[] {
  if (!dataKey) return worlds;
  return worlds.map((world) => ({
    ...world,
    characters: world.characters.map(({ password, ...character }) => ({
      ...character,
      passwordEncrypted: seal(dataKey, Buffer.from(password, "utf8"), passwordAad(character.id)).toString("base64"),
    })),
  }));
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
const isTriState = (v: unknown): v is TriState => v === "inherit" || v === "on" || v === "off";

function parseCharacter(value: unknown): Character | null {
  if (!isObject(value) || !isString(value.id) || value.id.length === 0) return null;
  const name = optional(value.name, isString, "");
  const password = optional(value.password, isString, "");
  const echoCommands = optional(value.echoCommands, isTriState, "inherit");
  const wordWrap = optional(value.wordWrap, isTriState, "inherit");
  const honorClear = optional(value.honorClear, isTriState, "inherit");
  if (
    name === undefined ||
    password === undefined ||
    echoCommands === undefined ||
    wordWrap === undefined ||
    honorClear === undefined
  ) {
    return null;
  }
  return { id: value.id, name, password, echoCommands, wordWrap, honorClear };
}

function parseConversationPattern(value: unknown): ConversationPattern | null {
  if (!isObject(value) || !isString(value.template)) return null;
  if (value.from !== "us" && value.from !== "them") return null;
  if (value.kind !== "say" && value.kind !== "emote") return null;
  return { template: value.template, from: value.from, kind: value.kind };
}

// Pre-tri-state worlds stored echoCommands as a plain boolean; map it
// directly onto the matching tri-state value so an old file keeps behaving
// the same way until someone deliberately changes it in the dialog.
function migrateEchoCommands(value: unknown): TriState | undefined {
  if (typeof value === "boolean") return value ? "on" : "off";
  return optional(value, isTriState, "inherit");
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
  const echoCommands = migrateEchoCommands(value.echoCommands);
  const wordWrap = optional(value.wordWrap, isTriState, "inherit");
  const honorClear = optional(value.honorClear, isTriState, "inherit");
  const rawPatterns = value.conversationPatterns === undefined ? [] : value.conversationPatterns;
  const rawCharacters = value.characters === undefined ? [] : value.characters;
  if (
    name === undefined ||
    host === undefined ||
    tls === undefined ||
    tlsAllowUntrusted === undefined ||
    autoLogin === undefined ||
    loginTemplate === undefined ||
    echoCommands === undefined ||
    wordWrap === undefined ||
    honorClear === undefined ||
    !Array.isArray(rawPatterns) ||
    !Array.isArray(rawCharacters)
  ) {
    return null;
  }

  const conversationPatterns: ConversationPattern[] = [];
  for (const raw of rawPatterns) {
    const pattern = parseConversationPattern(raw);
    if (pattern) conversationPatterns.push(pattern);
    else log("warn", "worlds", "dropping malformed conversation pattern from world", value.id);
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
    wordWrap,
    honorClear,
    conversationPatterns,
    characters,
  };
}

// Global has nothing above it to fall the *whole* record back to (unlike a
// World/Character, which can simply be dropped if malformed), so a corrupted
// field reverts to its own default individually instead of rejecting the rest.
export function parseGlobalSettings(value: unknown): GlobalSettings {
  const obj = isObject(value) ? value : {};
  return {
    wordWrap: optional(obj.wordWrap, isBoolean, DEFAULT_GLOBAL_SETTINGS.wordWrap) ?? DEFAULT_GLOBAL_SETTINGS.wordWrap,
    echoCommands:
      optional(obj.echoCommands, isBoolean, DEFAULT_GLOBAL_SETTINGS.echoCommands) ??
      DEFAULT_GLOBAL_SETTINGS.echoCommands,
    honorClear:
      optional(obj.honorClear, isBoolean, DEFAULT_GLOBAL_SETTINGS.honorClear) ?? DEFAULT_GLOBAL_SETTINGS.honorClear,
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
export function readWorldsFile(filePath: string, dataKey: Buffer | null = null): WorldsReadResult {
  const result = readStateFile(filePath, dataKey);
  if (!result.error) return withoutMissing(result);
  const backup = readStateFile(backupPathFor(filePath), dataKey);
  if (backup.error || backup.missing) return { state: result.state, error: result.error };
  log("warn", "worlds", result.error, "- using the backup");
  return { ...withoutMissing(backup), recovered: { file: filePath, error: result.error } };
}

function withoutMissing(result: WorldsReadResult & { missing?: boolean }): WorldsReadResult {
  const { missing: _missing, ...rest } = result;
  return rest;
}

// A first-ever launch (no worlds file yet) starts with LambdaMOO and its
// Guest character already set up, rather than an empty Worlds dialog with
// nothing to click. Called once at startup (see main.ts), before anything
// else reads the file, so the ids it hands out are the only ones ever
// written — not re-rolled on every read of a file that still doesn't exist.
export function seedDefaultWorlds(): World[] {
  return [
    {
      id: crypto.randomUUID(),
      name: "LambdaMOO",
      host: "lambda.moo.mud.org",
      port: 8888,
      tls: false,
      tlsAllowUntrusted: false,
      autoLogin: true,
      loginTemplate: DEFAULT_LOGIN_TEMPLATE,
      echoCommands: "inherit",
      wordWrap: "inherit",
      honorClear: "inherit",
      conversationPatterns: [],
      characters: [
        {
          id: crypto.randomUUID(),
          name: "Guest",
          password: "guest",
          echoCommands: "inherit",
          wordWrap: "inherit",
          honorClear: "inherit",
        },
      ],
    },
  ];
}

function readStateFile(filePath: string, dataKey: Buffer | null): WorldsReadResult & { missing?: boolean } {
  const empty = (): WorldsState => ({ worlds: [], mru: [], globalSettings: DEFAULT_GLOBAL_SETTINGS });
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

  let encryption: KeyEnvelope | undefined;
  if (parsed.encryption !== undefined) {
    const envelope = parseEnvelope(parsed.encryption);
    if (!envelope) return { state: empty(), error: `Could not read ${filePath}: its "encryption" block is damaged` };
    encryption = envelope;
    if (dataKey && keyIdOf(dataKey) !== envelope.keyId) {
      return { state: empty(), error: `Could not read ${filePath}: it was encrypted with a different key` };
    }
    const problem = unsealPasswords(parsed.worlds, dataKey);
    if (problem) return { state: empty(), error: `Could not read ${filePath}: ${problem}` };
  }

  const worlds: World[] = [];
  for (const rawWorld of parsed.worlds) {
    const world = parseWorld(rawWorld);
    if (world) worlds.push(world);
    else log("warn", "worlds", "dropping malformed world entry from", filePath, ":", JSON.stringify(rawWorld));
  }
  const rawMru: unknown[] = Array.isArray(parsed.mru) ? parsed.mru : [];
  const mru = rawMru.map(parseMruEntry).filter((entry): entry is MruEntry => entry !== null);
  const globalSettings = parseGlobalSettings(parsed.globalSettings);
  const state = { worlds, mru, globalSettings };
  return encryption ? { state, encryption, locked: !dataKey } : { state };
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
//
// `encryption` is what the file is written with: null for a plain file, or the
// envelope and data key that seal its passwords.
function writeState(filePath: string, state: WorldsState, read: WorldsReadResult, encryption: Encryption | null): void {
  const body = {
    ...(encryption ? { encryption: encryption.envelope } : {}),
    worlds: sealPasswords(state.worlds, encryption?.dataKey ?? null),
    mru: state.mru,
    globalSettings: state.globalSettings,
  };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  // It becomes the worlds file, passwords and all, when renamed into place.
  fs.writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  if (read.recovered) {
    const aside = unreadablePathFor(filePath, new Date());
    fs.renameSync(filePath, aside);
    log("warn", "worlds", "moved unreadable", filePath, "to", aside);
  } else if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPathFor(filePath));
      fs.chmodSync(backupPathFor(filePath), PRIVATE_FILE_MODE); // a copy keeps an older backup's mode
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

// How a file is encrypted: the envelope that goes in it, and the data key that
// seals its passwords.
export interface Encryption {
  envelope: KeyEnvelope;
  dataKey: Buffer;
}

// What an existing file is written back with: nothing if it is plain, or its
// own envelope and the key that read it.
function sameEncryption(read: WorldsReadResult, dataKey: Buffer | null): Encryption | null {
  return read.encryption && dataKey ? { envelope: read.encryption, dataKey } : null;
}

const LOCKED = "The worlds file is encrypted and locked; unlock it to change it";

// Throws if the existing file couldn't be read, rather than replace it, or is
// encrypted and wasn't given its data key (its passwords would be lost).
export function saveWorlds(
  filePath: string,
  worlds: World[],
  globalSettings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS,
  dataKey: Buffer | null = null,
): void {
  const read = readWorldsFile(filePath, dataKey);
  if (read.error) throw new Error(read.error);
  if (read.locked) throw new Error(LOCKED);
  writeState(filePath, { ...read.state, worlds, globalSettings }, read, sameEncryption(read, dataKey));
}

// Rewrites the file to be encrypted with `next` (a new envelope and data key),
// or plain (null): turning encryption on or off, or changing the phrase or
// file, which re-wraps the same data key. `dataKey` opens the file as it is
// now. Throws if the file can't be read or is locked.
//
// The backup is refreshed to match: the usual one holds the previous version,
// which for turning encryption on would keep every password in plain text.
export function changeEncryption(filePath: string, dataKey: Buffer | null, next: Encryption | null): void {
  const read = readWorldsFile(filePath, dataKey);
  if (read.error) throw new Error(read.error);
  if (read.locked) throw new Error(LOCKED);
  writeState(filePath, read.state, read, next);
  try {
    fs.copyFileSync(filePath, backupPathFor(filePath));
    fs.chmodSync(backupPathFor(filePath), PRIVATE_FILE_MODE);
  } catch (err) {
    log("warn", "worlds", "could not refresh the backup of", filePath, ":", (err as Error).message);
  }
}

// Returns the new MRU list, or null if the file couldn't be read (in which
// case it is left alone) or written. Never throws: it runs as a connection
// is made, where a failure to record it mustn't stop the connection.
export function updateMru(
  filePath: string,
  updater: (mru: MruEntry[]) => MruEntry[],
  dataKey: Buffer | null = null,
): MruEntry[] | null {
  const read = readWorldsFile(filePath, dataKey);
  if (read.error || read.locked) {
    log("warn", "worlds", "not updating MRU:", read.error ?? LOCKED);
    return null;
  }
  const mru = updater(read.state.mru);
  try {
    writeState(filePath, { ...read.state, mru }, read, sameEncryption(read, dataKey));
  } catch (err) {
    log("error", "worlds", "could not update MRU in", filePath, ":", (err as Error).message);
    return null;
  }
  return mru;
}
