import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger";
import { clampFontSize, DEFAULT_FONT_ID, DEFAULT_FONT_SIZE, isValidFontId } from "./fonts";

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
  // The default font and size new windows' terminals start with (see fonts.ts).
  fontId: string;
  fontSize: number;
}

const DEFAULTS: Preferences = {
  showTimestamps: false,
  checkForUpdates: true,
  fontId: DEFAULT_FONT_ID,
  fontSize: DEFAULT_FONT_SIZE,
};

export function preferencesPath(configDir: string): string {
  return path.join(configDir, "preferences.json");
}

// Each field falls back to its own default rather than rejecting the whole
// record, so one bad or removed field (an unknown fontId from an older
// release, say) doesn't cost every other preference. Used both for a
// freshly read file and for merging a save request coming over IPC, since
// both cross a boundary this process didn't fully control.
function sanitize(record: Record<string, unknown>, fallback: Preferences): Preferences {
  return {
    showTimestamps: typeof record.showTimestamps === "boolean" ? record.showTimestamps : fallback.showTimestamps,
    checkForUpdates: typeof record.checkForUpdates === "boolean" ? record.checkForUpdates : fallback.checkForUpdates,
    fontId: typeof record.fontId === "string" && isValidFontId(record.fontId) ? record.fontId : fallback.fontId,
    fontSize:
      typeof record.fontSize === "number" && Number.isFinite(record.fontSize)
        ? clampFontSize(record.fontSize)
        : fallback.fontSize,
  };
}

export function sanitizePreferences(partial: Partial<Preferences>, fallback: Preferences): Preferences {
  return sanitize(partial, fallback);
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
  return sanitize(record, DEFAULTS);
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
