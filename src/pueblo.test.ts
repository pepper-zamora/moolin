import { test } from "node:test";
import assert from "node:assert/strict";
import { GreetingDetector, PuebloParser, decodeEntities, linkCommands, type PuebloToken } from "./pueblo";

function enabled(): PuebloParser {
  const parser = new PuebloParser();
  parser.setEnabled(true);
  return parser;
}

const text = (t: string): PuebloToken => ({ kind: "text", text: t });

test("the greeting is found, whole or split across chunks", () => {
  const detector = new GreetingDetector();
  assert.equal(detector.feed("welcome\r\n"), -1);
  assert.equal(detector.feed("This world is Pueblo 1.0 Enhanced.\r\nrest"), "This world is Pueblo".length);
  const split = new GreetingDetector();
  assert.equal(split.feed("This world is Pue"), -1);
  assert.equal(split.feed("blo!"), "blo".length);
  assert.equal(new GreetingDetector().feed("this WORLD is pueblo"), 20);
});

test("test() looks without remembering", () => {
  const detector = new GreetingDetector();
  assert.equal(detector.test("This world is Pueblo"), true);
  assert.equal(detector.test("nothing"), false);
  detector.feed("This world is Pue");
  assert.equal(detector.test("blo"), true);
});

test("until the greeting, text is untouched, tags and all", () => {
  const parser = new PuebloParser();
  assert.deepEqual(parser.parse("<b>hi</b> <br>\n"), [text("<b>hi</b> <br>\n")]);
  assert.equal(parser.enabled, false);
});

test("the greeting turns Pueblo on, and what follows it in the same chunk is parsed", () => {
  const parser = new PuebloParser();
  assert.deepEqual(parser.parse("This world is Pueblo 1.0<br>after"), [
    text("This world is Pueblo"),
    text(" 1.0"),
    { kind: "break" },
    text("after"),
  ]);
  assert.equal(parser.enabled, true);
});

test("a break, and the line feed after it is swallowed rather than a second break", () => {
  assert.deepEqual(enabled().parse("one<br>\r\ntwo\r\n"), [
    text("one"),
    { kind: "break" },
    { kind: "skip", afterBreak: true },
    text("two\r\n"),
  ]);
});

test("a line feed after a <br> in the next chunk is still swallowed", () => {
  const parser = enabled();
  assert.deepEqual(parser.parse("one<br>"), [text("one"), { kind: "break" }]);
  assert.deepEqual(parser.parse("\ntwo"), [{ kind: "skip", afterBreak: true }, text("two")]);
});

test("only the first line feed after a <br> is swallowed", () => {
  assert.deepEqual(enabled().parse("<br>\n\nx"), [{ kind: "break" }, { kind: "skip", afterBreak: true }, text("\nx")]);
});

test("a line feed not directly after a <br> is kept", () => {
  assert.deepEqual(enabled().parse("<br>x\n"), [{ kind: "break" }, text("x\n")]);
});

test("xch_page clear=text clears, other values don't", () => {
  assert.deepEqual(enabled().parse('<xch_page clear="text">hi'), [{ kind: "clear" }, text("hi")]);
  assert.deepEqual(enabled().parse("<XCH_PAGE CLEAR=text>"), [{ kind: "clear" }]);
  assert.deepEqual(enabled().parse("<xch_page clear=links>"), []);
});

test("links: command, address, bare send, and the closing tags", () => {
  const out = enabled().parse(
    '<a xch_cmd="look|inv">go</a> <a href="http://x.org">web</a> <send>north</send> <send href="say hi">s</send>',
  );
  const links = out.flatMap((t) => (t.kind === "link" ? [t.link] : []));
  assert.deepEqual(
    links.map((l) => (l ? [l.cmd, l.href] : null)),
    [["look|inv", null], null, [null, "http://x.org"], null, ["", null], null, ["say hi", null], null],
  );
  assert.equal(new Set(links.filter(Boolean).map((l) => l?.id)).size, 4);
});

test("an anchor with nothing to click opens no link", () => {
  assert.deepEqual(enabled().parse('<a name="top">x</a>'), [
    { kind: "link", link: null },
    text("x"),
    { kind: "link", link: null },
  ]);
});

test("unknown tags are dropped and their content kept", () => {
  assert.deepEqual(enabled().parse("<xch_mudtext><font color=red>hi</font><img src=x.png></xch_mudtext>"), [
    text("hi"),
  ]);
});

test("a tag split across chunks is held until it is whole", () => {
  const parser = enabled();
  assert.deepEqual(parser.parse("a<a xch_c"), [text("a")]);
  assert.deepEqual(parser.parse('md="x">b'), [{ kind: "link", link: { id: 1, cmd: "x", href: null } }, text("b")]);
});

test("a stray < is text, and does not hold back the rest", () => {
  assert.deepEqual(enabled().parse("3 < 5\n"), [text("3 < 5\n")]);
  assert.deepEqual(enabled().parse("a <3 b"), [text("a <3 b")]);
});

test("a tag that never closes stops being held", () => {
  const parser = enabled();
  assert.deepEqual(parser.parse(`<a ${"x".repeat(5000)}`), [text(`<a ${"x".repeat(5000)}`)]);
});

test("tags never contain a line feed, so text around one stays whole", () => {
  assert.deepEqual(enabled().parse("<a\nxch_cmd=x>"), [text("<a\nxch_cmd=x>")]);
});

test("reset turns Pueblo off; setEnabled sets it directly", () => {
  const parser = enabled();
  parser.reset();
  assert.equal(parser.enabled, false);
  assert.deepEqual(parser.parse("<br>"), [text("<br>")]);
});

test("entities are decoded, but never into a control character", () => {
  assert.equal(decodeEntities("a &lt;b&gt; &amp; &quot;c&quot; d&nbsp;e"), 'a <b> & "c" d e');
  assert.equal(decodeEntities("&#65;&#x42;&#128512;"), "AB😀");
  assert.equal(decodeEntities("x&#10;y&#27;z&#x0b;"), "xyz");
  assert.equal(decodeEntities("&unknown; & &#xD800;"), "&unknown; & ");
  assert.deepEqual(enabled().parse("a&#10;b"), [text("ab")]);
});

test("link commands: several, bare, and with control characters removed", () => {
  assert.deepEqual(linkCommands("look| inv |", "ignored"), ["look", "inv"]);
  assert.deepEqual(linkCommands("", "north"), ["north"]);
  assert.deepEqual(linkCommands("say hi\nquit", ""), ["say hiquit"]);
  assert.deepEqual(linkCommands("", ""), []);
});

test("text that only looks like a tag is shown as sent, not dropped", () => {
  assert.deepEqual(enabled().parse("Use create <name> <password> to start\n"), [
    text("Use create <name> <password> to start\n"),
  ]);
  assert.deepEqual(enabled().parse("Out <O>  \n"), [text("Out <O>  \n")]);
  assert.deepEqual(enabled().parse("a</nothing>b"), [text("a</nothing>b")]);
});

test("a real tag between look-alikes is still read", () => {
  assert.deepEqual(enabled().parse("<name><br>x"), [text("<name>"), { kind: "break" }, text("x")]);
});

test("tags that aren't acted on are reported once each, by name", () => {
  const notes: string[] = [];
  const parser = new PuebloParser((message) => notes.push(message));
  parser.setEnabled(true);
  parser.parse("<font>a</font><font>b</font><img src=x><name><name><br><a>");
  assert.deepEqual(notes, [
    "<font> is not supported, so it is dropped (its content is still shown)",
    "<img> is not supported, so it is dropped (its content is still shown)",
    "<name> is not a Pueblo or HTML tag, so it is shown as text",
  ]);
});

test("the tag names remembered for reporting are bounded", () => {
  const notes: string[] = [];
  const parser = new PuebloParser((message) => notes.push(message));
  parser.setEnabled(true);
  for (let i = 0; i < 1000; i++) parser.parse(`<xch_made_up${i}>x`);
  assert.ok(notes.length <= 200, `${notes.length} notes`);
});

test("a server's own xch_ tags are known, whatever follows the prefix", () => {
  assert.deepEqual(enabled().parse("<xch_mudtext><xch_whatever>x"), [text("x")]);
});

test("the end of a session as a real server sends it: mode switch and clear, no stray text", () => {
  assert.deepEqual(enabled().parse("</xch_mudtext><img xch_mode=purehtml><xch_page clear=text>\n"), [
    { kind: "clear" },
    text("\n"),
  ]);
});
