import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampFontSize,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  fontFamilyFor,
  isValidFontId,
  parseFontArgs,
} from "./fonts";

test("isValidFontId accepts only curated ids", () => {
  assert.equal(isValidFontId("system-default"), true);
  assert.equal(isValidFontId("jetbrains-mono"), true);
  assert.equal(isValidFontId("comic-sans"), false);
  assert.equal(isValidFontId(""), false);
});

test("fontFamilyFor returns the matching font's CSS stack, falling back to the first entry", () => {
  assert.equal(fontFamilyFor("jetbrains-mono"), `"JetBrains Mono", monospace`);
  assert.equal(fontFamilyFor("not-a-real-font"), fontFamilyFor(DEFAULT_FONT_ID));
});

test("clampFontSize keeps values in range and clamps outside it", () => {
  assert.equal(clampFontSize(14), 14);
  assert.equal(clampFontSize(1), 8);
  assert.equal(clampFontSize(999), 32);
});

test("parseFontArgs reads --font-id and --font-size from argv", () => {
  assert.deepEqual(parseFontArgs(["--font-id=menlo", "--font-size=18"]), { fontId: "menlo", fontSize: 18 });
});

test("parseFontArgs falls back to the defaults for missing, unknown or malformed flags", () => {
  assert.deepEqual(parseFontArgs([]), { fontId: DEFAULT_FONT_ID, fontSize: DEFAULT_FONT_SIZE });
  assert.deepEqual(parseFontArgs(["--font-id=comic-sans", "--font-size=not-a-number"]), {
    fontId: DEFAULT_FONT_ID,
    fontSize: DEFAULT_FONT_SIZE,
  });
});

test("parseFontArgs clamps an out-of-range --font-size", () => {
  assert.deepEqual(parseFontArgs(["--font-size=1000"]), { fontId: DEFAULT_FONT_ID, fontSize: 32 });
});
