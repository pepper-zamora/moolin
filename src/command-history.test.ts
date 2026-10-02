import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandHistory, isOnFirstLine, isOnLastLine } from "./command-history";

test("browses back through entries and forward to the draft", () => {
  const history = new CommandHistory();
  history.push("look");
  history.push("say hi");
  assert.equal(history.previous("half-typed"), "say hi");
  assert.equal(history.previous("say hi"), "look");
  assert.equal(history.previous("look"), null, "stops at the oldest");
  assert.equal(history.next(), "say hi");
  assert.equal(history.next(), "half-typed", "past the newest restores the draft");
  assert.equal(history.next(), null, "not browsing any more");
});

test("skips blank lines and consecutive repeats", () => {
  const history = new CommandHistory();
  for (const line of ["look", "look", "", "  ", "north", "look"]) history.push(line);
  assert.equal(history.previous(""), "look");
  assert.equal(history.previous(""), "north");
  assert.equal(history.previous(""), "look");
  assert.equal(history.previous(""), null);
});

test("sending restarts browsing from the newest entry", () => {
  const history = new CommandHistory();
  history.push("one");
  history.push("two");
  history.previous("");
  history.previous("");
  history.push("one");
  assert.equal(history.previous(""), "one");
  assert.equal(history.previous(""), "two");
});

test("an empty history has nothing to browse", () => {
  const history = new CommandHistory();
  assert.equal(history.previous("x"), null);
  assert.equal(history.next(), null);
});

test("first/last line detection follows the caret in multi-line input", () => {
  const value = "line one\nline two";
  assert.equal(isOnFirstLine(value, 3), true);
  assert.equal(isOnFirstLine(value, 12), false);
  assert.equal(isOnLastLine(value, 12), true);
  assert.equal(isOnLastLine(value, 3), false);
  assert.equal(isOnFirstLine("single", 6) && isOnLastLine("single", 0), true);
});
