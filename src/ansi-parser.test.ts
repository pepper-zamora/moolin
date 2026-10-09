import { test } from "node:test";
import assert from "node:assert/strict";
import { AnsiParser, DEFAULT_STYLE, appearance, type Token } from "./ansi-parser";
import { countLineFeeds } from "./line-feeds";

// Text runs as [text, fg, bg], with "\n" standing for a line break token.
function summarize(tokens: Token[]): Array<[string, number?, number?]> {
  return tokens.map((t) => (t.kind === "newline" ? ["\n"] : [t.text, t.style.fg, t.style.bg]));
}

test("plain text is one run in the default style", () => {
  const tokens = new AnsiParser().parse("hello");
  assert.deepEqual(summarize(tokens), [["hello", -1, -1]]);
  assert.equal((tokens[0] as { style: unknown }).style, DEFAULT_STYLE);
});

test("SGR colours apply to the text after them and reset with 0", () => {
  const out = summarize(new AnsiParser().parse("a\x1b[31mb\x1b[0mc\x1b[1;42md"));
  assert.deepEqual(out, [
    ["a", -1, -1],
    ["b", 1, -1],
    ["c", -1, -1],
    ["d", -1, 2],
  ]);
});

test("an empty SGR is a reset", () => {
  assert.deepEqual(summarize(new AnsiParser().parse("\x1b[32mg\x1b[mn")), [
    ["g", 2, -1],
    ["n", -1, -1],
  ]);
});

test("bright, 256-colour and truecolor forms, semicolon and colon", () => {
  const parse = (s: string) => (new AnsiParser().parse(`${s}x`)[0] as Extract<Token, { kind: "text" }>).style;
  assert.equal(parse("\x1b[91m").fg, 9);
  assert.equal(parse("\x1b[104m").bg, 12);
  assert.equal(parse("\x1b[38;5;9m").fg, 9);
  assert.equal(parse("\x1b[38;5;196m").fg, 0x1000000 | 0xff0000);
  assert.equal(parse("\x1b[38;5;232m").fg, 0x1000000 | 0x080808);
  assert.equal(parse("\x1b[38;2;1;2;3m").fg, 0x1000000 | 0x010203);
  assert.equal(parse("\x1b[48;2;1;2;3m").bg, 0x1000000 | 0x010203);
  assert.equal(parse("\x1b[38:2:1:2:3m").fg, 0x1000000 | 0x010203);
  assert.equal(parse("\x1b[38:2::1:2:3m").fg, 0x1000000 | 0x010203);
  assert.equal(parse("\x1b[38:5:9m").fg, 9);
  assert.equal(parse("\x1b[38;5;9;1m").bold, true);
});

test("attributes turn on and off", () => {
  const p = new AnsiParser();
  const style = () => (p.parse("x").pop() as Extract<Token, { kind: "text" }>).style;
  p.parse("\x1b[1;2;3;4;7;9m");
  assert.deepEqual(
    [style().bold, style().dim, style().italic, style().underline, style().inverse, style().strike],
    [true, true, true, true, true, true],
  );
  p.parse("\x1b[22;23;24;27;29m");
  assert.deepEqual(
    [style().bold, style().dim, style().italic, style().underline, style().inverse, style().strike],
    [false, false, false, false, false, false],
  );
  p.parse("\x1b[4m\x1b[4:0m");
  assert.equal(style().underline, false);
});

test("LF, VT and FF are line breaks and CR is dropped", () => {
  assert.deepEqual(summarize(new AnsiParser().parse("a\r\nb\vc\fd\re")), [
    ["a", -1, -1],
    ["\n"],
    ["b", -1, -1],
    ["\n"],
    ["c", -1, -1],
    ["\n"],
    ["d", -1, -1],
    ["e", -1, -1],
  ]);
});

test("one line break token per byte countLineFeeds counts, whatever surrounds it", () => {
  const input = "a\n\x1b]0;ti\ntle\x07b\x1b[3\n1mc\x0b\x0cd\x1b(\nB";
  const breaks = new AnsiParser().parse(input).filter((t) => t.kind === "newline").length;
  assert.equal(breaks, countLineFeeds(input));
});

test("tab is kept, other controls are dropped", () => {
  assert.deepEqual(summarize(new AnsiParser().parse("a\tb\x07c\x08d\x7fe")), [
    ["a\tb", -1, -1],
    ["c", -1, -1],
    ["d", -1, -1],
    ["e", -1, -1],
  ]);
});

test("non-SGR sequences are consumed without leaking", () => {
  const out = summarize(new AnsiParser().parse("a\x1b[2Jb\x1b[1;1Hc\x1b[?25ld\x1b[>0me\x1bcf\x1b(Bg\x1b7h"));
  assert.deepEqual(
    out.map((r) => r[0]),
    ["a", "b", "c", "d", "e", "f", "g", "h"],
  );
});

test("OSC and other strings are swallowed up to BEL or ST", () => {
  const out = summarize(new AnsiParser().parse("a\x1b]0;window title\x07b\x1b]8;;http://x\x1b\\c\x1bPdata\x1b\\d"));
  assert.deepEqual(
    out.map((r) => r[0]),
    ["a", "b", "c", "d"],
  );
});

test("an unterminated string gives up rather than eating all later output", () => {
  const p = new AnsiParser();
  p.parse(`\x1b]0;${"x".repeat(5000)}`);
  assert.deepEqual(summarize(p.parse("visible")), [["visible", -1, -1]]);
});

test("a sequence split across chunks is held over", () => {
  const p = new AnsiParser();
  assert.deepEqual(summarize(p.parse("a\x1b[3")), [["a", -1, -1]]);
  assert.deepEqual(summarize(p.parse("1mb")), [["b", 1, -1]]);
  assert.deepEqual(summarize(p.parse("c\x1b")), [["c", 1, -1]]);
  assert.deepEqual(summarize(p.parse("[0md")), [["d", -1, -1]]);
  assert.deepEqual(summarize(p.parse("\x1b]0;ti")), []);
  assert.deepEqual(summarize(p.parse("tle\x07e")), [["e", -1, -1]]);
});

test("style persists across chunks", () => {
  const p = new AnsiParser();
  p.parse("\x1b[33m");
  assert.deepEqual(summarize(p.parse("yellow")), [["yellow", 3, -1]]);
});

test("bytes are decoded as a stream, so split UTF-8 comes out whole", () => {
  const bytes = new TextEncoder().encode("héllo €");
  const p = new AnsiParser();
  const text = [p.parse(bytes.slice(0, 2)), p.parse(bytes.slice(2, 9)), p.parse(bytes.slice(9))]
    .flat()
    .map((t) => (t.kind === "text" ? t.text : ""))
    .join("");
  assert.equal(text, "héllo €");
});

test("reset forgets style and half-received sequences", () => {
  const p = new AnsiParser();
  p.parse("\x1b[31m\x1b[3");
  p.reset();
  assert.deepEqual(summarize(p.parse("1mx")), [["1mx", -1, -1]]);
});

test("appearance maps a style to classes and inline css", () => {
  const style = (s: string) => (new AnsiParser().parse(`${s}x`)[0] as Extract<Token, { kind: "text" }>).style;
  assert.deepEqual(appearance(DEFAULT_STYLE), { className: "", css: "" });
  assert.equal(appearance(style("\x1b[31;44m")).className, "f1 b4");
  assert.equal(appearance(style("\x1b[1;31m")).className, "f9 bd");
  assert.equal(appearance(style("\x1b[38;2;255;0;16m")).css, "color:#ff0010;");
  assert.equal(appearance(style("\x1b[4;9;3;2m")).className, "dm it ul st");
});

test("inverse swaps colours, with a default becoming the terminal's opposite", () => {
  const style = (s: string) => (new AnsiParser().parse(`${s}x`)[0] as Extract<Token, { kind: "text" }>).style;
  assert.equal(appearance(style("\x1b[7m")).className, "fbg bfg");
  assert.equal(appearance(style("\x1b[7;31m")).className, "fbg b1");
  assert.equal(appearance(style("\x1b[7;31;42m")).className, "f2 b1");
});
