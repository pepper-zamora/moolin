// Brings every session log under the log root to one mode: encrypted when
// encryption is turned on, plain when it is turned off, and either to finish a
// conversion the app was stopped in the middle of (main process only).
//
// Each log is converted on its own, through a temporary file renamed over it
// (see convertLog), and says which mode it is in by its first line, so stopping
// part-way leaves a valid mix and running this again picks up where it left off.
import * as fs from "node:fs";
import * as path from "node:path";
import { LOG_FILE_NAME, type SessionLogRegistry } from "./session-log";
import { type LogMode, convertLog } from "./log-format";

export interface ConvertSummary {
  converted: number;
  unchanged: number;
  // Logs that could not be converted (damaged, or sealed with another key), left as they were.
  failed: Array<{ file: string; error: string }>;
}

// How deep logs go under the root: <world>/moolin.log, <world>/<character>/moolin.log.
const MAX_DEPTH = 2;

// Every log file under `root`. Symbolic links are not followed.
export function findLogs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === LOG_FILE_NAME) found.push(path.join(dir, entry.name));
      else if (entry.isDirectory() && depth < MAX_DEPTH) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

// A temporary file left behind by a conversion that was stopped part-way.
function removeStrayTemporaries(file: string): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.convert-`;
  try {
    for (const name of fs.readdirSync(dir))
      if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // Nothing to clean.
  }
}

// Converts the logs under `root` to `target`. `sourceKey` opens any that are
// sealed (when going from encrypted to plain, or finishing a conversion). Refuses
// while a window holds a log open, since it is being written to. Yields to the
// event loop between logs, so a big pile of them doesn't freeze the app, and
// reports progress as it goes.
export async function convertAllLogs(
  root: string,
  target: LogMode,
  sourceKey: Buffer | null,
  registry: SessionLogRegistry,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<ConvertSummary> {
  if (registry.anyOwned()) throw new Error("Disconnect every window first: a log is being written");
  const files = findLogs(root);
  const summary: ConvertSummary = { converted: 0, unchanged: 0, failed: [] };
  for (const [index, file] of files.entries()) {
    removeStrayTemporaries(file);
    try {
      if (convertLog(file, target, sourceKey)) summary.converted++;
      else summary.unchanged++;
    } catch (error) {
      summary.failed.push({ file, error: (error as Error).message });
    }
    onProgress(index + 1, files.length);
    await new Promise((resolve) => setImmediate(resolve));
    // A window may have connected while this yielded.
    if (registry.anyOwned()) throw new Error("A window connected while the logs were being converted");
  }
  return summary;
}
