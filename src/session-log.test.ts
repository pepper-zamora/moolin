import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { locateLogFile, logPathFor, sanitizePathSegment, SessionLogRegistry, WindowLog } from "./session-log";
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

test("logPathFor nests character under world, or omits it, each prefixed by its id", () => {
  const world = { ...newWorld("3f2a9c1e-77d0-4b6e-9a51-0c8e2d4f6a1b"), name: "LambdaMOO" };
  assert.equal(
    logPathFor("/r", world, {
      id: "c",
      name: "Cowpernica",
      password: "",
      echoCommands: "inherit",
      wordWrap: "inherit",
      honorClear: "inherit",
    }),
    path.join("/r", "3f2a9c1e.LambdaMOO", "c.Cowpernica", "moolin.log"),
  );
  assert.equal(logPathFor("/r", world, null), path.join("/r", "3f2a9c1e.LambdaMOO", "moolin.log"));
  // Only letters and digits of the id are used; an id with none still gets a prefix.
  assert.equal(logPathFor("/r", { ...world, id: "../.." }, null), path.join("/r", "_.LambdaMOO", "moolin.log"));
});

test("only the first claimant owns a log; closing releases it", () => {
  const registry = new SessionLogRegistry();
  const file = path.join(tempDir(), "w", "moolin.log");
  const first = registry.claim(file, () => file);
  assert.ok(first);
  let located = false;
  assert.equal(
    registry.claim(file, () => {
      located = true;
      return file;
    }),
    null,
  );
  assert.equal(located, false, "a failed claim must not touch the log's folders");
  first.close();
  assert.ok(registry.claim(file, () => file));
});

test("append creates directories, keeps escapes, and accumulates across sessions", () => {
  const file = path.join(tempDir(), "w", "c", "moolin.log");
  const registry = new SessionLogRegistry();
  const first = registry.claim(file, () => file);
  assert.ok(first);
  first.append("\x1b[31mred\x1b[0m\r\n", 1000);
  first.append(new Uint8Array([104, 105, 13, 10]), 2000);
  first.close();

  const second = registry.claim(file, () => file);
  assert.ok(second);
  assert.equal(Buffer.from(second.history(1000).bytes).toString(), "\x1b[31mred\x1b[0m\r\nhi\r\n");
  second.append("more\r\n", 3000);
  second.close();
  const again = registry.claim(file, () => file);
  assert.ok(again);
  assert.equal(Buffer.from(again.history(1000).bytes).toString(), "\x1b[31mred\x1b[0m\r\nhi\r\nmore\r\n");
  again.close();
});

test("each line's arrival time is restored across sessions", () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const first = registry.claim(file, () => file);
  assert.ok(first);
  first.append("one\r\n", 1000);
  first.append("two\r\nthree\r\n", 2000); // one append, two lines, same time
  first.close();

  const second = registry.claim(file, () => file);
  assert.ok(second);
  assert.deepEqual(second.history(1000).times, [1000, 2000, 2000]);
  second.close();
});

test("history times align to the log tail when it is truncated", () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const log = registry.claim(file, () => file);
  assert.ok(log);
  log.append("aaaa\r\n", 1); // dropped by the tail cut below
  log.append("bbbb\r\n", 2);
  log.append("cccc\r\n", 3);
  log.close();

  const reopened = registry.claim(file, () => file);
  assert.ok(reopened);
  // Only the last two lines survive a 14-byte tail; their times come with them.
  const history = reopened.history(14);
  assert.equal(Buffer.from(history.bytes).toString(), "bbbb\r\ncccc\r\n");
  assert.deepEqual(history.times, [2, 3]);
  reopened.close();
});

test("untimed (Moolin) lines come back as null, keeping alignment", () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const log = registry.claim(file, () => file);
  assert.ok(log);
  log.append("[connecting]\r\n", null); // a Moolin status line: no timestamp
  log.append("server says hi\r\n", 5000); // real server output
  log.close();

  const reopened = registry.claim(file, () => file);
  assert.ok(reopened);
  assert.deepEqual(reopened.history(1000).times, [null, 5000]);
  reopened.close();
});

test("a log reclaimed straight after close reads back everything, times aligned", () => {
  const file = path.join(tempDir(), "w", "moolin.log");
  const registry = new SessionLogRegistry();
  const first = registry.claim(file, () => file);
  assert.ok(first);
  for (let i = 0; i < 100; i++) first.append(`line ${i}\r\n`, i);
  first.close();

  // Reconnecting to the same world: no chance for anything to flush between.
  const second = registry.claim(file, () => file);
  assert.ok(second);
  const history = second.history(1_000_000);
  assert.equal(Buffer.from(history.bytes).toString().split("\r\n").length - 1, 100);
  assert.deepEqual(
    history.times,
    Array.from({ length: 100 }, (_, i) => i),
  );
  second.close();
});

const cowpernica = {
  id: "7b0d44aa-0000",
  name: "Cowpernica",
  password: "",
  echoCommands: "inherit" as const,
  wordWrap: "inherit" as const,
  honorClear: "inherit" as const,
};

test("locateLogFile creates nothing, and names new folders by id and label", () => {
  const root = tempDir();
  const world = { ...newWorld("3f2a9c1e-x"), name: "LambdaMOO" };
  assert.equal(locateLogFile(root, world, cowpernica), logPathFor(root, world, cowpernica));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("locateLogFile follows renames of a world and character", () => {
  const root = tempDir();
  const world = { ...newWorld("3f2a9c1e-x"), name: "LambdaMOO" };
  const file = locateLogFile(root, world, cowpernica);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "old\n");

  // Renaming the world and character renames their folders to match.
  const renamed = locateLogFile(root, { ...world, name: "LambdaCOW" }, { ...cowpernica, name: "Nica" });
  assert.equal(renamed, path.join(root, "3f2a9c1e.LambdaCOW", "7b0d44aa.Nica", "moolin.log"));
  assert.equal(fs.readFileSync(renamed, "utf8"), "old\n");
  assert.deepEqual(fs.readdirSync(root), ["3f2a9c1e.LambdaCOW"]);
});

test("worlds whose names differ only in case get separate folders", () => {
  const root = tempDir();
  const a = locateLogFile(root, { ...newWorld("aaaa1111"), name: "Moo" }, null);
  const b = locateLogFile(root, { ...newWorld("bbbb2222"), name: "moo" }, null);
  assert.notEqual(path.dirname(a).toLowerCase(), path.dirname(b).toLowerCase());
});

test("a window's log is released on disconnect, so another window can take it", () => {
  const root = tempDir();
  const registry = new SessionLogRegistry();
  const world = { ...newWorld("w1"), name: "Moo" };
  const a = new WindowLog(registry, root);
  const b = new WindowLog(registry, root);

  a.open(world, null, 1000);
  a.append("from a\n", 1);
  assert.equal(a.owned, true);
  assert.deepEqual(b.open(world, null, 1000).bytes, new Uint8Array(), "b gets no history while a holds it");
  assert.equal(b.owned, false);
  b.append("not logged\n", 2);

  a.append("[disconnected]\n", null);
  a.release();
  const history = b.open(world, null, 1000);
  assert.equal(b.owned, true);
  assert.equal(Buffer.from(history.bytes).toString(), "from a\n[disconnected]\n");
  assert.deepEqual(history.times, [1, null]);
  b.release();
});

test("a log that stops on a disk error no longer counts as owned", () => {
  const root = tempDir();
  const world = { ...newWorld("w1"), name: "Moo" };
  // A file where the world's folder should be makes every write fail.
  fs.writeFileSync(path.join(root, "w1.Moo"), "");
  const errors: string[] = [];
  const log = new WindowLog(new SessionLogRegistry((_file, error) => errors.push(error.message)), root);
  log.open(world, null, 1000);
  log.append("x\n", 1);
  assert.equal(log.owned, false);
  assert.equal(errors.length, 1);
});

test("log files and the folders made for them can be read by their owner alone", {
  skip: process.platform === "win32",
}, () => {
  const root = tempDir();
  const file = path.join(root, "w", "c", "moolin.log");
  const log = new SessionLogRegistry().claim(file, () => file);
  assert.ok(log);
  log.append("secret\r\n", 1000);
  const mode = (target: string) => fs.statSync(target).mode & 0o777;
  assert.equal(mode(file), 0o600);
  assert.equal(mode(path.dirname(file)), 0o700);
  log.close();

  // A log from an earlier version, readable by everyone, is tightened when reopened.
  fs.chmodSync(file, 0o644);
  const again = new SessionLogRegistry().claim(file, () => file);
  assert.ok(again);
  again.append("more\r\n", 2000);
  assert.equal(mode(file), 0o600);
  again.close();
});
