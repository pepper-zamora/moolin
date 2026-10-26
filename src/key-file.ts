// Reading a key file, and unlocking with the one Moolin remembers. Kept out of
// main.ts so they can be tested without Electron.
import * as fs from "node:fs";
import { secretFromFilePath } from "./crypto-keys";
import type { Security } from "./security";

// A key file stands in for a phrase whatever it holds, however big: what is used
// is the hash of its contents, read a piece at a time.
export async function readKeyFile(file: string): Promise<{ secret: Buffer } | { error: string }> {
  try {
    if (fs.statSync(file).size === 0) return { error: "That key file is empty" };
    return { secret: await secretFromFilePath(file) };
  } catch (err) {
    return { error: `Could not read the key file: ${(err as Error).message}` };
  }
}

// With a key file remembered, an encrypted install unlocks itself while the file
// is there. Returns what to log, or null when there was nothing to try.
export async function unlockWithKeyFile(security: Security, file: string | null): Promise<string | null> {
  if (security.state() !== "locked" || !file) return null;
  const read = await readKeyFile(file);
  if ("error" in read) return `the remembered key file can't be used: ${read.error}`;
  const outcome = await security.unlock(read.secret);
  return outcome.ok ? "unlocked with the remembered key file" : `key file refused: ${outcome.error}`;
}
