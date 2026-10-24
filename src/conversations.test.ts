import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversations } from "./conversations";
import type { ConversationPattern } from "./worlds-types";

const pages: ConversationPattern[] = [
  { template: "Long distance to {{them}}, {{us}} {{message}}", from: "us", kind: "emote" },
  { template: "From afar, {{them}} {{message}}", from: "them", kind: "emote" },
  { template: "You page: {{message}}", from: "us", kind: "say" },
  { template: "{{them}} pages: {{message}}", from: "them", kind: "say" },
];

function connected(characterName: string | null = "Diane"): Conversations {
  const conversations = new Conversations();
  conversations.setConnection(characterName, pages);
  return conversations;
}

test("each kind of line becomes the entry its bubble shows", () => {
  const conversations = connected();
  assert.deepEqual(conversations.take("Jack pages: Hello!", 1000, null), {
    partner: "Jack",
    from: "them",
    kind: "say",
    name: "Jack",
    text: "Hello!",
    initials: "J",
    time: 1000,
  });
  assert.deepEqual(conversations.take("You page: Hello yourself", 2000, null), {
    partner: "Jack",
    from: "us",
    kind: "say",
    name: "Diane",
    text: "Hello yourself",
    initials: "D",
    time: 2000,
  });
  // An emote reads as the speaker's name then the message.
  assert.equal(conversations.take("From afar, Jack smiles.", 3000, null)?.text, "Jack smiles.");
  assert.equal(conversations.take("Long distance to Jack, Diane grins.", 4000, null)?.text, "Diane grins.");
});

test("a line no pattern matches isn't taken, nor is anything while disconnected", () => {
  const conversations = connected();
  assert.equal(conversations.take('Jack says, "Hello!"', 1000, null), null);
  conversations.setConnection(null, []);
  assert.equal(conversations.take("Jack pages: Hello!", 1000, null), null);
});

test("a conversation keeps the case its name was first seen in", () => {
  const conversations = connected();
  conversations.take("Jack pages: Hi", 1000, null);
  assert.equal(conversations.take("From afar, jack waves.", 2000, null)?.partner, "Jack");
  // The bubble still names them as the line did.
  assert.equal(conversations.take("From afar, jack waves.", 2000, null)?.text, "jack waves.");
});

test("a line without {{them}} goes to the conversation shown, else the latest, else nowhere", () => {
  const conversations = connected();
  assert.equal(conversations.take("You page: anyone there?", 1000, null), null);
  conversations.take("Jack pages: Hi", 1000, null);
  conversations.take("Cowpernica pages: Moo", 2000, null);
  assert.equal(conversations.take("You page: hello cow", 3000, null)?.partner, "Cowpernica");
  assert.equal(conversations.take("You page: hello Jack", 4000, "Jack")?.partner, "Jack");
  // That made Jack's the latest.
  assert.equal(conversations.take("You page: still Jack", 5000, null)?.partner, "Jack");
});

test("our name falls back to You without a character, and clear forgets every conversation", () => {
  const conversations = connected(null);
  conversations.take("Jack pages: Hi", 1000, null);
  const entry = conversations.take("You page: Hi Jack", 2000, null);
  assert.equal(entry?.name, "You");
  assert.equal(entry?.initials, "Y");
  conversations.clear();
  assert.equal(conversations.take("You page: Hi again", 3000, null), null);
});
