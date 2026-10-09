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

// --- Pueblo -------------------------------------------------------------

const GREETING = "This world is Pueblo 1.0 Enhanced.\r\n";

function pueblo(): LineStream {
  const s = new LineStream();
  s.write(GREETING, 1);
  return s;
}

const links = (s: LineStream) =>
  s.lines.flatMap((l) => (l.runs ?? []).filter((r) => r.link).map((r) => [r.text, r.link?.cmd, r.link?.href]));

test("until the greeting, tags are text", () => {
  const s = new LineStream();
  s.write("<b>hi</b> <br>\r\n", 1);
  assert.deepEqual(view(s), [["<b>hi</b> <br>", 1]]);
});

test("after the greeting, tags are read: links, dropped tags, entities", () => {
  const s = pueblo();
  s.write(
    'Exits: <a xch_cmd="north|n">north</a> <font color=red>x</font> &lt;ok&gt; <a href="https://e.com">site</a>\r\n',
    2,
  );
  assert.equal(s.lines[1].text, "Exits: north x <ok> site");
  assert.deepEqual(links(s), [
    ["north", "north|n", null],
    ["site", null, "https://e.com"],
  ]);
});

test("a link ends at the end of its line", () => {
  const s = pueblo();
  s.write("<send>look\r\nplain\r\n", 2);
  assert.deepEqual(links(s), [["look", "", null]]);
});

test("<br> breaks the line, and the line feed after it is swallowed without losing a time", () => {
  const s = pueblo();
  s.write("one<br>\r\ntwo<br>\r\nthree\r\n", 5);
  assert.deepEqual(view(s).slice(1), [
    ["one", 5],
    ["two", 5],
    ["three", 5],
  ]);
});

test("each line feed takes its own time, <br> or not", () => {
  const s = new LineStream();
  s.replay([`${GREETING}a<br>\r\nb\r\nc<br>\r\n`], [1, 2, 3, 4], true);
  // The greeting's line feed took 1, then each of the three after it one more.
  assert.deepEqual(view(s), [
    ["This world is Pueblo 1.0 Enhanced.", 1],
    ["a", 2],
    ["b", 3],
    ["c", 4],
  ]);
});

test("Moolin's own lines are never read as Pueblo", () => {
  const s = pueblo();
  s.write("\x1b[36msay <b>hi</b> <br>\x1b[0m\r\n", null);
  s.write("<b>hi</b>\r\n", 2);
  assert.deepEqual(view(s).slice(1), [
    ["say <b>hi</b> <br>", null],
    ["hi", 2],
  ]);
});

test("a server's clear waits for something to show, then adds the blank screen once", () => {
  const s = pueblo();
  s.screenRows = 3;
  s.write('<xch_page clear="text"><xch_page clear="text">\r\n', 2);
  assert.equal(s.lines.length, 1 + 1); // only the line feed, so far
  s.write("hello\r\n", 3);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["This world is Pueblo 1.0 Enhanced.", "", "", "", "", "hello"],
  );
});

test("a server's clear is applied before the first text after it, in the same chunk", () => {
  const s = pueblo();
  s.screenRows = 2;
  s.write('old\r\n<xch_page clear="text">new\r\n', 2);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["This world is Pueblo 1.0 Enhanced.", "old", "", "", "new"],
  );
});

test("a server's clear at the end of a session leaves the last screen alone", () => {
  const s = pueblo();
  s.screenRows = 3;
  s.write("last screen\r\n</xch_mudtext><img xch_mode=purehtml><xch_page clear=text>\r\n", 2);
  s.write("\x1b[33m[disconnected]\x1b[0m\r\n", null);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["This world is Pueblo 1.0 Enhanced.", "last screen", "", "[disconnected]"],
  );
});

test("a server's clear is forgotten by a reset", () => {
  const s = pueblo();
  s.write("<xch_page clear=text>", 2);
  s.reset();
  s.write("plain\r\n", 3);
  assert.deepEqual(view(s), [["plain", 3]]);
});

test("a replay reads tags from the start when told the connection is in Pueblo mode", () => {
  const s = new LineStream();
  s.replay(['<a xch_cmd="x">link</a><br>\r\nplain\r\n'], [1, 2], true);
  assert.deepEqual(links(s), [["link", "x", null]]);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["link", "plain"],
  );
});

test("a replay not in Pueblo mode, and with no greeting, shows tags as written", () => {
  const s = new LineStream();
  s.replay(['<a xch_cmd="x">link</a>\r\n'], [1], false);
  assert.deepEqual(view(s), [['<a xch_cmd="x">link</a>', 1]]);
});

test("a replay containing the greeting reads tags only after it", () => {
  const s = new LineStream();
  s.replay([`<b>before</b>\r\n${GREETING}<b>after</b>\r\n`], [1, 2, 3], true);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["<b>before</b>", "This world is Pueblo 1.0 Enhanced.", "after"],
  );
});

test("live output after a replay continues in the mode the replay ended in", () => {
  const s = new LineStream();
  s.replay(["old\r\n"], [1], true);
  s.write("<br>new\r\n", 2);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["old", "", "new"],
  );
});

test("reset leaves Pueblo mode", () => {
  const s = pueblo();
  s.reset();
  s.write("<br>\r\n", 2);
  assert.deepEqual(view(s), [["<br>", 2]]);
});

test("a greeting split across chunks still turns Pueblo on", () => {
  const s = new LineStream();
  s.write("This world is Pue", 1);
  s.write("blo\r\n<br>x\r\n", 1);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["This world is Pueblo", "", "x"],
  );
});

test("the stream says what it decides that could explain odd output", () => {
  const notes: string[] = [];
  const s = new LineStream((message) => notes.push(message));
  s.screenRows = 4;
  s.write("hello\r\n", 1);
  s.write("This world is Pueblo\r\n<font>x</font> <odd>\r\n", 2);
  s.write('<xch_page clear="text"><xch_page clear="text">more\r\n', 3);
  assert.deepEqual(notes, [
    "pueblo: the server's greeting was seen, so its tags are now read",
    "pueblo: <font> is not supported, so it is dropped (its content is still shown)",
    "pueblo: <odd> is not a Pueblo or HTML tag, so it is shown as text",
    "pueblo: the server asked to clear the screen; it will when more output follows",
    "pueblo: the server asked to clear the screen; it will when more output follows",
    "pueblo: cleared the screen for the server (4 blank lines added)",
  ]);
});

test("once the greeting is closed, the words are only text, and tags stay as written", () => {
  const s = new LineStream();
  s.write("welcome\r\n", 1);
  s.closeGreeting();
  s.write(`${GREETING}<a xch_cmd="x">link</a>\r\n`, 2);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["welcome", "This world is Pueblo 1.0 Enhanced.", '<a xch_cmd="x">link</a>'],
  );
});

test("a replay of a connection that isn't in Pueblo mode ignores a greeting once closed, but not while open", () => {
  const history = [`${GREETING}<b>x</b>\r\n`];
  const closed = new LineStream();
  closed.replay(history, [1, 2], false, false);
  assert.equal(closed.lines[1].text, "<b>x</b>");
  const open = new LineStream();
  open.replay(history, [1, 2], false, true);
  assert.equal(open.lines[1].text, "x");
});

test("a replay of a Pueblo connection still finds the greeting that turned it on, and carries on closed", () => {
  const s = new LineStream();
  s.replay([`<b>before</b>\r\n${GREETING}<b>after</b>\r\n`], [1, 2, 3], true, false);
  assert.deepEqual(
    s.lines.map((l) => l.text),
    ["<b>before</b>", "This world is Pueblo 1.0 Enhanced.", "after"],
  );
  s.write("<b>live</b>\r\n", 4);
  assert.equal(s.lines[3].text, "live", "tags are still read; only a new greeting is ignored");
});
