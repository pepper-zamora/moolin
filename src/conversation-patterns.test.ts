import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern, patternError } from "./conversation-patterns";

function groups(template: string, line: string, us?: string): Record<string, string> | null {
  const match = compilePattern(template, us).exec(line);
  return match ? { ...match.groups } : null;
}

test("the shorthands pick out the other character and the message", () => {
  assert.deepEqual(groups("{{them}} pages: {{message}}", "Jack pages: Hello!"), { them: "Jack", message: "Hello!" });
  assert.deepEqual(groups("From afar, {{them}} {{message}}", "From afar, Jack smiles."), {
    them: "Jack",
    message: "smiles.",
  });
  assert.deepEqual(groups("You page: {{message}}", "You page: Hello!"), { message: "Hello!" });
});

test("{{us}} matches only the character connected as, taken literally", () => {
  const template = "Long distance to {{them}}, {{us}} {{message}}";
  assert.deepEqual(groups(template, "Long distance to Jack, Diane smiles.", "Diane"), {
    them: "Jack",
    us: "Diane",
    message: "smiles.",
  });
  assert.equal(groups(template, "Long distance to Jack, Diane smiles.", "Di.ne"), null);
  assert.equal(groups(template, "Long distance to Jack, Dixne smiles.", "Di.ne"), null);
  // Without a character, any name will do.
  assert.equal(groups(template, "Long distance to Jack, Diane smiles.")?.us, "Diane");
});

test("named groups can be written out as plain regular expressions", () => {
  assert.deepEqual(groups("(?<them>\\w+) pages?: (?<message>.*)", "Jack page: Hi"), { them: "Jack", message: "Hi" });
});

test("a pattern must match the whole line", () => {
  assert.equal(groups("You page: Hello", "You page: Hello!"), null);
  assert.equal(groups("pages: {{message}}", "Jack pages: Hello!"), null);
  assert.equal(groups("a|b", "ab"), null);
});

test("patternError explains an invalid pattern and accepts a valid one", () => {
  assert.equal(patternError("{{them}} pages: {{message}}"), null);
  assert.match(patternError("{{them}} pages: (") ?? "", /Invalid regular expression/);
  assert.match(patternError("{{them}} and {{them}}") ?? "", /Invalid regular expression/);
});
