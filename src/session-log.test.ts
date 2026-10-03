import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logPathFor, readLogTail, readTimesTail, sanitizePathSegment, SessionLogRegistry } from "./session-log";
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
  first.append("\x1b[31mred\x1b[0m\r\n", 1000);
  first.append(new Uint8Array([104, 105, 13, 10]), 2000);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = registry.claim(file);
  assert.ok(second);
  assert.equal(Buffer.from(second.history(1000).bytes).toString(), "\x1b[31mred\x1b[0m\r\nhi\r\n");
  second.append("more\r\n", 3000);
  second.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.readFileSync(file, "utf8"), "\x1b[31mred\x1b[0m\r\nhi\r\nmore\r\n");
});

test("the sidecar restores each line's arrival time across sessions", async () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const first = registry.claim(file);
  assert.ok(first);
  first.append("one\r\n", 1000);
  first.append("two\r\nthree\r\n", 2000); // one append, two lines, same time
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = registry.claim(file);
  assert.ok(second);
  assert.deepEqual(second.history(1000).times, [1000, 2000, 2000]);
  second.close();
});

test("history times align to the log tail when it is truncated", async () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const log = registry.claim(file);
  assert.ok(log);
  log.append("aaaa\r\n", 1); // dropped by the tail cut below
  log.append("bbbb\r\n", 2);
  log.append("cccc\r\n", 3);
  log.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reopened = registry.claim(file);
  assert.ok(reopened);
  // Only the last two lines survive a 14-byte tail; their times come with them.
  const history = reopened.history(14);
  assert.equal(Buffer.from(history.bytes).toString(), "bbbb\r\ncccc\r\n");
  assert.deepEqual(history.times, [2, 3]);
  reopened.close();
});

test("the sidecar marks untimed (Moolin) lines as null, keeping alignment", async () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const log = registry.claim(file);
  assert.ok(log);
  log.append("[connecting]\r\n", null); // a Moolin status line: no timestamp
  log.append("server says hi\r\n", 5000); // real server output
  log.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reopened = registry.claim(file);
  assert.ok(reopened);
  assert.deepEqual(reopened.history(1000).times, [null, 5000]);
  reopened.close();
});

test("readTimesTail reports unknown (null) times when there is no sidecar", () => {
  const missing = path.join(tempDir(), "nope.times");
  assert.deepEqual(readTimesTail(missing, 3), [null, null, null]);
  assert.deepEqual(readTimesTail(missing, 0), []);
});

test("readTimesTail reads a torn final record as an unknown (null) time", () => {
  const file = path.join(tempDir(), "moolin.log.times");
  const records = Buffer.alloc(8 * 2 + 3); // two whole records, then 3 torn bytes
  records.writeDoubleLE(1000, 0);
  records.writeDoubleLE(2000, 8);
  fs.writeFileSync(file, records);
  assert.deepEqual(readTimesTail(file, 3), [1000, 2000, null]);
  assert.deepEqual(readTimesTail(file, 2), [2000, null]);
  assert.deepEqual(readTimesTail(file, 4), [null, 1000, 2000, null]);
});

test("appending after a torn sidecar write keeps later times aligned", async () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // As if the app died mid-way through recording the second line's time.
  fs.writeFileSync(file, "one\r\ntwo\r\n");
  const records = Buffer.alloc(8 + 3);
  records.writeDoubleLE(1000, 0);
  fs.writeFileSync(`${file}.times`, records);

  const registry = new SessionLogRegistry();
  const log = registry.claim(file);
  assert.ok(log);
  log.append("three\r\n", 3000);
  log.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reopened = registry.claim(file);
  assert.ok(reopened);
  assert.deepEqual(reopened.history(1000).times, [1000, null, 3000]);
  reopened.close();
});
