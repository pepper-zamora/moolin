import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preferencesPath, readPreferences, writePreferences } from "./preferences";

const DEFAULTS = { showTimestamps: false, checkForUpdates: true, fontId: "system-default", fontSize: 14 };

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-prefs-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readPreferences returns the defaults when there is no file", () => {
  withTempDir((dir) => {
    assert.deepEqual(readPreferences(preferencesPath(dir)), DEFAULTS);
  });
});

test("writePreferences round-trips, creating the directory if needed", () => {
  withTempDir((dir) => {
    const file = preferencesPath(path.join(dir, "nested"));
    const prefs = { showTimestamps: true, checkForUpdates: false, fontId: "jetbrains-mono", fontSize: 18 };
    writePreferences(file, prefs);
    assert.deepEqual(readPreferences(file), prefs);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["preferences.json"]);
  });
});

test("readPreferences falls back to defaults for bad JSON or mistyped fields", () => {
  withTempDir((dir) => {
    const file = preferencesPath(dir);
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readPreferences(file), DEFAULTS);
    fs.writeFileSync(file, JSON.stringify({ showTimestamps: "yes", checkForUpdates: "no" }));
    assert.deepEqual(readPreferences(file), DEFAULTS);
    fs.writeFileSync(file, "null");
    assert.deepEqual(readPreferences(file), DEFAULTS);
  });
});

test("readPreferences falls back to the default fontId when it's unknown, and clamps an out-of-range fontSize", () => {
  withTempDir((dir) => {
    const file = preferencesPath(dir);
    fs.writeFileSync(file, JSON.stringify({ fontId: "comic-sans", fontSize: 999 }));
    assert.deepEqual(readPreferences(file), { ...DEFAULTS, fontSize: 32 });
    fs.writeFileSync(file, JSON.stringify({ fontId: "jetbrains-mono", fontSize: 2 }));
    assert.deepEqual(readPreferences(file), { ...DEFAULTS, fontId: "jetbrains-mono", fontSize: 8 });
  });
});
