import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorld, readWorldsFile, resolveWorldsPath, saveWorlds, updateMru } from "./worlds";
import { DEFAULT_LOGIN_TEMPLATE, newWorld } from "./world-utils";

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-worlds-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveWorldsPath expands ~ and resolves relative paths", () => {
  assert.equal(resolveWorldsPath("~/w"), path.join(os.homedir(), "w"));
  assert.equal(resolveWorldsPath("w"), path.resolve("w"));
  assert.equal(resolveWorldsPath(undefined), path.join(os.homedir(), "Documents", "Moolin", "worlds"));
});

test("parseWorld fills in defaults for fields missing from an older record", () => {
  assert.deepEqual(parseWorld({ id: "a", name: "A", host: "h", port: 23 }), {
    id: "a",
    name: "A",
    host: "h",
    port: 23,
    tls: false,
    tlsAllowUntrusted: false,
    autoLogin: false,
    loginTemplate: DEFAULT_LOGIN_TEMPLATE,
    characters: [],
  });
});

test("parseWorld reads a fully-populated record, including characters", () => {
  const record = {
    id: "w",
    name: "LambdaMOO",
    host: "lambda.moo.mud.org",
    port: 9500,
    tls: false,
    autoLogin: true,
    loginTemplate: "co {{character}} {{password}}\\r",
    characters: [{ id: "c", name: "Cowpernica", password: "pw" }],
  };
  assert.deepEqual(parseWorld(record), { ...record, tlsAllowUntrusted: false });
});

test("parseWorld clears an invalid port rather than rejecting the world", () => {
  for (const port of [0, 70000, 1.5, "23", null, undefined]) {
    assert.equal(parseWorld({ id: "a", host: "h", port })?.port, null, `port ${String(port)}`);
  }
});

test("parseWorld rejects malformed records and drops malformed characters", () => {
  assert.equal(parseWorld(null), null);
  assert.equal(parseWorld({ name: "no id" }), null);
  assert.equal(parseWorld({ id: "" }), null);
  assert.equal(parseWorld({ id: "a", host: 42 }), null);
  assert.equal(parseWorld({ id: "a", tls: "yes" }), null);
  assert.equal(parseWorld({ id: "a", characters: "none" }), null);
  const world = parseWorld({ id: "a", characters: [{ id: "c", name: "ok" }, { name: "no id" }, "junk"] });
  assert.deepEqual(world?.characters, [{ id: "c", name: "ok", password: "" }]);
});

test("a missing or empty file reads as no worlds, without an error", () => {
  withTempDir((dir) => {
    assert.deepEqual(readWorldsFile(path.join(dir, "missing")), { state: { worlds: [], mru: [] } });
    fs.writeFileSync(path.join(dir, "empty"), "\n");
    assert.deepEqual(readWorldsFile(path.join(dir, "empty")), { state: { worlds: [], mru: [] } });
  });
});

test("an unparseable file is reported, and saving over it is refused", () => {
  withTempDir((dir) => {
    for (const contents of ["{ not json", '{"nope": []}']) {
      const file = path.join(dir, "worlds");
      fs.writeFileSync(file, contents);
      const result = readWorldsFile(file);
      assert.deepEqual(result.state, { worlds: [], mru: [] });
      assert.match(result.error ?? "", /Could not parse/);
      assert.throws(() => saveWorlds(file, [newWorld("a")]), /Could not parse/);
      assert.equal(
        updateMru(file, () => [{ worldId: "a" }]),
        null,
      );
      assert.equal(fs.readFileSync(file, "utf-8"), contents, "the file must be left untouched");
    }
  });
});

test("malformed world entries are dropped individually", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    fs.writeFileSync(file, JSON.stringify({ worlds: [{ id: "good" }, { name: "bad" }] }));
    assert.deepEqual(
      readWorldsFile(file).state.worlds.map((w) => w.id),
      ["good"],
    );
  });
});

test("malformed MRU entries are dropped individually", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    fs.writeFileSync(
      file,
      JSON.stringify({
        worlds: [],
        mru: ["a", { worldId: "b", characterId: "c" }, { worldId: "d" }, 7, { characterId: "x" }],
      }),
    );
    assert.deepEqual(readWorldsFile(file).state.mru, [{ worldId: "b", characterId: "c" }, { worldId: "d" }]);
  });
});

test("saveWorlds and updateMru each preserve the other's data", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "nested", "worlds");
    saveWorlds(file, [newWorld("a")]);
    updateMru(file, (mru) => [{ worldId: "a" }, ...mru]);
    saveWorlds(file, [newWorld("a"), newWorld("b")]);
    const { state } = readWorldsFile(file);
    assert.deepEqual(
      state.worlds.map((w) => w.id),
      ["a", "b"],
    );
    assert.deepEqual(state.mru, [{ worldId: "a" }]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["worlds"], "no temp files left behind");
  });
});
