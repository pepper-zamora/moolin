import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEnvelope, normalizePhrase } from "./crypto-keys";
import { convertAllLogs, findLogs } from "./log-convert";
import { PLAIN, inspectLog, readLogHistory, formatOf, type LogMode } from "./log-format";
import { SessionLogRegistry } from "./session-log";

const CHEAP = { N: 1 << 14, r: 8, p: 1 };
const text = (history: { bytes: Uint8Array }): string => Buffer.from(history.bytes).toString();

async function encryptedMode(phrase = "x"): Promise<LogMode & { kind: "encrypted" }> {
  const { dataKey } = await createEnvelope(normalizePhrase(phrase), "phrase", CHEAP);
  return { kind: "encrypted", dataKey };
}

function writeLog(file: string, mode: LogMode, body: string): void {
  const log = new SessionLogRegistry(undefined, () => mode).claim(file, () => file);
  assert.ok(log);
  log.history(1);
  log.append(body, 1);
  log.close();
}

// <root>/w1/moolin.log, <root>/w1/c1/moolin.log, <root>/w2/c2/moolin.log
function tree(): { root: string; files: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-convert-"));
  const files = [
    path.join(root, "w1", "moolin.log"),
    path.join(root, "w1", "c1", "moolin.log"),
    path.join(root, "w2", "c2", "moolin.log"),
  ];
  for (const file of files) fs.mkdirSync(path.dirname(file), { recursive: true });
  return { root, files };
}

test("logs are found at the depths they live, and nothing else", () => {
  const { root, files } = tree();
  for (const file of files) fs.writeFileSync(file, "");
  fs.writeFileSync(path.join(root, "moolin.log"), ""); // loose in the root: found too
  fs.writeFileSync(path.join(root, "w1", "notes.txt"), "");
  fs.mkdirSync(path.join(root, "w1", "c1", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(root, "w1", "c1", "deeper", "moolin.log"), "");
  assert.deepEqual(findLogs(root), [path.join(root, "moolin.log"), ...files].sort());
  assert.deepEqual(findLogs(path.join(root, "nonexistent")), []);
});

test("every log is converted to encrypted and back, and what each held comes back", async () => {
  const mode = await encryptedMode();
  const { root, files } = tree();
  for (const [i, file] of files.entries()) writeLog(file, PLAIN, `log ${i}\r\n`);
  const registry = new SessionLogRegistry();
  const progress: Array<[number, number]> = [];

  const sealed = await convertAllLogs(root, mode, null, registry, (done, total) => progress.push([done, total]));
  assert.deepEqual({ ...sealed, failed: sealed.failed.length }, { converted: 3, unchanged: 0, failed: 0 });
  assert.deepEqual(progress, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  for (const file of files) assert.deepEqual(inspectLog(file), formatOf(mode));
  assert.equal(text(readLogHistory(files[1], mode, 1000)), "log 1\r\n");

  const again = await convertAllLogs(root, mode, null, registry);
  assert.equal(again.converted, 0);
  assert.equal(again.unchanged, 3);

  const plain = await convertAllLogs(root, PLAIN, mode.dataKey, registry);
  assert.equal(plain.converted, 3);
  for (const [i, file] of files.entries()) assert.equal(text(readLogHistory(file, PLAIN, 1000)), `log ${i}\r\n`);
});

test("a conversion that was stopped part-way is finished by running it again", async () => {
  const mode = await encryptedMode();
  const { root, files } = tree();
  for (const [i, file] of files.entries()) writeLog(file, PLAIN, `log ${i}\r\n`);
  const registry = new SessionLogRegistry();
  // As if the app was stopped after the first log, mid-way through the second.
  await convertAllLogs(path.dirname(files[0]), mode, null, registry);
  fs.writeFileSync(`${files[1]}.convert-123`, "half a temporary fil");
  assert.deepEqual(inspectLog(files[0]), formatOf(mode));
  assert.deepEqual(inspectLog(files[2]), { kind: "plain" });

  const summary = await convertAllLogs(root, mode, null, registry);
  assert.equal(summary.failed.length, 0);
  for (const file of files) assert.deepEqual(inspectLog(file), formatOf(mode));
  assert.deepEqual(fs.readdirSync(path.dirname(files[1])).sort(), ["moolin.log"], "the stray file is gone");
  for (const [i, file] of files.entries()) assert.equal(text(readLogHistory(file, mode, 1000)), `log ${i}\r\n`);
});

test("a log that can't be converted is reported and left alone, and the rest are done", async () => {
  const mine = await encryptedMode();
  const theirs = await encryptedMode("another");
  const { root, files } = tree();
  writeLog(files[0], PLAIN, "plain\r\n");
  writeLog(files[1], theirs, "theirs\r\n");
  writeLog(files[2], PLAIN, "plain too\r\n");
  const before = fs.readFileSync(files[1]);

  const summary = await convertAllLogs(root, mine, mine.dataKey, new SessionLogRegistry());
  assert.equal(summary.converted, 2);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].file, files[1]);
  assert.match(summary.failed[0].error, /different key/);
  assert.deepEqual(fs.readFileSync(files[1]), before);
});

test("nothing is converted while a window is writing a log", async () => {
  const { root, files } = tree();
  const registry = new SessionLogRegistry();
  const open = registry.claim("w1", () => files[0]);
  assert.ok(open);
  await assert.rejects(convertAllLogs(root, PLAIN, null, registry), /Disconnect every window/);
  open.close();
  await convertAllLogs(root, PLAIN, null, registry);
});

test("a window that connects while logs are being converted stops the conversion", async () => {
  const mode = await encryptedMode();
  const { root, files } = tree();
  for (const [i, file] of files.entries()) writeLog(file, PLAIN, `log ${i}\r\n`);
  const registry = new SessionLogRegistry();
  const claimed: Array<NonNullable<ReturnType<SessionLogRegistry["claim"]>>> = [];
  await assert.rejects(
    convertAllLogs(root, mode, null, registry, (done) => {
      const log = done === 1 ? registry.claim("w", () => files[2]) : null;
      if (log) claimed.push(log);
    }),
    /connected while/,
  );
  for (const log of claimed) log.close();
  assert.deepEqual(inspectLog(files[2]), { kind: "plain" }, "the later logs were left alone");
});
