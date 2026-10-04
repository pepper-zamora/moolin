import { test } from "node:test";
import assert from "node:assert/strict";
import { getCliLogLevel, isEnabled, parseLogLevel } from "./logger";

test("parseLogLevel accepts the known levels and defaults to none", () => {
  for (const level of ["none", "error", "warn", "info", "debug"] as const) assert.equal(parseLogLevel(level), level);
  assert.equal(parseLogLevel(undefined), "none");
  assert.equal(parseLogLevel("verbose"), "none");
  assert.equal(parseLogLevel("DEBUG"), "none");
});

test("getCliLogLevel reads --log-level=LEVEL from anywhere in argv", () => {
  assert.equal(getCliLogLevel(["electron", ".", "--log-level=info", "worlds.json"]), "info");
  assert.equal(getCliLogLevel(["electron", "."]), "none");
  assert.equal(getCliLogLevel(["--log-level"]), "none");
  assert.equal(getCliLogLevel(["--log-level=bogus"]), "none");
});

test("isEnabled passes a message at or above the configured level", () => {
  assert.equal(isEnabled("warn", "error"), true);
  assert.equal(isEnabled("warn", "warn"), true);
  assert.equal(isEnabled("warn", "info"), false);
  assert.equal(isEnabled("debug", "debug"), true);
  assert.equal(isEnabled("none", "error"), false);
});
