import { test } from "node:test";
import assert from "node:assert/strict";
import { AnsiParser } from "./ansi-parser";
import { LineBuilder, MAX_LINE_LENGTH } from "./line-builder";

function build(chunks: string[], times: Array<number | null> = []): LineBuilder {
  const parser = new AnsiParser();
  const builder = new LineBuilder();
  let i = 0;
  for (const chunk of chunks) builder.feed(parser.parse(chunk), () => times[i++] ?? null);
  return builder;
}

test("a line is closed by its line feed and carries that line feed's time", () => {
  const b = build(["one\ntwo\n"], [100, 200]);
  assert.deepEqual(
    b.lines.map((l) => [l.text, l.time]),
    [
      ["one", 100],
      ["two", 200],
    ],
  );
  assert.equal(b.openLine, null);
});

test("an unfinished line stays open, unstamped, and continues in the next chunk", () => {
  const b = build(["pro", "mpt> "]);
  assert.equal(b.lines.length, 1);
  assert.equal(b.lines[0].text, "prompt> ");
  assert.equal(b.lines[0].time, null);
  assert.equal(b.openLine, b.lines[0]);
  b.feed(new AnsiParser().parse("\n"), () => 5);
  assert.equal(b.lines[0].time, 5);
  assert.equal(b.openLine, null);
});

test("a bare line feed makes an empty line and consumes a time", () => {
  const b = build(["a\n\nb\n"], [1, 2, 3]);
  assert.deepEqual(
    b.lines.map((l) => [l.text, l.time]),
    [
      ["a", 1],
      ["", 2],
      ["b", 3],
    ],
  );
});

test("adjacent runs of the same style merge, different styles stay apart", () => {
  const b = build(["a\x1b[31mb", "c\x1b[0md"]);
  assert.deepEqual(
    b.lines[0].runs?.map((r) => r.text),
    ["a", "bc", "d"],
  );
  assert.equal(b.lines[0].text, "abcd");
});

test("takeDirty returns each changed line once, in order", () => {
  const parser = new AnsiParser();
  const b = new LineBuilder();
  b.feed(parser.parse("one\ntw"), () => null);
  assert.deepEqual(
    b.takeDirty().map((l) => l.text),
    ["one", "tw"],
  );
  assert.deepEqual(b.takeDirty(), []);
  b.feed(parser.parse("o\nthree"), () => null);
  assert.deepEqual(
    b.takeDirty().map((l) => l.text),
    ["two", "three"],
  );
});

test("blank lines close an open line and then add empty ones, with no time", () => {
  const b = build(["prompt"], []);
  b.blankLines(3);
  assert.deepEqual(
    b.lines.map((l) => [l.text, l.time]),
    [
      ["prompt", null],
      ["", null],
      ["", null],
    ],
  );
});

test("an endless line is cut at the length cap", () => {
  const b = build(["x".repeat(MAX_LINE_LENGTH * 2 + 5)]);
  assert.deepEqual(
    b.lines.map((l) => l.text.length),
    [MAX_LINE_LENGTH, MAX_LINE_LENGTH, 5],
  );
});

test("dropFront removes the oldest lines and forgets an open line it drops", () => {
  const b = build(["a\nb\nc"]);
  assert.deepEqual(
    b.dropFront(2).map((l) => l.text),
    ["a", "b"],
  );
  assert.deepEqual(
    b.lines.map((l) => l.text),
    ["c"],
  );
  assert.equal(b.openLine, b.lines[0]);
  b.dropFront(1);
  assert.equal(b.openLine, null);
});

test("ids are unique and increasing, even across trims", () => {
  const b = build(["a\nb\nc\n"]);
  const ids = b.lines.map((l) => l.id);
  b.dropFront(1);
  b.feed(new AnsiParser().parse("d\n"), () => null);
  assert.ok(b.lines.every((l) => !ids.slice(0, 1).includes(l.id)));
  assert.deepEqual(
    [...b.lines.map((l) => l.id)],
    [...b.lines.map((l) => l.id)].sort((x, y) => x - y),
  );
});
