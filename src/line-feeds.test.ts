import { test } from "node:test";
import assert from "node:assert/strict";
import { countLineFeeds } from "./line-feeds";

test("counts LF, VT and FF, the bytes the scrollback breaks a line at", () => {
  assert.equal(countLineFeeds("one\r\ntwo\vthree\ffour"), 3);
  assert.equal(countLineFeeds(new Uint8Array([0x61, 0x0a, 0x0b, 0x0c, 0x0d])), 3);
});

test("counts nothing in text without line feeds", () => {
  assert.equal(countLineFeeds(""), 0);
  assert.equal(countLineFeeds("no line feed\r"), 0);
  assert.equal(countLineFeeds(new Uint8Array([0x09, 0x0d, 0x1b])), 0);
});
