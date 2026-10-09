import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePhrase, secretFromFile } from "./crypto-keys";
import { PLAIN, inspectLog, readLogHistory } from "./log-format";
import { Security } from "./security";
import { SessionLogRegistry } from "./session-log";
import { newCharacter, newWorld } from "./world-utils";
import { readWorldsFile, saveWorlds } from "./worlds";

const CHEAP = { N: 1 << 14, r: 8, p: 1 };
const text = (history: { bytes: Uint8Array }): string => Buffer.from(history.bytes).toString();

interface Setup {
  dir: string;
  worldsPath: string;
  logRoot: string;
  logFile: string;
  registry: SessionLogRegistry;
  make: () => Security;
}

// A worlds file with one character, a plain log, and a Security over them. `make`
// builds another over the same files, as a restart would.
function setup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-security-"));
  const worldsPath = path.join(dir, "worlds");
  const logRoot = path.join(dir, "Moolin");
  const world = {
    ...newWorld("w1"),
    name: "Moo",
    characters: [{ ...newCharacter("c1"), name: "Cow", password: "pw-marker" }],
  };
  saveWorlds(worldsPath, [world]);
  const logFile = path.join(logRoot, "w1.Moo", "c1.Cow", "moolin.log");
  const registry = new SessionLogRegistry(undefined, () => PLAIN);
  const log = registry.claim("c1", () => logFile);
  assert.ok(log);
  log.history(1);
  log.append("said in private\r\n", 1);
  log.close();
  return {
    dir,
    worldsPath,
    logRoot,
    logFile,
    registry,
    make: () => new Security(worldsPath, logRoot, registry, CHEAP),
  };
}

const phrase = (p: string): Buffer => normalizePhrase(p);

test("encryption starts off, and logs are written plain", () => {
  const s = setup().make();
  assert.deepEqual(s.info(), { state: "off", keySource: null });
  assert.deepEqual(s.logMode(), PLAIN);
  assert.equal(s.dataKey, null);
});

test("turning it on seals the passwords and the logs, and leaves it unlocked", async () => {
  const t = setup();
  const s = t.make();
  const outcome = await s.enable(phrase("open sesame"), "phrase");
  assert.deepEqual(outcome, { ok: true, warnings: [] });
  assert.deepEqual(s.info(), { state: "unlocked", keySource: "phrase" });
  assert.equal(fs.readFileSync(t.worldsPath, "utf8").includes("pw-marker"), false);
  assert.equal(fs.readFileSync(t.logFile, "utf8").includes("private"), false);
  assert.equal(s.logMode()?.kind, "encrypted");
  assert.equal(text(readLogHistory(t.logFile, s.logMode() as never, 1000)), "said in private\r\n");
});

test("after a restart it is locked, a wrong phrase is refused, and the right one unlocks", async () => {
  const t = setup();
  await t.make().enable(phrase("open sesame"), "phrase");

  const s = t.make();
  assert.deepEqual(s.info(), { state: "locked", keySource: "phrase" });
  assert.equal(s.logMode(), null, "no log can be written while locked");
  assert.equal(readWorldsFile(t.worldsPath, s.dataKey).state.worlds[0].characters[0].password, "");

  const wrong = await s.unlock(phrase("open sesame!"));
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? "", /doesn't match/);
  assert.equal(s.state(), "locked");

  assert.deepEqual(await s.unlock(phrase("open sesame")), { ok: true });
  assert.equal(s.state(), "unlocked");
  assert.equal(readWorldsFile(t.worldsPath, s.dataKey).state.worlds[0].characters[0].password, "pw-marker");
  assert.deepEqual((await s.unlock(phrase("open sesame"))).ok, false, "already unlocked");
});

test("a key file works the same way, by its contents", async () => {
  const t = setup();
  const file = Buffer.from("any bytes at all \x00\xff");
  await t.make().enable(secretFromFile(file), "file");
  const s = t.make();
  assert.deepEqual(s.info(), { state: "locked", keySource: "file" });
  assert.equal((await s.unlock(secretFromFile(Buffer.from("other")))).ok, false);
  assert.equal((await s.unlock(secretFromFile(Buffer.from(file)))).ok, true);
});

test("changing the phrase keeps everything readable, under the new phrase only", async () => {
  const t = setup();
  const s = t.make();
  await s.enable(phrase("old"), "phrase");
  const before = fs.readFileSync(t.logFile);
  assert.equal((await s.change(phrase("new"), "phrase")).ok, true);
  assert.deepEqual(fs.readFileSync(t.logFile), before, "no log is rewritten");

  const restarted = t.make();
  assert.equal((await restarted.unlock(phrase("old"))).ok, false);
  assert.equal((await restarted.unlock(phrase("new"))).ok, true);
  assert.equal(text(readLogHistory(t.logFile, restarted.logMode() as never, 1000)), "said in private\r\n");

  // From a phrase to a key file, too.
  assert.equal((await restarted.change(secretFromFile(Buffer.from("f")), "file")).ok, true);
  assert.equal(t.make().info().keySource, "file");
});

test("changing needs it unlocked", async () => {
  const t = setup();
  assert.equal((await t.make().change(phrase("x"), "phrase")).ok, false);
  await t.make().enable(phrase("a"), "phrase");
  assert.equal((await t.make().change(phrase("x"), "phrase")).ok, false, "locked");
});

test("turning it off puts the passwords and logs back, and ends the lock", async () => {
  const t = setup();
  const s = t.make();
  await s.enable(phrase("a"), "phrase");
  assert.deepEqual(await s.disable(), { ok: true, warnings: [] });
  assert.deepEqual(s.info(), { state: "off", keySource: null });
  assert.equal(s.dataKey, null);
  assert.ok(fs.readFileSync(t.worldsPath, "utf8").includes("pw-marker"));
  assert.deepEqual(inspectLog(t.logFile), { kind: "plain" });
  assert.equal(text(readLogHistory(t.logFile, PLAIN, 1000)), "said in private\r\n");
  assert.deepEqual(t.make().info(), { state: "off", keySource: null });
});

test("it can be turned on again after being turned off, with a different phrase", async () => {
  const t = setup();
  const s = t.make();
  await s.enable(phrase("a"), "phrase");
  await s.disable();
  assert.equal((await s.enable(phrase("b"), "phrase")).ok, true);
  assert.equal((await t.make().unlock(phrase("a"))).ok, false);
  assert.equal((await t.make().unlock(phrase("b"))).ok, true);
});

test("turning it on or off is refused while a log is being written, and changes nothing", async () => {
  const t = setup();
  const s = t.make();
  const open = t.registry.claim("c1", () => t.logFile);
  assert.ok(open);
  const before = fs.readFileSync(t.worldsPath, "utf8");
  const refused = await s.enable(phrase("a"), "phrase");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /Disconnect every window/);
  assert.equal(fs.readFileSync(t.worldsPath, "utf8"), before);
  open.close();

  await s.enable(phrase("a"), "phrase");
  const again = t.registry.claim("c1", () => t.logFile);
  assert.ok(again);
  assert.equal((await s.disable()).ok, false);
  assert.equal(s.state(), "unlocked");
  again.close();
});

test("turning it on twice, or two changes at once, are refused", async () => {
  const t = setup();
  const s = t.make();
  const [first, second] = await Promise.all([s.enable(phrase("a"), "phrase"), s.enable(phrase("b"), "phrase")]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /in progress/);
  assert.match((await s.enable(phrase("c"), "phrase")).error ?? "", /already on/);
});

test("a log it could not convert is a warning, not a failure", async () => {
  const t = setup();
  const stranger = path.join(t.logRoot, "w9.Other", "moolin.log");
  fs.mkdirSync(path.dirname(stranger), { recursive: true });
  fs.writeFileSync(stranger, "MOOLIN-LOG 1 encrypted 0123456789abcdef\nAAAA\n");
  const outcome = await t.make().enable(phrase("a"), "phrase");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.warnings?.length, 1);
  assert.match(outcome.warnings?.[0] ?? "", /different key/);
});
