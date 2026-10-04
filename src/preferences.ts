import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger";

// App-wide settings that outlive a session. Unlike the worlds file (which
// lives under Documents so it is easy to find and hand-edit), these live in
// the OS's usual per-app config folder; main.ts passes in Electron's
// userData path (~/.config/Moolin, ~/Library/Application Support/Moolin,
// %APPDATA%\Moolin).
export interface Preferences {
  // Whether new windows open with the line-timestamp gutter shown.
  showTimestamps: boolean;
  // Whether to ask GitHub for a newer release at startup (see update-check.ts).
  checkForUpdates: boolean;
}

const DEFAULTS: Preferences = { showTimestamps: false, checkForUpdates: true };

export function preferencesPath(configDir: string): string {
  return path.join(configDir, "preferences.json");
}

// Missing or unreadable files, and fields of the wrong type, fall back to
// the defaults: a preference is never worth refusing to start over.
export function readPreferences(filePath: string): Preferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", "prefs", "ignoring unreadable", filePath, ":", (err as Error).message);
    }
    return { ...DEFAULTS };
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return {
    showTimestamps: typeof record.showTimestamps === "boolean" ? record.showTimestamps : DEFAULTS.showTimestamps,
    checkForUpdates: typeof record.checkForUpdates === "boolean" ? record.checkForUpdates : DEFAULTS.checkForUpdates,
  };
}

// Write-temp-then-rename, as for the worlds file, so a crash mid-write
// can't leave a truncated file behind. Failures are logged, not thrown:
// losing a preference shouldn't break the menu item that changed it.
export function writePreferences(filePath: string, prefs: Preferences): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    log("error", "prefs", "could not save", filePath, ":", (err as Error).message);
  }
}
