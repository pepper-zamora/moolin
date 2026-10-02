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
