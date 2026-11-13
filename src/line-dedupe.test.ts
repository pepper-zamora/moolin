import { test } from "node:test";
import assert from "node:assert/strict";
import { DEDUPE_WINDOW_MS, LineDeduper } from "./line-dedupe";

const bytes = (s: string) => Buffer.from(s);
const text = (b: Uint8Array) => Buffer.from(b).toString();

test("the same output cut differently on two connections is kept once", () => {
  const d = new LineDeduper();
  const out = [
    d.push("a", bytes("You see a cow.\r\nIt is"), 0),
    d.push("b", bytes("You see a cow.\r\nIt is warm.\r\n"), 10),
    d.push("a", bytes(" warm.\r\n"), 20),
  ];
  assert.equal(out.map(text).join(""), "You see a cow.\r\nIt is warm.\r\n");
});

test("a line only one connection receives is kept", () => {
  const d = new LineDeduper();
  assert.equal(text(d.push("a", bytes("shared\nonly a\n"), 0)), "shared\nonly a\n");
  assert.equal(text(d.push("b", bytes("shared\nonly b\n"), 10)), "only b\n");
});

test("a real repeat is kept, as many times as it arrives", () => {
  const d = new LineDeduper();
  const out = [
    d.push("a", bytes("beep\n"), 0),
    d.push("a", bytes("beep\n"), 1000),
    d.push("b", bytes("beep\nbeep\n"), 1100),
  ];
  assert.equal(out.map(text).join(""), "beep\nbeep\n");
});

test("a connection that lags behind still matches, and one ahead is written first", () => {
  const d = new LineDeduper();
  assert.equal(text(d.push("a", bytes("one\ntwo\n"), 0)), "one\ntwo\n");
  assert.equal(text(d.push("b", bytes("one\n"), 2000)), "");
  assert.equal(text(d.push("a", bytes("three\n"), 2100)), "three\n");
  assert.equal(text(d.push("b", bytes("two\nthree\n"), 2200)), "");
});

test("a copy that arrives after the window is a new line", () => {
  const d = new LineDeduper();
  assert.equal(text(d.push("a", bytes("late\n"), 0)), "late\n");
  assert.equal(text(d.push("b", bytes("late\n"), DEDUPE_WINDOW_MS + 1)), "late\n");
});

test("three connections each match a line once", () => {
  const d = new LineDeduper();
  const out = [d.push("a", bytes("hi\n"), 0), d.push("b", bytes("hi\n"), 1), d.push("c", bytes("hi\n"), 2)];
  assert.equal(out.map(text).join(""), "hi\n");
});

test("an unfinished line waits for its line feed, or a flush", () => {
  const d = new LineDeduper();
  assert.equal(text(d.push("a", bytes("> "), 0)), "");
  assert.equal(text(d.push("b", bytes("> "), 0)), "");
  assert.equal(text(d.flush("a")), "> ");
  assert.equal(text(d.flush("a")), "");
  assert.equal(text(d.flushAll()), "> ");
});

test("a connection that ends drops an unfinished line another is also holding", () => {
  const d = new LineDeduper();
  d.push("a", bytes("> "), 0);
  d.push("b", bytes("> "), 0);
  assert.equal(text(d.leave("a")), "");
  d.push("c", bytes("other"), 0);
  assert.equal(text(d.leave("c")), "other");
});

test("an endless line is let through rather than held without end", () => {
  const d = new LineDeduper();
  const big = Buffer.alloc(70 * 1024, "x");
  assert.equal(d.push("a", big, 0).length, big.length);
  assert.equal(text(d.flush("a")), "");
});
