import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { World } from "./worlds-types";
import { log } from "./logger";

const DEFAULT_WORLDS_PATH = path.join("~", "Documents", "Moolin", "worlds");

export interface WorldsState {
  worlds: World[];
  mru: string[];
}

export function resolveWorldsPath(cliArg: string | undefined): string {
  const raw = cliArg ?? DEFAULT_WORLDS_PATH;
  if (raw === "~" || raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw);
}

// Guards against a hand-edited or corrupted worlds file feeding a malformed
// entry (missing host, non-numeric port, etc.) straight into net.connect().
function isValidWorld(value: unknown): value is World {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    w.id.length > 0 &&
    typeof w.name === "string" &&
    typeof w.host === "string" &&
    w.host.length > 0 &&
    typeof w.port === "number" &&
    Number.isInteger(w.port) &&
    w.port > 0 &&
    w.port <= 65535
  );
}

function readState(filePath: string): WorldsState {
  if (!fs.existsSync(filePath)) return { worlds: [], mru: [] };
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (raw.length === 0) return { worlds: [], mru: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WorldsState>;
    const rawWorlds = Array.isArray(parsed.worlds) ? parsed.worlds : [];
    const worlds = rawWorlds.filter((w): w is World => {
      if (isValidWorld(w)) return true;
      log("warn", "worlds", "dropping malformed world entry from", filePath, ":", JSON.stringify(w));
      return false;
    });
    const mru = Array.isArray(parsed.mru) ? parsed.mru.filter((id): id is string => typeof id === "string") : [];
    return { worlds, mru };
  } catch (err) {
    log("warn", "worlds", "failed to parse", filePath, "- treating as empty:", err);
    return { worlds: [], mru: [] };
  }
}

// Write-temp-then-rename so a process killed mid-write can never leave a
// truncated/corrupt file behind for the next reader.
function writeState(filePath: string, state: WorldsState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function loadWorldsState(filePath: string): WorldsState {
  return readState(filePath);
}

export function loadWorlds(filePath: string): World[] {
  return readState(filePath).worlds;
}

// The read-modify-write helpers below need no locking: one moolin process
// owns every window (see main.ts's single-instance lock), and these run
// synchronously in it, so no two can interleave.

export function saveWorlds(filePath: string, worlds: World[]): void {
  const state = readState(filePath);
  writeState(filePath, { ...state, worlds });
}

export function updateMru(filePath: string, updater: (mru: string[]) => string[]): string[] {
  const state = readState(filePath);
  const mru = updater(state.mru);
  writeState(filePath, { ...state, mru });
  return mru;
}
