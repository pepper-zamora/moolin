import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preferencesPath, readPreferences, writePreferences } from "./preferences";

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
    assert.deepEqual(readPreferences(preferencesPath(dir)), { showTimestamps: false });
  });
});

test("writePreferences round-trips, creating the directory if needed", () => {
  withTempDir((dir) => {
    const file = preferencesPath(path.join(dir, "nested"));
    writePreferences(file, { showTimestamps: true });
    assert.deepEqual(readPreferences(file), { showTimestamps: true });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["preferences.json"]);
  });
});

test("readPreferences falls back to defaults for bad JSON or mistyped fields", () => {
  withTempDir((dir) => {
    const file = preferencesPath(dir);
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readPreferences(file), { showTimestamps: false });
    fs.writeFileSync(file, JSON.stringify({ showTimestamps: "yes" }));
    assert.deepEqual(readPreferences(file), { showTimestamps: false });
    fs.writeFileSync(file, "null");
    assert.deepEqual(readPreferences(file), { showTimestamps: false });
  });
});
