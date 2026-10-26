import { test } from "node:test";
import assert from "node:assert/strict";
import { AnsiParser, DEFAULT_STYLE } from "./ansi-parser";
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

test("dropped lines are marked, so a view can skip ones it never drew", () => {
  const b = new LineBuilder();
  b.feed(new AnsiParser().parse("a\nb\nc\n"), () => null);
  const [a, bLine] = b.dropFront(2);
  assert.equal(a.dropped, true);
  assert.equal(bLine.dropped, true);
  assert.equal(b.lines[0].dropped, undefined);
  assert.equal(b.dirtyCount, 3);
});

test("a break ends the line with no time, and a swallowed line feed after it supplies one", () => {
  const b = new LineBuilder();
  const parser = new AnsiParser();
  b.feed(parser.parse("one"), () => null);
  b.feed([{ kind: "break" }, { kind: "skip", afterBreak: true }], () => 42);
  b.feed(parser.parse("two\n"), () => 7);
  assert.deepEqual(
    b.lines.map((l) => [l.text, l.time]),
    [
      ["one", 42],
      ["two", 7],
    ],
  );
});

test("a skip takes its time without ending a line, and only stamps after a break", () => {
  const b = new LineBuilder();
  const taken: Array<number | null> = [];
  const times = [1, 2, 3];
  b.feed(parser("a"), () => null);
  b.feed([{ kind: "skip", afterBreak: false }], () => {
    const t = times.shift() ?? null;
    taken.push(t);
    return t;
  });
  assert.deepEqual(taken, [1]);
  assert.equal(b.openLine?.text, "a");
  assert.equal(b.openLine?.time, null);
});

function parser(text: string) {
  return new AnsiParser().parse(text);
}

test("runs merge only when they share a link as well as a style", () => {
  const b = new LineBuilder();
  const link = { id: 1, cmd: "look", href: null };
  const other = { id: 2, cmd: "look", href: null };
  const text = (t: string, l: typeof link | null) => ({
    kind: "text" as const,
    text: t,
    style: DEFAULT_STYLE,
    link: l,
  });
  b.feed([text("a", null), text("b", link), text("c", link), text("d", other)], () => null);
  assert.deepEqual(
    b.lines[0].runs?.map((r) => [r.text, r.link?.id ?? null]),
    [
      ["a", null],
      ["bc", 1],
      ["d", 2],
    ],
  );
});
