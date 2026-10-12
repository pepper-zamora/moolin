import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampFontSize,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  FONT_WEIGHTS,
  FONT_WIDTHS,
  fontFamilyFor,
  isValidFontId,
  isValidFontWeight,
  isValidFontWidth,
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

const PLAIN_STYLE = { weight: 400, italic: false, width: "normal" };

test("parseFontArgs reads the font, size, weight, slant and width from argv", () => {
  assert.deepEqual(
    parseFontArgs([
      "--font-id=menlo",
      "--font-size=18",
      "--font-weight=300",
      "--font-italic=true",
      "--font-width=expanded",
    ]),
    { fontId: "menlo", fontSize: 18, fontStyle: { weight: 300, italic: true, width: "expanded" } },
  );
});

test("parseFontArgs falls back to the defaults for missing, unknown or malformed flags", () => {
  assert.deepEqual(parseFontArgs([]), { fontId: DEFAULT_FONT_ID, fontSize: DEFAULT_FONT_SIZE, fontStyle: PLAIN_STYLE });
  assert.deepEqual(
    parseFontArgs([
      "--font-id=comic-sans",
      "--font-size=not-a-number",
      "--font-weight=450",
      "--font-italic=maybe",
      "--font-width=wide",
    ]),
    { fontId: DEFAULT_FONT_ID, fontSize: DEFAULT_FONT_SIZE, fontStyle: PLAIN_STYLE },
  );
});

test("parseFontArgs clamps an out-of-range --font-size", () => {
  assert.equal(parseFontArgs(["--font-size=1000"]).fontSize, 32);
});

test("every weight and width offered is accepted, and nothing else is", () => {
  for (const { value } of FONT_WEIGHTS) assert.equal(isValidFontWeight(value), true, String(value));
  for (const { value } of FONT_WIDTHS) assert.equal(isValidFontWidth(value), true, value);
  for (const bad of [0, 350, "400", null, undefined]) assert.equal(isValidFontWeight(bad), false, String(bad));
  for (const bad of ["wide", "", 100, null]) assert.equal(isValidFontWidth(bad), false, String(bad));
});
