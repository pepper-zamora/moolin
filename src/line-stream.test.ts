import { test } from "node:test";
import assert from "node:assert/strict";
import { LineStream } from "./line-stream";

const view = (stream: LineStream) => stream.lines.map((l) => [l.text, l.time]);

test("output becomes lines, each with the time of the chunk that ended it", () => {
  const s = new LineStream();
  s.write("one\r\ntwo", 10);
  s.write("\r\nthree\r\n", 20);
  assert.deepEqual(view(s), [
    ["one", 10],
    ["two", 20],
    ["three", 20],
  ]);
});

test("Moolin's own output carries no time", () => {
  const s = new LineStream();
  s.write("server\r\n", 5);
  s.write("\x1b[36mlook\x1b[0m\r\n", null);
  assert.deepEqual(view(s), [
    ["server", 5],
    ["look", null],
  ]);
});

test("a replay gives each line feed its listed time, across chunks, and null past the end", () => {
  const s = new LineStream();
  s.replay(["a\nb", "\nc\nd\n"], [1, 2, 3]);
  assert.deepEqual(view(s), [
    ["a", 1],
    ["b", 2],
    ["c", 3],
    ["d", null],
  ]);
});

test("bytes are decoded as a stream across chunks", () => {
  const bytes = new TextEncoder().encode("héllo\n");
  const s = new LineStream();
  s.write(bytes.slice(0, 2), 1);
  s.write(bytes.slice(2), 1);
  assert.deepEqual(view(s), [["héllo", 1]]);
});

test("reset drops the lines and any half-received sequence", () => {
  const s = new LineStream();
  s.write("old\n\x1b[3", 1);
  s.reset();
  s.write("1mx\n", 2);
  assert.deepEqual(view(s), [["1mx", 2]]);
});

test("blankScreen adds a screenful of untimed blank lines, once", () => {
  const s = new LineStream();
  s.write("before\r\n", 1);
  assert.equal(s.blankScreen(3), true);
  assert.equal(s.blankScreen(3), false);
  assert.deepEqual(view(s), [
    ["before", 1],
    ["", null],
    ["", null],
    ["", null],
  ]);
});

test("blankScreen closes an unfinished line first, and always adds at least one line", () => {
  const s = new LineStream();
  s.write("prompt> ", 1);
  s.blankScreen(0);
  assert.deepEqual(view(s), [["prompt> ", null]]);
});

test("new output un-clears, so the next blankScreen adds again", () => {
  const s = new LineStream();
  s.blankScreen(2);
  s.write("hello\r\n", 1);
  assert.equal(s.blankScreen(2), true);
  assert.equal(s.lines.length, 5);
});

test("output with no visible effect does not un-clear", () => {
  const s = new LineStream();
  s.blankScreen(2);
  s.write("\x1b[2J", 1);
  s.write("", 1);
  assert.equal(s.blankScreen(2), false);
});

test("takeDirty and dropFront pass through to the builder", () => {
  const s = new LineStream();
  s.write("a\nb\nc", 1);
  assert.equal(s.dirtyCount, 3);
  assert.deepEqual(
    s.takeDirty().map((l) => l.text),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    s.dropFront(2).map((l) => l.text),
    ["a", "b"],
  );
  assert.equal(s.openLine?.text, "c");
});
