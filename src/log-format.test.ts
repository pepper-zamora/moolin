import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEnvelope, normalizePhrase } from "./crypto-keys";
import {
  LEGACY_TIMES_SUFFIX,
  PLAIN,
  WrongLogKeyError,
  convertLog,
  decodeRecord,
  encodeRecord,
  formatOf,
  headerFor,
  inspectLog,
  parseHeader,
  prepareForAppend,
  readLogHistory,
  type LogMode,
} from "./log-format";
import { SessionLogRegistry } from "./session-log";

const CHEAP = { N: 1 << 14, r: 8, p: 1 };

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moolin-logfmt-")), "moolin.log");
}

async function encryptedMode(phrase = "x"): Promise<LogMode & { kind: "encrypted" }> {
  const { dataKey } = await createEnvelope(normalizePhrase(phrase), "phrase", CHEAP);
  return { kind: "encrypted", dataKey };
}

// Writes `appends` through a SessionLog in `mode`.
function writeLog(file: string, mode: LogMode, appends: Array<[string | Uint8Array, number | null]>): void {
  const log = new SessionLogRegistry(undefined, () => mode).claim(file, () => file);
  assert.ok(log);
  log.history(1);
  for (const [data, time] of appends) log.append(data, time);
  log.close();
}

const text = (history: { bytes: Uint8Array }): string => Buffer.from(history.bytes).toString();

test("headers say what the file is, and nothing else is a header", () => {
  assert.equal(headerFor({ kind: "plain" }), "MOOLIN-LOG 1 plain");
  assert.deepEqual(parseHeader("MOOLIN-LOG 1 plain"), { kind: "plain" });
  assert.deepEqual(parseHeader("MOOLIN-LOG 1 encrypted 0123456789abcdef"), {
    kind: "encrypted",
    keyId: "0123456789abcdef",
  });
  for (const bad of ["", "MOOLIN-LOG 2 plain", "MOOLIN-LOG 1 encrypted xyz", "MOOLIN-LOG 1 plain ", "hello"]) {
    assert.equal(parseHeader(bad), null, bad);
  }
});

test("a record reads back, with its times, in both modes", async () => {
  const data = Buffer.from("one\r\ntwo\r\n\x1b[31mred");
  const times = [1000, null];
  for (const mode of [PLAIN, await encryptedMode()]) {
    const header = headerFor(formatOf(mode));
    const line = encodeRecord(mode, header, data, times);
    assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1, "one line");
    const record = decodeRecord(line.trimEnd(), mode, header);
    assert.equal(record.data.toString(), data.toString());
    assert.deepEqual(record.times, times);
  }
});

test("an encrypted record shows nothing of what it holds, and can't be moved or altered", async () => {
  const mode = await encryptedMode();
  const other = await encryptedMode("y");
  const header = headerFor(formatOf(mode));
  const line = encodeRecord(mode, header, Buffer.from("hunter2 is my password\n"), [1]).trimEnd();
  assert.equal(Buffer.from(line, "base64").includes(Buffer.from("hunter2")), false);
  assert.throws(() => decodeRecord(line, other, header), "another key");
  assert.throws(() => decodeRecord(line, mode, headerFor(formatOf(other))), "another file's header");
  assert.throws(() => decodeRecord(line, PLAIN, "MOOLIN-LOG 1 plain"), "another mode");
  const bytes = Buffer.from(line, "base64");
  bytes[20] ^= 1;
  assert.throws(() => decodeRecord(bytes.toString("base64"), mode, header), "an altered byte");
  assert.throws(() => decodeRecord("not base64!", PLAIN, "h"));
});

test("a log is printable text however hostile the server's output, in both modes", async () => {
  const nasty = Buffer.concat([
    Buffer.from([0x1b, 0x5d, 0x30, 0x3b, 0x07, 0x9b, 0x00, 0xff, 0x0d, 0x08]),
    Buffer.from("\x1b[2J\x1b[H"),
  ]);
  for (const mode of [PLAIN, await encryptedMode()]) {
    const file = tempFile();
    writeLog(file, mode, [
      [nasty, 1],
      ["plain text\r\n", 2],
    ]);
    const content = fs.readFileSync(file);
    for (const byte of content) {
      assert.ok(byte === 0x0a || (byte >= 0x20 && byte < 0x7f), `byte ${byte} in a ${mode.kind} log`);
    }
    assert.ok(content.toString().startsWith("MOOLIN-LOG 1 "));
  }
});

test("history keeps the newest bytes from a line boundary, with the times that go with them", async () => {
  for (const mode of [PLAIN, await encryptedMode()]) {
    const file = tempFile();
    writeLog(file, mode, [
      ["aaaa\r\n", 1],
      ["bbbb\r\n", 2],
      ["cccc\r\n", 3],
    ]);
    const all = readLogHistory(file, mode, 1000);
    assert.equal(text(all), "aaaa\r\nbbbb\r\ncccc\r\n");
    assert.deepEqual(all.times, [1, 2, 3]);
    const tail = readLogHistory(file, mode, 14);
    assert.equal(text(tail), "bbbb\r\ncccc\r\n");
    assert.deepEqual(tail.times, [2, 3]);
    assert.equal(text(readLogHistory(file, mode, 3)), "", "no line boundary within reach");
  }
});

test("history of a long log reads only what it needs, but all of that", () => {
  const file = tempFile();
  const lines = Array.from({ length: 30000 }, (_, i) => [`line number ${i} of a long log\r\n`, i] as [string, number]);
  writeLog(file, PLAIN, lines);
  const history = readLogHistory(file, PLAIN, 100_000);
  const got = text(history).split("\r\n").filter(Boolean);
  assert.ok(got.length > 2000 && got.length < 4000, `${got.length} lines`);
  assert.equal(got[got.length - 1], "line number 29999 of a long log");
  assert.equal(history.times.length, got.length);
  assert.equal(history.times[history.times.length - 1], 29999);
});

test("missing, empty and header-only logs have no history", () => {
  const file = tempFile();
  assert.equal(readLogHistory(file, PLAIN, 100).bytes.length, 0);
  fs.writeFileSync(file, "");
  assert.equal(readLogHistory(file, PLAIN, 100).bytes.length, 0);
  fs.writeFileSync(file, "MOOLIN-LOG 1 plain\n");
  assert.equal(readLogHistory(file, PLAIN, 100).bytes.length, 0);
});

test("a log with a record the app died writing is mended, and later records are intact", async () => {
  for (const mode of [PLAIN, await encryptedMode()]) {
    const file = tempFile();
    writeLog(file, mode, [["one\r\n", 1]]);
    fs.appendFileSync(file, "QUJDREVGR0hJSktM"); // the start of a record, with no newline
    assert.equal(text(readLogHistory(file, mode, 1000)), "one\r\n", "the unfinished line is not read");
    prepareForAppend(file, mode);
    writeLog(file, mode, [["two\r\n", 2]]);
    const history = readLogHistory(file, mode, 1000);
    assert.equal(text(history), "one\r\ntwo\r\n");
    assert.deepEqual(history.times, [1, 2]);
  }
});

test("a damaged record in the middle is skipped, not fatal", () => {
  const file = tempFile();
  writeLog(file, PLAIN, [
    ["one\r\n", 1],
    ["two\r\n", 2],
    ["three\r\n", 3],
  ]);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[2] = "###damaged###";
  fs.writeFileSync(file, lines.join("\n"));
  assert.equal(text(readLogHistory(file, PLAIN, 1000)), "one\r\nthree\r\n");
});

test("a half-written header is as good as no file", () => {
  const file = tempFile();
  fs.writeFileSync(file, "MOOLIN-LO");
  assert.equal(inspectLog(file), "empty");
  prepareForAppend(file, PLAIN);
  assert.equal(fs.readFileSync(file, "utf8"), "MOOLIN-LOG 1 plain\n");
});

test("a log in the other mode, or for another key, is refused rather than read wrongly", async () => {
  const mode = await encryptedMode();
  const other = await encryptedMode("y");
  const file = tempFile();
  writeLog(file, mode, [["secret\r\n", 1]]);
  assert.throws(() => readLogHistory(file, PLAIN, 100), WrongLogKeyError);
  assert.throws(() => readLogHistory(file, other, 100), WrongLogKeyError);
  assert.throws(() => prepareForAppend(file, other), WrongLogKeyError);
  const plainFile = tempFile();
  writeLog(plainFile, PLAIN, [["x\r\n", 1]]);
  assert.throws(() => readLogHistory(plainFile, mode, 100), WrongLogKeyError);
});

test("converting to encrypted and back gives exactly the same bytes and times", async () => {
  const mode = await encryptedMode();
  const file = tempFile();
  const appends: Array<[string, number | null]> = Array.from({ length: 200 }, (_, i) => [
    `line ${i} \x1b[3${i % 8}m colour\r\n`,
    i % 7 === 0 ? null : i,
  ]);
  writeLog(file, PLAIN, appends);
  const before = readLogHistory(file, PLAIN, 10_000_000);

  assert.equal(convertLog(file, mode, null), true);
  assert.deepEqual(inspectLog(file), formatOf(mode));
  assert.equal(fs.readFileSync(file, "utf8").includes("colour"), false);
  const sealed = readLogHistory(file, mode, 10_000_000);
  assert.equal(text(sealed), text(before));
  assert.deepEqual(sealed.times, before.times);

  assert.equal(convertLog(file, mode, mode.dataKey), false, "already there");
  assert.equal(convertLog(file, PLAIN, mode.dataKey), true);
  const back = readLogHistory(file, PLAIN, 10_000_000);
  assert.equal(text(back), text(before));
  assert.deepEqual(back.times, before.times);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["moolin.log"], "no temporary file left");
});

test("a conversion that can't read the log leaves it untouched", async () => {
  const mode = await encryptedMode();
  const file = tempFile();
  writeLog(file, mode, [["secret\r\n", 1]]);
  const before = fs.readFileSync(file);
  assert.throws(() => convertLog(file, PLAIN, null), WrongLogKeyError);
  assert.throws(() => convertLog(file, PLAIN, Buffer.alloc(32, 1)), WrongLogKeyError);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["moolin.log"]);
});

test("a log from before this format is converted, with the times from its file of times", async () => {
  for (const mode of [PLAIN, await encryptedMode()]) {
    const file = tempFile();
    fs.writeFileSync(file, "one\r\ntwo\r\nthree\r\n\x1b[31mred\x1b[0m");
    // Times for the last two line feeds only: the first has none.
    const times = Buffer.alloc(16);
    times.writeDoubleLE(2000, 0);
    times.writeDoubleLE(3000, 8);
    fs.writeFileSync(file + LEGACY_TIMES_SUFFIX, times);
    fs.writeFileSync(`${file}.open`, "{}");

    assert.equal(inspectLog(file), "legacy");
    assert.equal(convertLog(file, mode, null), true);
    const history = readLogHistory(file, mode, 1000);
    assert.equal(text(history), "one\r\ntwo\r\nthree\r\n\x1b[31mred\x1b[0m");
    assert.deepEqual(history.times, [null, 2000, 3000]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["moolin.log"], "its sidecar files are gone");
  }
});

test("a legacy log with no file of times, or an empty one, converts too", () => {
  const file = tempFile();
  fs.writeFileSync(file, "a\nb\n");
  convertLog(file, PLAIN, null);
  assert.deepEqual(readLogHistory(file, PLAIN, 100).times, [null, null]);
  const empty = tempFile();
  fs.writeFileSync(empty, "");
  convertLog(empty, PLAIN, null);
  assert.equal(fs.readFileSync(empty, "utf8"), "MOOLIN-LOG 1 plain\n");
});

test("a large legacy log converts in pieces, losing nothing", () => {
  const file = tempFile();
  const lines = Array.from({ length: 120000 }, (_, i) => `legacy line ${i}\r\n`);
  fs.writeFileSync(file, lines.join(""));
  const times = Buffer.alloc(8 * lines.length);
  for (let i = 0; i < lines.length; i++) times.writeDoubleLE(i, i * 8);
  fs.writeFileSync(file + LEGACY_TIMES_SUFFIX, times);
  convertLog(file, PLAIN, null);
  const history = readLogHistory(file, PLAIN, 100_000_000);
  assert.equal(text(history), lines.join(""));
  assert.equal(history.times.length, lines.length);
  assert.equal(history.times[0], 0);
  assert.equal(history.times[119999], 119999);
});

test("a session log converts an older log when it is first used, and keeps appending to it", () => {
  const file = tempFile();
  fs.writeFileSync(file, "before\r\n");
  writeLog(file, PLAIN, [["after\r\n", 5]]);
  const history = readLogHistory(file, PLAIN, 1000);
  assert.equal(text(history), "before\r\nafter\r\n");
  assert.deepEqual(history.times, [null, 5]);
});
