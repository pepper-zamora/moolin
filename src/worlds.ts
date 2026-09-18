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

function writeState(filePath: string, state: WorldsState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function loadWorldsState(filePath: string): WorldsState {
  return readState(filePath);
}

export function loadWorlds(filePath: string): World[] {
  return readState(filePath).worlds;
}

export function saveWorlds(filePath: string, worlds: World[]): void {
  const state = readState(filePath);
  writeState(filePath, { ...state, worlds });
}

export function loadMru(filePath: string): string[] {
  return readState(filePath).mru;
}

export function saveMru(filePath: string, mru: string[]): void {
  const state = readState(filePath);
  writeState(filePath, { ...state, mru });
}
