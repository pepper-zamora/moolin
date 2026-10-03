import { test } from "node:test";
import assert from "node:assert/strict";
import { ScrollbackBuffer } from "./scrollback-buffer";

test("keeps everything while under the limit", () => {
  const buffer = new ScrollbackBuffer(100);
  buffer.append("hello ");
  buffer.append(new Uint8Array([119, 111, 114, 108, 100]));
  assert.deepEqual(buffer.snapshot(), ["hello ", new Uint8Array([119, 111, 114, 108, 100])]);
});

test("drops the oldest whole chunks once over the limit", () => {
  const buffer = new ScrollbackBuffer(10);
  buffer.append("aaaa");
  buffer.append("bbbb");
  buffer.append("cccc");
  assert.deepEqual(buffer.snapshot(), ["bbbb", "cccc"]);
});

test("measures strings in UTF-8 bytes, not characters", () => {
  const buffer = new ScrollbackBuffer(6);
  buffer.append("é"); // 2 bytes
  buffer.append("€€"); // 6 bytes
  assert.deepEqual(buffer.snapshot(), ["€€"]);
});

test("a single chunk larger than the limit is not kept", () => {
  const buffer = new ScrollbackBuffer(3);
  buffer.append("toolong");
  assert.deepEqual(buffer.snapshot(), []);
});

test("snapshot is a copy, unaffected by later appends", () => {
  const buffer = new ScrollbackBuffer(100);
  buffer.append("a");
  const snapshot = buffer.snapshot();
  buffer.append("b");
  assert.deepEqual(snapshot, ["a"]);
});

test("records one line time per newline, in order", () => {
  const buffer = new ScrollbackBuffer(100);
  buffer.append("one\ntwo\n", 1000);
  buffer.append("no newline here", 1500);
  buffer.append("three\n", 2000);
  assert.deepEqual(buffer.snapshotTimes(), [1000, 1000, 2000]);
});

test("drops line times along with the chunks they belong to", () => {
  const buffer = new ScrollbackBuffer(10);
  buffer.append("aaaa\n", 1); // 5 bytes
  buffer.append("bbbb\n", 2); // 5 bytes, still within 10
  buffer.append("cccc\n", 3); // pushes over 10, drops the first chunk
  assert.deepEqual(buffer.snapshot(), ["bbbb\n", "cccc\n"]);
  assert.deepEqual(buffer.snapshotTimes(), [2, 3]);
});

test("reset forgets line times, since history has no known times", () => {
  const buffer = new ScrollbackBuffer(100);
  buffer.append("live\n", 1);
  buffer.reset(["old\nhistory\n"]);
  assert.deepEqual(buffer.snapshotTimes(), [null, null]);
});

test("reset applies provided line times, one per newline", () => {
  const buffer = new ScrollbackBuffer(100);
  buffer.reset(["a\nb\nc\n"], [111, 222, 333]);
  assert.deepEqual(buffer.snapshotTimes(), [111, 222, 333]);
});
