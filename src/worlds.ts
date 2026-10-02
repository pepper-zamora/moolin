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

function readState(filePath: string): WorldsState {
  if (!fs.existsSync(filePath)) return { worlds: [], mru: [] };
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (raw.length === 0) return { worlds: [], mru: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<WorldsState>;
    return { worlds: parsed.worlds ?? [], mru: parsed.mru ?? [] };
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

const LOCK_WAIT_TIMEOUT_MS = 2000;
// A lock left behind by a process that crashed/was killed while holding it
// is indistinguishable from one still legitimately held; treat it as stale
// (and safe to steal) once it's older than this.
const LOCK_STALE_MS = 5000;

// Multiple moolin processes (one per connected world — see main.ts's
// spawnInstanceForWorld) can read-modify-write this same file concurrently,
// e.g. two MRU updates landing close together. Without a lock around the
// whole read-modify-write, the second writer can silently clobber the
// first's change.
function withLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // Lock vanished between the EEXIST and the stat; just retry.
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock on ${filePath}`);
      }
    }
  }
  try {
    return fn();
  } finally {
    fs.unlinkSync(lockPath);
  }
}

export function loadWorldsState(filePath: string): WorldsState {
  return readState(filePath);
}

export function loadWorlds(filePath: string): World[] {
  return readState(filePath).worlds;
}

export function saveWorlds(filePath: string, worlds: World[]): void {
  withLock(filePath, () => {
    const state = readState(filePath);
    writeState(filePath, { ...state, worlds });
  });
}

// Atomically reads the current MRU, applies `updater`, and writes the result
// back under the same lock, so two processes updating MRU around the same
// time can't lose one's update to the other.
export function updateMru(filePath: string, updater: (mru: string[]) => string[]): string[] {
  return withLock(filePath, () => {
    const state = readState(filePath);
    const mru = updater(state.mru);
    writeState(filePath, { ...state, mru });
    return mru;
  });
}
