import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSelectAllTarget } from "./select-all";

test("with nothing selected in the scrollback, Select All goes to the input line", () => {
  assert.equal(chooseSelectAllTarget(undefined, false, true), "input");
});

test("with something selected in the scrollback, Select All goes to the scrollback", () => {
  assert.equal(chooseSelectAllTarget(undefined, true, true), "scrollback");
});

test("with no usable input line, Select All goes to the scrollback", () => {
  assert.equal(chooseSelectAllTarget(undefined, false, false), "scrollback");
});

test("a request that names its target gets it, whatever is selected", () => {
  assert.equal(chooseSelectAllTarget("scrollback", false, true), "scrollback");
  assert.equal(chooseSelectAllTarget("input", true, true), "input");
});
