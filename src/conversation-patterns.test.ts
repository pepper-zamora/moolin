import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationMatcher, compilePattern, initials, patternError } from "./conversation-patterns";
import type { ConversationPattern } from "./worlds-types";

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

const pages: ConversationPattern[] = [
  { template: "Long distance to {{them}}, {{us}} {{message}}", from: "us", kind: "emote" },
  { template: "From afar, {{them}} {{message}}", from: "them", kind: "emote" },
  { template: "You page: {{message}}", from: "us", kind: "say" },
  { template: "{{them}} pages: {{message}}", from: "them", kind: "say" },
];

test("ConversationMatcher reports the first pattern to match, with who and what", () => {
  const matcher = new ConversationMatcher(pages, "Diane");
  assert.deepEqual(matcher.match("Long distance to Jack, Diane smiles."), {
    from: "us",
    kind: "emote",
    us: "Diane",
    them: "Jack",
    message: "smiles.",
  });
  assert.deepEqual(matcher.match("From afar, Jack smiles."), {
    from: "them",
    kind: "emote",
    us: null,
    them: "Jack",
    message: "smiles.",
  });
  assert.deepEqual(matcher.match("You page: Hello!"), {
    from: "us",
    kind: "say",
    us: null,
    them: null,
    message: "Hello!",
  });
  assert.equal(matcher.match("Jack pages: Hello!")?.them, "Jack");
  assert.equal(matcher.match('Jack says, "Hello!"'), null);
});

test("ConversationMatcher skips blank and invalid patterns", () => {
  const matcher = new ConversationMatcher(
    [
      { template: "  ", from: "them", kind: "say" },
      { template: "{{them}} pages: (", from: "them", kind: "say" },
    ],
    null,
  );
  assert.equal(matcher.empty, true);
  assert.equal(matcher.match("Jack pages: ("), null);
});

test("initials takes the first letters of up to two words", () => {
  assert.equal(initials("Jack"), "J");
  assert.equal(initials("mary jane watson"), "MJ");
  assert.equal(initials("Dr_Who"), "DW");
  assert.equal(initials(""), "?");
});
