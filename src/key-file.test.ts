import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { secretFromFile } from "./crypto-keys";
import { readKeyFile, unlockWithKeyFile } from "./key-file";
import { PLAIN } from "./log-format";
import { Security } from "./security";
import { SessionLogRegistry } from "./session-log";
import { newCharacter, newWorld } from "./world-utils";
import { saveWorlds } from "./worlds";

const CHEAP = { N: 1 << 14, r: 8, p: 1 };

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moolin-keyfile-"));
}

// A Security over a worlds file with one character, and a restart of it.
function securityIn(dir: string): () => Security {
  const worldsPath = path.join(dir, "worlds");
  const world = {
    ...newWorld("w1"),
    name: "Moo",
    characters: [{ ...newCharacter("c1"), name: "Cow", password: "pw" }],
  };
  saveWorlds(worldsPath, [world]);
  const registry = new SessionLogRegistry(undefined, () => PLAIN);
  return () => new Security(worldsPath, path.join(dir, "Moolin"), registry, CHEAP);
}

test("a key file reads as the hash of its contents", async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "key");
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(await readKeyFile(file), { secret: secretFromFile(Buffer.from([0, 1, 2, 255])) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or missing key file is an error saying so", async () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, "empty");
    fs.writeFileSync(empty, "");
    assert.deepEqual(await readKeyFile(empty), { error: "That key file is empty" });
    const missing = await readKeyFile(path.join(dir, "missing"));
    assert.ok("error" in missing && missing.error.startsWith("Could not read the key file:"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a remembered key file unlocks a locked install", async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "key");
    fs.writeFileSync(file, "stick contents");
    const make = securityIn(dir);
    await make().enable(secretFromFile(Buffer.from("stick contents")), "file");
    const restarted = make();
    assert.equal(restarted.state(), "locked");
    assert.equal(await unlockWithKeyFile(restarted, file), "unlocked with the remembered key file");
    assert.equal(restarted.state(), "unlocked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a remembered key file that is gone, empty or wrong leaves it locked, saying why", async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "key");
    fs.writeFileSync(file, "stick contents");
    const make = securityIn(dir);
    await make().enable(secretFromFile(Buffer.from("stick contents")), "file");

    const s = make();
    assert.match(
      (await unlockWithKeyFile(s, path.join(dir, "gone"))) ?? "",
      /^the remembered key file can't be used: /,
    );
    fs.writeFileSync(file, "");
    assert.match((await unlockWithKeyFile(s, file)) ?? "", /empty/);
    fs.writeFileSync(file, "some other file");
    assert.match((await unlockWithKeyFile(s, file)) ?? "", /^key file refused: /);
    assert.equal(s.state(), "locked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("there is nothing to try when no file is remembered, or it is not locked", async () => {
  const dir = scratch();
  try {
    const make = securityIn(dir);
    assert.equal(await unlockWithKeyFile(make(), "/some/file"), null, "encryption is off");
    await make().enable(secretFromFile(Buffer.from("x")), "file");
    assert.equal(await unlockWithKeyFile(make(), null), null, "no file remembered");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
