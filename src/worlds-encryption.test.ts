import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEnvelope, normalizePhrase, rewrapEnvelope } from "./crypto-keys";
import { backupPathFor, changeEncryption, readWorldsFile, saveWorlds, updateMru, type Encryption } from "./worlds";
import { newCharacter, newWorld } from "./world-utils";
import type { World } from "./worlds-types";

const CHEAP = { N: 1 << 14, r: 8, p: 1 };
const posix = { skip: process.platform === "win32" };

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-worlds-enc-"));
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const result = fn(dir);
    if (result) return result.finally(cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
}

function sampleWorlds(): World[] {
  const world = { ...newWorld("w1"), name: "Test MOO", host: "moo.example.org", port: 7777 };
  world.characters = [
    { ...newCharacter("c1"), name: "Cowpernica", password: "hunter2-unique-marker" },
    { ...newCharacter("c2"), name: "Other", password: "second-secret-marker" },
  ];
  return [world];
}

async function newEncryption(phrase = "a key phrase"): Promise<Encryption> {
  const { envelope, dataKey } = await createEnvelope(normalizePhrase(phrase), "phrase", CHEAP);
  return { envelope, dataKey };
}

const passwordsOf = (worlds: World[]): string[] => worlds.flatMap((w) => w.characters.map((c) => c.password));

test("turning encryption on seals every password and names the file encrypted", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);

    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("hunter2-unique-marker"), false);
    assert.equal(text.includes("second-secret-marker"), false);
    const json = JSON.parse(text);
    assert.equal(json.encryption.version, 1);
    assert.equal(json.encryption.keyId, encryption.envelope.keyId);
    assert.equal("password" in json.worlds[0].characters[0], false);
    assert.equal(typeof json.worlds[0].characters[0].passwordEncrypted, "string");
    assert.equal(json.worlds[0].name, "Test MOO", "only the passwords are sealed");

    const read = readWorldsFile(file, encryption.dataKey);
    assert.equal(read.error, undefined);
    assert.equal(read.locked, false);
    assert.deepEqual(passwordsOf(read.state.worlds), ["hunter2-unique-marker", "second-secret-marker"]);
  });
});

test("without the key the file reads as locked: everything but the passwords", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    changeEncryption(file, null, await newEncryption());
    const read = readWorldsFile(file);
    assert.equal(read.locked, true);
    assert.equal(read.error, undefined);
    assert.equal(read.state.worlds[0].name, "Test MOO");
    assert.equal(read.state.worlds[0].characters[0].name, "Cowpernica");
    assert.deepEqual(passwordsOf(read.state.worlds), ["", ""]);
  });
});

test("a locked file refuses to be saved over, which would lose its passwords", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => saveWorlds(file, sampleWorlds()), /locked/);
    assert.equal(
      updateMru(file, () => [{ worldId: "w1" }]),
      null,
    );
    assert.throws(() => changeEncryption(file, null, null), /locked/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("saving and recording a connection keep an encrypted file encrypted", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);

    const worlds = sampleWorlds();
    worlds[0].characters[0].password = "changed-marker";
    saveWorlds(file, worlds, undefined, encryption.dataKey);
    assert.deepEqual(
      updateMru(file, () => [{ worldId: "w1", characterId: "c1" }], encryption.dataKey),
      [{ worldId: "w1", characterId: "c1" }],
    );

    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("changed-marker"), false);
    assert.ok(JSON.parse(text).encryption);
    const read = readWorldsFile(file, encryption.dataKey);
    assert.equal(read.state.worlds[0].characters[0].password, "changed-marker");
    assert.deepEqual(read.state.mru, [{ worldId: "w1", characterId: "c1" }]);
  });
});

test("the backup never holds a password in plain text after encryption is turned on", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    assert.ok(fs.readFileSync(file, "utf8").includes("hunter2-unique-marker"));
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);
    assert.equal(fs.readFileSync(backupPathFor(file), "utf8").includes("hunter2-unique-marker"), false);
    saveWorlds(file, sampleWorlds(), undefined, encryption.dataKey);
    saveWorlds(file, sampleWorlds(), undefined, encryption.dataKey);
    assert.equal(fs.readFileSync(backupPathFor(file), "utf8").includes("hunter2-unique-marker"), false);
  });
});

test("turning encryption off puts the passwords back, and removes the block", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);
    changeEncryption(file, encryption.dataKey, null);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal("encryption" in json, false);
    assert.equal(json.worlds[0].characters[0].password, "hunter2-unique-marker");
    const read = readWorldsFile(file);
    assert.equal(read.locked, undefined);
    assert.deepEqual(passwordsOf(read.state.worlds), ["hunter2-unique-marker", "second-secret-marker"]);
  });
});

test("changing the phrase re-wraps the key: the new phrase's envelope opens what the file holds", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const first = await newEncryption("old phrase");
    changeEncryption(file, null, first);
    const envelope = await rewrapEnvelope(first.dataKey, normalizePhrase("new phrase"), "phrase", CHEAP);
    changeEncryption(file, first.dataKey, { envelope, dataKey: first.dataKey });
    const read = readWorldsFile(file, first.dataKey);
    assert.equal(read.error, undefined);
    assert.equal(read.encryption?.kdf.salt, envelope.kdf.salt);
    assert.deepEqual(passwordsOf(read.state.worlds), ["hunter2-unique-marker", "second-secret-marker"]);
  });
});

test("a different key, a swapped password or an altered one is an error, never a silent loss", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);
    const other = await newEncryption("another");

    assert.match(readWorldsFile(file, other.dataKey).error ?? "", /different key/);

    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const [a, b] = json.worlds[0].characters;
    [a.passwordEncrypted, b.passwordEncrypted] = [b.passwordEncrypted, a.passwordEncrypted];
    const swapped = path.join(dir, "swapped");
    fs.writeFileSync(swapped, JSON.stringify(json));
    assert.match(readWorldsFile(swapped, encryption.dataKey).error ?? "", /could not be decrypted/);
    assert.throws(() => saveWorlds(swapped, sampleWorlds(), undefined, encryption.dataKey));

    json.encryption.kdf.N = 7;
    const damaged = path.join(dir, "damaged");
    fs.writeFileSync(damaged, JSON.stringify(json));
    assert.match(readWorldsFile(damaged).error ?? "", /"encryption" block is damaged/);
  });
});

test("an encrypted file whose main copy is unreadable is recovered from its encrypted backup", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    const encryption = await newEncryption();
    changeEncryption(file, null, encryption);
    fs.writeFileSync(file, "{ not json");
    const read = readWorldsFile(file, encryption.dataKey);
    assert.ok(read.recovered);
    assert.equal(read.state.worlds[0].characters[0].password, "hunter2-unique-marker");
  });
});

test("the encrypted file is private to its owner", posix, async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "worlds");
    saveWorlds(file, sampleWorlds());
    changeEncryption(file, null, await newEncryption());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(backupPathFor(file)).mode & 0o777, 0o600);
  });
});
