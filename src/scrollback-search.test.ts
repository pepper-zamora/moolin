import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseActive, findMatches, type SearchQuery } from "./scrollback-search";

const query = (text: string, options: Partial<SearchQuery> = {}): SearchQuery => ({
  text,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...options,
});
const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const spans = (result: ReturnType<typeof findMatches>) => result.matches.map((m) => [m.start, m.end]);

test("finds every match, oldest first", () => {
  const all = lines("a cat", "no", "cat cat");
  const result = findMatches(all, query("cat"), 100);
  assert.deepEqual(spans(result), [
    [2, 5],
    [0, 3],
    [4, 7],
  ]);
  assert.equal(result.matches[0].line, all[0]);
  assert.equal(result.truncated, false);
});

test("case folding and whole words", () => {
  assert.equal(findMatches(lines("Cat"), query("cat"), 10).matches.length, 1);
  assert.equal(findMatches(lines("Cat"), query("cat", { caseSensitive: true }), 10).matches.length, 0);
  assert.equal(findMatches(lines("concat cat"), query("cat", { wholeWord: true }), 10).matches.length, 1);
});

test("text is literal unless regex is on", () => {
  assert.equal(findMatches(lines("a.c abc"), query("a.c"), 10).matches.length, 1);
  assert.equal(findMatches(lines("a.c abc"), query("a.c", { regex: true }), 10).matches.length, 2);
  assert.equal(findMatches(lines("(x)"), query("(x)"), 10).matches.length, 1);
});

test("an invalid regex throws", () => {
  assert.throws(() => findMatches(lines("x"), query("foo(", { regex: true }), 10), SyntaxError);
});

test("empty matches are skipped without hanging", () => {
  assert.deepEqual(spans(findMatches(lines("aaa"), query("x*", { regex: true }), 10)), []);
});

test("past the limit the newest matches are kept", () => {
  const result = findMatches(lines("x", "x", "x", "x"), query("x"), 2);
  assert.equal(result.truncated, true);
  assert.equal(result.matches.length, 2);
  const all = lines("x", "x", "x", "x");
  const kept = findMatches(all, query("x"), 2).matches.map((m) => all.indexOf(m.line));
  assert.deepEqual(kept, [2, 3]);
});

test("exactly the limit is not truncated", () => {
  assert.equal(findMatches(lines("x", "x"), query("x"), 2).truncated, false);
});

test("chooseActive: no matches means no current one", () => {
  for (const mode of ["incremental", "refresh", "next", "previous"] as const) {
    assert.equal(
      chooseActive(mode, 0, -1, () => 0),
      -1,
    );
  }
});

test("chooseActive: typing or new output keeps the current match, else starts in view", () => {
  assert.equal(
    chooseActive("incremental", 5, 3, () => 1),
    3,
  );
  assert.equal(
    chooseActive("refresh", 5, 3, () => 1),
    3,
  );
  assert.equal(
    chooseActive("incremental", 5, -1, () => 1),
    1,
  );
});

test("chooseActive: next and previous step from the current match and wrap", () => {
  assert.equal(
    chooseActive("next", 5, 2, () => 0),
    3,
  );
  assert.equal(
    chooseActive("next", 5, 4, () => 0),
    0,
  );
  assert.equal(
    chooseActive("previous", 5, 2, () => 0),
    1,
  );
  assert.equal(
    chooseActive("previous", 5, 0, () => 0),
    4,
  );
});

test("chooseActive: with no current match, next starts in view and previous at the newest", () => {
  assert.equal(
    chooseActive("next", 5, -1, () => 2),
    2,
  );
  assert.equal(
    chooseActive("previous", 5, -1, () => 2),
    4,
  );
});
