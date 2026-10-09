import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INPUT_LENGTH,
  parseBooleanPair,
  parseClipboardText,
  parseConfirmText,
  parseConnectRequest,
  parseContextMenuOptions,
  parseExternalUrl,
  parseInitialSize,
  parseInputText,
  parseLogCall,
  parseMenuItems,
  parseSize,
} from "./ipc-validate";

test("a size is two whole numbers that fit NAWS's two bytes", () => {
  assert.deepEqual(parseSize({ cols: 80, rows: 24 }), { cols: 80, rows: 24 });
  for (const bad of [null, 5, "80x24", {}, { cols: 80 }, { cols: 0, rows: 24 }, { cols: 80, rows: -1 }]) {
    assert.equal(parseSize(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseSize({ cols: 70000, rows: 24 }), null);
  assert.equal(parseSize({ cols: 80.5, rows: 24 }), null);
  assert.equal(parseSize({ cols: Number.NaN, rows: 24 }), null);
  assert.equal(parseSize({ cols: "80", rows: 24 }), null);
});

test("only http and https addresses may be opened", () => {
  assert.equal(parseExternalUrl("https://example.org/a b"), "https://example.org/a%20b");
  assert.equal(parseExternalUrl("HTTP://example.org"), "http://example.org/");
  for (const bad of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ms-msdt:/id",
    "smb://host/share",
    "//example.org",
    "example.org",
    "",
    null,
    42,
    { href: "https://example.org" },
    `https://example.org/${"a".repeat(9000)}`,
  ]) {
    assert.equal(parseExternalUrl(bad), null, String(bad).slice(0, 40));
  }
});

test("input must be text of a sane size", () => {
  assert.equal(parseInputText("look"), "look");
  assert.equal(parseInputText(""), "");
  assert.equal(parseInputText(42), null);
  assert.equal(parseInputText(undefined), null);
  assert.equal(parseInputText({ toString: () => "x" }), null);
  assert.equal(parseInputText("x".repeat(MAX_INPUT_LENGTH + 1)), null);
});

test("menu items are objects with a string id and label", () => {
  assert.deepEqual(parseMenuItems([{ id: "a", label: "A", extra: 1 }]), [{ id: "a", label: "A" }]);
  assert.equal(parseMenuItems("nope"), null);
  assert.equal(parseMenuItems([{ id: 1, label: "A" }]), null);
  assert.equal(parseMenuItems([null]), null);
  assert.equal(parseMenuItems(Array.from({ length: 51 }, () => ({ id: "a", label: "A" }))), null);
});

test("a confirmation needs a message, and a detail if there is one", () => {
  assert.deepEqual(parseConfirmText("Sure?", undefined), { message: "Sure?" });
  assert.deepEqual(parseConfirmText("Sure?", "It can't be undone."), {
    message: "Sure?",
    detail: "It can't be undone.",
  });
  assert.equal(parseConfirmText(1, undefined), null);
  assert.equal(parseConfirmText("Sure?", 2), null);
});

test("a log call needs a real level and a short scope, and loses its control characters", () => {
  assert.deepEqual(parseLogCall("debug", "renderer", ["x"]), { level: "debug", scope: "renderer", args: ["x"] });
  assert.equal(parseLogCall("none", "renderer", []), null);
  assert.equal(parseLogCall("constructor", "renderer", []), null);
  assert.equal(parseLogCall("debug", 3, []), null);
  assert.equal(parseLogCall("debug", "x".repeat(100), []), null);
  assert.equal(parseLogCall("debug", "x", "not a list"), null);
  assert.equal(parseLogCall("debug", "x", new Array(21).fill(0)), null);
  assert.equal(parseLogCall("info", "a\nb\x1b[2J", [])?.scope, "a b [2J");
});

test("the remaining messages are checked field by field", () => {
  assert.deepEqual(parseBooleanPair(true, false), [true, false]);
  assert.equal(parseBooleanPair(true, "no"), null);
  assert.deepEqual(parseInitialSize({ width: 800, height: 600 }), { width: 800, height: 600 });
  for (const bad of [{ width: 0, height: 5 }, { width: Number.POSITIVE_INFINITY, height: 5 }, { width: 5 }, null]) {
    assert.equal(parseInitialSize(bad), null);
  }
  assert.deepEqual(parseContextMenuOptions({ hasSelection: true, selectAllTarget: "input" }), {
    hasSelection: true,
    selectAllTarget: "input",
  });
  assert.equal(parseContextMenuOptions({ hasSelection: true, selectAllTarget: "elsewhere" }), null);
  assert.equal(parseContextMenuOptions({ hasSelection: 1, selectAllTarget: "input" }), null);
  assert.deepEqual(parseConnectRequest({ world: { id: "w" }, characterId: null }), {
    world: { id: "w" },
    characterId: null,
  });
  assert.equal(parseConnectRequest({ world: {}, characterId: 5 }), null);
  assert.equal(parseConnectRequest("x"), null);
  assert.equal(parseClipboardText("copy"), "copy");
  assert.equal(parseClipboardText(["copy"]), null);
});
