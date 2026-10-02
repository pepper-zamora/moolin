import { test } from "node:test";
import assert from "node:assert/strict";
import { expandLoginTemplate, isConnectable, newWorld, targetLabel, DEFAULT_LOGIN_TEMPLATE } from "./world-utils";

test("expandLoginTemplate substitutes the character and password", () => {
  assert.equal(expandLoginTemplate(DEFAULT_LOGIN_TEMPLATE, "Cowpernica", "hunter2"), "co Cowpernica hunter2\r");
});

test("expandLoginTemplate handles \\r, \\n and \\\\ escapes", () => {
  assert.equal(expandLoginTemplate("a\\rb\\nc\\\\d", "", ""), "a\rb\nc\\d");
});

test("expandLoginTemplate never re-expands substituted text", () => {
  assert.equal(expandLoginTemplate("{{password}}", "x", "{{character}}\\r"), "{{character}}\\r");
});

test("expandLoginTemplate leaves unknown placeholders and escapes alone", () => {
  assert.equal(expandLoginTemplate("{{other}} \\t", "x", "y"), "{{other}} \\t");
});

test("isConnectable requires a host and a valid port", () => {
  const world = { ...newWorld("w"), host: "example.com", port: 4201 };
  assert.equal(isConnectable(world), true);
  assert.equal(isConnectable({ ...world, host: "  " }), false);
  assert.equal(isConnectable({ ...world, port: null }), false);
  assert.equal(isConnectable({ ...world, port: 0 }), false);
  assert.equal(isConnectable({ ...world, port: 65536 }), false);
  assert.equal(isConnectable({ ...world, port: 1.5 }), false);
});

test("targetLabel names the character and world, with fallbacks for blank names", () => {
  const world = { ...newWorld("w"), name: "LambdaMOO", host: "lambda.moo.mud.org" };
  const character = { id: "c", name: "Cowpernica", password: "" };
  assert.equal(targetLabel(world, character), "Cowpernica - LambdaMOO");
  assert.equal(targetLabel(world, null), "LambdaMOO");
  assert.equal(targetLabel({ ...world, name: "" }, null), "lambda.moo.mud.org");
  assert.equal(targetLabel({ ...world, name: "" }, { ...character, name: " " }), "Unnamed character - lambda.moo.mud.org");
});
