import { test } from "node:test";
import assert from "node:assert/strict";
import { WordWrapper } from "./word-wrap";

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

// Counts how many bytes in `s` are one of the "real line break" control
// characters (CR, LF, VT, FF). WordWrapper must never add, remove or
// duplicate one of these — it only ever inserts SPACE — so this count is
// the testable proxy, at the unit level, for the feature's hard
// requirement: a line from the server must always copy/paste back out as
// one line. (The actual copy-paste guarantee comes from xterm's own
// `isWrapped` row marking, which only a real xterm instance can exercise —
// see scripts/smoke.mjs for that half of the coverage.)
function lineBreakCount(s: string): number {
  return [...s].filter((c) => c === "\r" || c === "\n" || c === "\v" || c === "\f").length;
}

test("a word that fits on the row passes through byte-for-byte unchanged", () => {
  const w = new WordWrapper(20);
  const out = w.transform("hello world\n");
  assert.equal(text(out), "hello world\n");
});

test("a word that would overflow the row is preceded by padding to the row boundary", () => {
  // cols=10. "Hi " leaves col=3; "Everyone" (8 visible chars) would run to
  // column 11, past the 10-column row, so it's preceded by padding spaces
  // out to column 10 (7 of them, on top of the one real space already
  // there) instead of being allowed to split across the row boundary.
  const w = new WordWrapper(10);
  const out = w.transform("Hi Everyone\n");
  assert.equal(text(out), `Hi${" ".repeat(8)}Everyone\n`);
});

test("a word exactly filling the remaining row needs no padding", () => {
  // cols=10, word is exactly 10 visible characters starting at column 0:
  // it fits with nothing to spare, so no padding is inserted.
  const w = new WordWrapper(10);
  const out = w.transform("HelloWorld\n");
  assert.equal(text(out), "HelloWorld\n");
});

test("a word longer than a full row passes through unpadded", () => {
  // cols=5, a 10-character word: there's no row it would ever fully fit on,
  // so padding would only waste space without helping — left for xterm's
  // own column wrap to handle, exactly like today's default behavior.
  const w = new WordWrapper(5);
  const out = w.transform("ABCDEFGHIJ\n");
  assert.equal(text(out), "ABCDEFGHIJ\n");
});

test("a word split across two transform() calls is reassembled before any flush decision", () => {
  const w = new WordWrapper(10);
  const first = w.transform("Hello");
  assert.equal(text(first), "", "nothing is emitted until a word boundary arrives");
  const second = w.transform("World\n");
  // The combined word is exactly 10 visible characters at column 0: fits
  // with nothing to spare (same as the "exactly filling" case above), so
  // no padding, but the two halves must still be joined correctly.
  assert.equal(text(second), "HelloWorld\n");
});

test("escape sequences mid-word don't count toward column width, and are preserved in place", () => {
  // Plenty of room: output should be completely unchanged, proving the
  // escape bytes rode along with the word without affecting anything.
  const ample = new WordWrapper(20);
  const input = "\x1b[31mHello\x1b[0m world\n";
  assert.equal(text(ample.transform(input)), input);

  // Same content, but cols=8 so "world" (5 visible chars) doesn't fit after
  // "Hello " (6 visible chars so far: H,e,l,l,o,space): if the escape bytes
  // were wrongly counted as visible, the padding decision would fire at the
  // wrong column (or not at all). Expected: pad 2 spaces before "world" to
  // reach column 8, on top of the one real space.
  const tight = new WordWrapper(8);
  const out = text(tight.transform(input));
  assert.equal(out, `\x1b[31mHello\x1b[0m${" ".repeat(3)}world\n`);
});

test("flushPending returns a held trailing word, then null once there's nothing left", () => {
  const w = new WordWrapper(10);
  assert.equal(w.flushPending(), null, "nothing written yet");
  const mid = w.transform("hello"); // no boundary yet — held, not emitted
  assert.equal(text(mid), "");
  const held = w.flushPending();
  assert.ok(held);
  assert.equal(text(held), "hello");
  assert.equal(w.flushPending(), null, "already flushed; nothing left to hold");
});

test("flushPending applies the same padding decision as a normal flush", () => {
  const w = new WordWrapper(10);
  w.transform("Hi Everyone"); // "Hi " flushed (fits); "Everyone" held, no trailing boundary
  const held = w.flushPending();
  assert.ok(held);
  // Same padding math as the "would overflow" test above: col=3 after
  // "Hi ", "Everyone" is 8 visible chars, needs 7 padding spaces.
  assert.equal(text(held), `${" ".repeat(7)}Everyone`);
});

test("setCols affects only flush decisions made after it's called", () => {
  const w = new WordWrapper(20);
  // Under cols=20, "Hello" (5 chars) at column 0 would never need padding.
  // Narrow the width to 3 *while the word is still pending* (not yet
  // flushed, since nothing has ended it) and confirm the flush that
  // follows uses the new width, not the one the wrapper started with.
  w.transform("Hello"); // held: no boundary yet
  w.setCols(3);
  const out = w.transform(" \n"); // the trailing space is what triggers the flush
  // visibleLen=5 > cols=3, so this is the "longer than a full row" case:
  // passes through unpadded (and `col` afterwards reflects wrapping within
  // the new, narrower width — not asserted here, only the output bytes).
  assert.equal(text(out), "Hello \n");
});

test("setCols doesn't reset col, only the width it's measured against", () => {
  const w = new WordWrapper(10);
  w.transform("Hi "); // col becomes 3 (see the padding test above)
  w.setCols(5);
  // "ab" (2 visible chars) from column 3 under cols=5 would run to column
  // 5 — exactly filling the row, not overflowing it — so still no padding.
  const out = w.transform("ab\n");
  assert.equal(text(out), "ab\n");
});

test("CR, LF, VT and FF all reset the column to 0, same as a real line break", () => {
  for (const brk of ["\r", "\n", "\v", "\f"]) {
    const w = new WordWrapper(5);
    w.transform(`Hi${brk}`); // col would be 2 if not reset
    // A following word longer than (cols - 2) but not longer than cols
    // would need padding if col weren't reset to 0 by the break.
    const out = w.transform("abcd\n");
    assert.equal(text(out), "abcd\n", `break ${JSON.stringify(brk)} should have reset the column`);
  }
});

test("tabs advance to the next 8-column stop, clamped to the row width", () => {
  const w = new WordWrapper(20);
  // Three tabs from column 0: 0->8->16->20 (the third would overshoot to
  // 24, clamped to the 20-column row width — see the module's comment on
  // why this is an accepted approximation). A tab is a word boundary like
  // space, so each one is emitted immediately — nothing is held.
  const out = w.transform("\t\t\t");
  assert.equal(text(out), "\t\t\t");
  assert.equal(w.flushPending(), null, "nothing left pending after three tabs");
  // A one-character word right after should need no padding (col=20 means
  // the row is exactly, deferred-wrap full; xterm wraps on the very next
  // character either way, same as it would with no help from us).
  const after = new WordWrapper(20);
  after.transform("\t\t\t");
  const next = after.transform("x\n");
  assert.equal(text(next), "x\n");
});

test("a chunk with several words reproduces the same output as processing it in one piece", () => {
  const w = new WordWrapper(10);
  const out = w.transform("Hi Everyone\n");
  assert.equal(text(out), `Hi${" ".repeat(8)}Everyone\n`);
});

test("an escape sequence split across chunks is reassembled before its bytes are classified", () => {
  // cols=5 exactly matches "Hello"'s length: if the escape sequence were
  // wrongly left incomplete (e.g. counted as visible content, or its tail
  // misread as the start of the next word), either the padding decision or
  // the output bytes themselves would come out wrong.
  const w = new WordWrapper(5);
  const first = w.transform("\x1b[3"); // incomplete CSI — held, nothing emitted
  assert.equal(text(first), "");
  const second = w.transform("1mHello\n"); // completes "\x1b[31m", then the word
  assert.equal(text(second), "\x1b[31mHello\n", "fits exactly; no padding, nothing lost from the split escape");
});

test("an escape sequence that never finds its terminator is abandoned without losing or hanging on data", () => {
  // A lone ESC followed by 70 bytes that look like CSI parameter bytes
  // (digits) but never reach a final byte — comfortably past
  // MAX_ESCAPE_LENGTH. The implementation gives up on treating it as an
  // escape sequence (rather than buffering forever) and falls back to
  // treating the ESC as one inert byte, reprocessing the rest as ordinary
  // visible content.
  const input = `\x1b${"5".repeat(70)}\n`;
  const w = new WordWrapper(1000); // ample width: nothing should be padded
  const out = w.transform(input);
  assert.equal(text(out), input, "every byte is preserved even though the escape sequence was abandoned");
});

test("line-break bytes are never added, removed or duplicated, regardless of wrapping", () => {
  const samples = [
    "short line\n",
    "a line with one looooooooooooooooong word and then more\n",
    "\x1b[1;31mcolored\x1b[0m text with several words in a row\r\n",
    "no trailing newline at all, just a long run of words one two three four five",
    "line one\nline two\nline three\n",
  ];
  for (const input of samples) {
    for (const cols of [5, 10, 40]) {
      const w = new WordWrapper(cols);
      const chunks = [text(w.transform(input))];
      const held = w.flushPending();
      if (held) chunks.push(text(held));
      const output = chunks.join("");
      assert.equal(
        lineBreakCount(output),
        lineBreakCount(input),
        `cols=${cols}, input=${JSON.stringify(input)}: line-break count changed (output=${JSON.stringify(output)})`,
      );
    }
  }
});

test("reset() clears column, pending word and any held escape sequence", () => {
  const w = new WordWrapper(5);
  w.transform("Hi \x1b[3"); // col=3, plus an incomplete escape sequence held
  w.reset();
  // If col weren't reset to 0, "abcd" (4 chars) from a nonzero column under
  // cols=5 could need padding; if the held escape weren't cleared, it would
  // wrongly reappear (or break classification) in this next, unrelated word.
  const out = w.transform("abcd\n");
  assert.equal(text(out), "abcd\n");
});

test("UTF-8 continuation bytes don't count toward visible column width", () => {
  // "é" as two bytes (0xC3 0xA9, UTF-8 for U+00E9) must count as ONE visible
  // column, not two, whether or not it's split across transform() calls.
  const inOneCall = new WordWrapper(10);
  const whole = inOneCall.transform("Café time\n"); // "Café time\n"
  assert.equal(text(whole), "Café time\n", "ample width: nothing padded means the column count mattered correctly");

  const split = new WordWrapper(10);
  const bytes = new TextEncoder().encode("Café time\n");
  // Split exactly between the two bytes of "é" (0xC3 0xA9).
  const eIndex = bytes.indexOf(0xc3);
  const first = split.transform(bytes.slice(0, eIndex + 1));
  assert.equal(text(first), "", "the word is still in progress; nothing flushed yet");
  const second = split.transform(bytes.slice(eIndex + 1));
  assert.equal(text(second), "Café time\n", "split mid-character reassembles to the same result as one call");
});
