import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  backupPathFor,
  parseGlobalSettings,
  parseWorld,
  readWorldsFile,
  resolveWorldsPath,
  saveWorlds,
  seedDefaultWorlds,
  updateMru,
} from "./worlds";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_LOGIN_TEMPLATE, isConnectable, newWorld } from "./world-utils";

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
    echoCommands: "inherit",
    wordWrap: "inherit",
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
    echoCommands: "off",
    wordWrap: "on",
    characters: [{ id: "c", name: "Cowpernica", password: "pw", echoCommands: "inherit", wordWrap: "on" }],
  };
  assert.deepEqual(parseWorld(record), { ...record, tlsAllowUntrusted: false });
});

test("parseWorld migrates an old plain-boolean echoCommands to the matching tri-state", () => {
  assert.equal(parseWorld({ id: "a", echoCommands: true })?.echoCommands, "on");
  assert.equal(parseWorld({ id: "a", echoCommands: false })?.echoCommands, "off");
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
  assert.equal(parseWorld({ id: "a", echoCommands: 42 }), null);
  assert.equal(parseWorld({ id: "a", wordWrap: "sideways" }), null);
  assert.equal(parseWorld({ id: "a", characters: "none" }), null);
  const world = parseWorld({ id: "a", characters: [{ id: "c", name: "ok" }, { name: "no id" }, "junk"] });
  assert.deepEqual(world?.characters, [
    { id: "c", name: "ok", password: "", echoCommands: "inherit", wordWrap: "inherit" },
  ]);
});

test("parseGlobalSettings defaults each field independently rather than rejecting the whole object", () => {
  assert.deepEqual(parseGlobalSettings(undefined), DEFAULT_GLOBAL_SETTINGS);
  assert.deepEqual(parseGlobalSettings(null), DEFAULT_GLOBAL_SETTINGS);
  assert.deepEqual(parseGlobalSettings("not an object"), DEFAULT_GLOBAL_SETTINGS);
  assert.deepEqual(parseGlobalSettings({ wordWrap: true, echoCommands: "nope" }), {
    wordWrap: true,
    echoCommands: DEFAULT_GLOBAL_SETTINGS.echoCommands,
  });
});

test("a missing or empty file reads as no worlds, without an error", () => {
  withTempDir((dir) => {
    assert.deepEqual(readWorldsFile(path.join(dir, "missing")), {
      state: { worlds: [], mru: [], globalSettings: DEFAULT_GLOBAL_SETTINGS },
    });
    fs.writeFileSync(path.join(dir, "empty"), "\n");
    assert.deepEqual(readWorldsFile(path.join(dir, "empty")), {
      state: { worlds: [], mru: [], globalSettings: DEFAULT_GLOBAL_SETTINGS },
    });
  });
});

test("seedDefaultWorlds gives a connectable LambdaMOO with a Guest character, each with its own id", () => {
  const [lambdaMoo] = seedDefaultWorlds();
  assert.equal(lambdaMoo.name, "LambdaMOO");
  assert.equal(lambdaMoo.host, "lambda.moo.mud.org");
  assert.equal(lambdaMoo.port, 8888);
  assert.equal(lambdaMoo.tls, false);
  assert.equal(isConnectable(lambdaMoo), true);
  assert.equal(lambdaMoo.characters.length, 1);
  const [guest] = lambdaMoo.characters;
  assert.equal(guest.name, "Guest");
  assert.equal(guest.password, "guest");
  assert.notEqual(lambdaMoo.id, guest.id);
  // parseWorld/parseCharacter are the read path's own validation; a seeded
  // world should pass it just like one loaded from disk would.
  assert.deepEqual(parseWorld(JSON.parse(JSON.stringify(lambdaMoo))), lambdaMoo);
});

test("an unparseable file is reported, and saving over it is refused", () => {
  withTempDir((dir) => {
    for (const contents of ["{ not json", '{"nope": []}']) {
      const file = path.join(dir, "worlds");
      fs.writeFileSync(file, contents);
      const result = readWorldsFile(file);
      assert.deepEqual(result.state, { worlds: [], mru: [], globalSettings: DEFAULT_GLOBAL_SETTINGS });
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
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["worlds", "worlds.bak"], "no temp files left behind");
  });
});

test("each write keeps the previous version as worlds.bak", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, [newWorld("a")]);
    assert.equal(fs.existsSync(backupPathFor(file)), false, "nothing to back up on the first write");
    saveWorlds(file, [newWorld("a"), newWorld("b")]);
    const backup = readWorldsFile(backupPathFor(file));
    assert.deepEqual(
      backup.state.worlds.map((w) => w.id),
      ["a"],
    );
  });
});

test("an unreadable file falls back to the backup, and the next save sets it aside", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, [newWorld("a")]);
    saveWorlds(file, [newWorld("a"), newWorld("b")]); // backup now holds ["a"]
    fs.writeFileSync(file, "{ typo");

    const read = readWorldsFile(file);
    assert.equal(read.error, undefined);
    assert.match(read.recovered?.error ?? "", /Could not parse/);
    assert.deepEqual(
      read.state.worlds.map((w) => w.id),
      ["a"],
    );

    saveWorlds(file, [newWorld("a"), newWorld("c")]);
    assert.deepEqual(
      readWorldsFile(file).state.worlds.map((w) => w.id),
      ["a", "c"],
    );
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith("worlds.unreadable-"));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf-8"), "{ typo", "the hand-edit is kept");
    assert.deepEqual(
      readWorldsFile(backupPathFor(file)).state.worlds.map((w) => w.id),
      ["a"],
      "the backup isn't overwritten by the unreadable file",
    );
  });
});

test("a missing file doesn't fall back to the backup", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, [newWorld("a")]);
    saveWorlds(file, [newWorld("b")]);
    fs.rmSync(file);
    assert.deepEqual(readWorldsFile(file), { state: { worlds: [], mru: [], globalSettings: DEFAULT_GLOBAL_SETTINGS } });
  });
});

test("updateMru reports a failed write instead of throwing", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, [newWorld("a")]);
    // A directory where the temp file goes makes the write fail.
    fs.mkdirSync(path.join(dir, `.worlds.tmp-${process.pid}`));
    assert.equal(
      updateMru(file, () => [{ worldId: "a" }]),
      null,
    );
    assert.deepEqual(readWorldsFile(file).state.mru, []);
  });
});

// Windows has no POSIX modes to check.
const posix = { skip: process.platform === "win32" };

test("the worlds file and its backup can be read by their owner alone", posix, () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, [newWorld("a")]);
    // A backup left by an older version, readable by everyone.
    fs.writeFileSync(backupPathFor(file), "{}", { mode: 0o644 });
    fs.chmodSync(backupPathFor(file), 0o644);
    saveWorlds(file, [newWorld("a"), newWorld("b")]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(backupPathFor(file)).mode & 0o777, 0o600);
  });
});

test("a worlds file that was readable by everyone is tightened by the next save", posix, () => {
  withTempDir((dir) => {
    const file = path.join(dir, "worlds");
    fs.writeFileSync(file, JSON.stringify({ worlds: [] }));
    fs.chmodSync(file, 0o644);
    saveWorlds(file, [newWorld("a")]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
