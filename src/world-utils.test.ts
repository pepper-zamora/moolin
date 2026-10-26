import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandLoginTemplate,
  isConnectable,
  newCharacter,
  newWorld,
  resolveTriState,
  targetLabel,
  DEFAULT_LOGIN_TEMPLATE,
  deleteCharacterPrompt,
  deleteWorldPrompt,
} from "./world-utils";

test('resolveTriState falls back to Global when every override is "inherit"', () => {
  assert.equal(resolveTriState(true), true);
  assert.equal(resolveTriState(false), false);
  assert.equal(resolveTriState(true, "inherit", "inherit"), true);
  assert.equal(resolveTriState(false, "inherit", "inherit"), false);
});

test("resolveTriState lets the first non-inherit override win, most specific first", () => {
  // Character ("on") overrides World ("off") overrides Global (false).
  assert.equal(resolveTriState(false, "on", "off"), true);
  // World ("off") applies when Character doesn't override.
  assert.equal(resolveTriState(true, "inherit", "off"), false);
  // Character overriding, with World also set, still wins (first match).
  assert.equal(resolveTriState(false, "off", "on"), false);
});

test("expandLoginTemplate substitutes the character and password", () => {
  assert.equal(expandLoginTemplate(DEFAULT_LOGIN_TEMPLATE, "Cowpernica", "hunter2"), 'co "Cowpernica" hunter2\r');
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
  const character = { ...newCharacter("c"), name: "Cowpernica" };
  assert.equal(targetLabel(world, character), "Cowpernica - LambdaMOO");
  assert.equal(targetLabel(world, null), "LambdaMOO");
  assert.equal(targetLabel({ ...world, name: "" }, null), "lambda.moo.mud.org");
  assert.equal(
    targetLabel({ ...world, name: "" }, { ...character, name: " " }),
    "Unnamed character - lambda.moo.mud.org",
  );
});

test("deleteWorldPrompt says which characters go with the world", () => {
  const character = (id: string, name: string) => ({ ...newCharacter(id), name });
  const world = { ...newWorld("w"), name: "Moo" };
  assert.deepEqual(deleteWorldPrompt(world), {
    message: 'Delete the world "Moo"?',
    detail: "It has no characters. Session logs already written are kept. This can't be undone.",
  });
  assert.match(
    deleteWorldPrompt({ ...world, characters: [character("a", "Cowpernica")] }).detail,
    /^Its character, "Cowpernica", will be deleted too\./,
  );
  assert.match(
    deleteWorldPrompt({ ...world, characters: [character("a", "Cowpernica"), character("b", "")] }).detail,
    /^All 2 of its characters, "Cowpernica" and "Unnamed character", will be deleted too\./,
  );
  const many = Array.from({ length: 7 }, (_, i) => character(String(i), `C${i}`));
  assert.match(
    deleteWorldPrompt({ ...world, characters: many }).detail,
    /^All 7 of its characters, "C0", "C1", "C2", "C3", "C4" and 2 more, will be deleted too\./,
  );
});

test("deleteCharacterPrompt names the character and its world", () => {
  const world = { ...newWorld("w"), name: "Moo" };
  assert.equal(
    deleteCharacterPrompt(world, { ...newCharacter("c"), name: "Cowpernica" }).message,
    'Delete the character "Cowpernica" from "Moo"?',
  );
});
