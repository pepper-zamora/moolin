import { test } from "node:test";
import assert from "node:assert/strict";
import { RawLineAccumulator } from "./raw-line-tracker";

test("a plain line with no control/escape content passes through unchanged", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("hello world\n"), ["hello world"]);
});

test("ANSI SGR sequences are stripped while the visible text survives", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("\x1b[31mHello\x1b[0m world\n"), ["Hello world"]);
});

test("TAB is preserved literally in the output line", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("a\tb\n"), ["a\tb"]);
});

test("CR is dropped; a CRLF-terminated line has no trailing \\r", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("line\r\n"), ["line"]);
});

test("multiple lines in a single chunk each produce their own entry", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("one\ntwo\nthree\n"), ["one", "two", "three"]);
});

test("a line split across two push() calls reassembles correctly", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("Hello"), [], "nothing completes until a line feed arrives");
  assert.deepEqual(a.push("World\n"), ["HelloWorld"]);
});

test("an escape sequence split across two push() calls is reassembled before being stripped", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("\x1b[3"), []); // incomplete CSI — held, nothing completed
  assert.deepEqual(a.push("1mHello\n"), ["Hello"]);
});

test("an escape sequence that never finds its terminator is abandoned, dropping only the lone ESC byte", () => {
  // An unterminated CSI: "[" followed by parameter-range bytes that never
  // reach a final byte (0x40-0x7e) within MAX_ESCAPE_LENGTH, so scanEscape
  // gives up on it. Unlike WordWrapper (which re-emits the abandoned ESC as
  // an inert visible byte, to keep wrap-on/wrap-off display identical), this
  // module's job is matching the plain text getSelection() already
  // produces, and a bare ESC was never a copyable glyph — so only the ESC
  // itself is dropped here; everything after it (including the "[", never
  // actually consumed as part of an escape sequence) is ordinary text.
  const a = new RawLineAccumulator();
  const input = `\x1b[${"5".repeat(70)}\n`;
  assert.deepEqual(a.push(input), [`[${"5".repeat(70)}`]);
});

test("VT and FF each end a line, same as LF", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("one\vtwo\fthree\n"), ["one", "two", "three"]);
});

test("a UTF-8 multi-byte character split across push() calls decodes correctly once the line completes", () => {
  const a = new RawLineAccumulator();
  const bytes = new TextEncoder().encode("Café time\n");
  const eIndex = bytes.indexOf(0xc3);
  assert.deepEqual(a.push(bytes.slice(0, eIndex + 1)), []);
  assert.deepEqual(a.push(bytes.slice(eIndex + 1)), ["Café time"]);
});

test("reset() clears held escape and in-progress line state", () => {
  const a = new RawLineAccumulator();
  a.push("Hi \x1b[3"); // in-progress line plus an incomplete escape sequence held
  a.reset();
  assert.deepEqual(a.push("abcd\n"), ["abcd"], "no leftover state from before reset()");
});

test("a chunk with no line feed yet yields no lines, and later ones return only the newly completed ones", () => {
  const a = new RawLineAccumulator();
  assert.deepEqual(a.push("partial"), []);
  assert.deepEqual(a.push(" line\nnext"), ["partial line"]);
  assert.deepEqual(a.push(" line\n"), ["next line"]);
});
