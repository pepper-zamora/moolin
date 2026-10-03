import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logPathFor, readLogTail, sanitizePathSegment, SessionLogRegistry } from "./session-log";
import { newWorld } from "./world-utils";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moolin-log-"));
}

test("sanitizePathSegment neutralises separators, dots and empties", () => {
  assert.equal(sanitizePathSegment("a/b\\c"), "a_b_c");
  assert.equal(sanitizePathSegment(".."), "_");
  assert.equal(sanitizePathSegment(".hidden"), "_.hidden");
  assert.equal(sanitizePathSegment("  "), "_");
  assert.equal(sanitizePathSegment("LambdaMOO"), "LambdaMOO");
});

test("logPathFor nests character under world, or omits it", () => {
  const world = { ...newWorld("w"), name: "LambdaMOO" };
  assert.equal(
    logPathFor("/r", world, { id: "c", name: "Cowpernica", password: "" }),
    path.join("/r", "LambdaMOO", "Cowpernica", "moolin.log"),
  );
  assert.equal(logPathFor("/r", world, null), path.join("/r", "LambdaMOO", "moolin.log"));
});

test("readLogTail returns empty for a missing file and whole small files", () => {
  const dir = tempDir();
  assert.equal(readLogTail(path.join(dir, "nope"), 100).length, 0);
  const file = path.join(dir, "f");
  fs.writeFileSync(file, "one\r\ntwo\r\n");
  assert.equal(Buffer.from(readLogTail(file, 100)).toString(), "one\r\ntwo\r\n");
});

test("readLogTail starts at a line boundary when truncating", () => {
  const dir = tempDir();
  const file = path.join(dir, "f");
  fs.writeFileSync(file, "aaaa\nbbbb\ncccc\n");
  assert.equal(Buffer.from(readLogTail(file, 8)).toString(), "cccc\n");
});

test("only the first claimant owns a log; closing releases it", () => {
  const registry = new SessionLogRegistry();
  const file = path.join(tempDir(), "w", "moolin.log");
  const first = registry.claim(file);
  assert.ok(first);
  assert.equal(registry.claim(file), null);
  first.close();
  assert.ok(registry.claim(file));
});

test("append creates directories, keeps escapes, and accumulates across sessions", async () => {
  const file = path.join(tempDir(), "w", "c", "moolin.log");
  const registry = new SessionLogRegistry();
  const first = registry.claim(file);
  assert.ok(first);
  first.append("\x1b[31mred\x1b[0m\r\n");
  first.append(new Uint8Array([104, 105, 13, 10]));
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = registry.claim(file);
  assert.ok(second);
  assert.equal(Buffer.from(second.history(1000)).toString(), "\x1b[31mred\x1b[0m\r\nhi\r\n");
  second.append("more\r\n");
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.readFileSync(file, "utf8"), "\x1b[31mred\x1b[0m\r\nhi\r\nmore\r\n");
});
