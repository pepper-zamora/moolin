import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify } from "./linkify";

test("text without an address is one plain segment", () => {
  assert.deepEqual(linkify("nothing here"), [{ text: "nothing here" }]);
  assert.deepEqual(linkify("ftp://not-web"), [{ text: "ftp://not-web" }]);
});

test("an address is split out with the text around it", () => {
  assert.deepEqual(linkify("see https://example.com/a?b=1 now"), [
    { text: "see " },
    { text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
    { text: " now" },
  ]);
});

test("sentence punctuation after an address is not part of it", () => {
  assert.deepEqual(linkify("go to http://example.com."), [
    { text: "go to " },
    { text: "http://example.com", url: "http://example.com" },
    { text: "." },
  ]);
  assert.equal(linkify("http://example.com/x?!")[0].url, "http://example.com/x");
});

test("a closing bracket is kept only when the address opened it", () => {
  assert.equal(linkify("(see http://example.com)")[1].url, "http://example.com");
  assert.equal(linkify("http://en.wikipedia.org/wiki/Foo_(bar)")[0].url, "http://en.wikipedia.org/wiki/Foo_(bar)");
});

test("several addresses in one run", () => {
  const urls = linkify("http://a.com and https://b.com")
    .filter((s) => s.url)
    .map((s) => s.url);
  assert.deepEqual(urls, ["http://a.com", "https://b.com"]);
});

test("a bare scheme is not an address", () => {
  assert.deepEqual(linkify("http:// alone"), [{ text: "http:// alone" }]);
});

test("only http and https count", () => {
  assert.deepEqual(linkify("javascript://x"), [{ text: "javascript://x" }]);
});
