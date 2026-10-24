// Which private conversation each server line belongs to, and what its
// bubble says, for the window's conversation tabs (conversation-tabs.ts).
// Pure, with no DOM, so it can be tested.
import { ConversationMatcher, initials } from "./conversation-patterns";
import type { ConversationKind, ConversationPattern, ConversationSpeaker } from "./worlds-types";

// One line of a conversation, as its tab shows it.
export interface ConversationEntry {
  // The other character, as their name was first seen: the conversation's
  // tab, whatever case later lines give it in.
  partner: string;
  from: ConversationSpeaker;
  kind: ConversationKind;
  // Who it's from: the other character, or the character connected as
  // ("You" without one).
  name: string;
  // What's shown: a say's message, or an emote's name then message.
  text: string;
  // A say's avatar.
  initials: string;
  time: number | null;
}

export class Conversations {
  private matcher = new ConversationMatcher([], null);
  private us: string | null = null;
  // Each other character's name in lower case, to their name as first seen.
  private readonly partners = new Map<string, string>();
  // The conversation with the latest entry.
  private latest: string | null = null;

  // The connection's character (null without one) and its world's patterns.
  // While disconnected there are none, so nothing is taken.
  setConnection(characterName: string | null, patterns: ReadonlyArray<ConversationPattern>): void {
    this.us = characterName;
    this.matcher = new ConversationMatcher(patterns, characterName);
  }

  // The entry for a server line, or null if no pattern matches it. A line
  // that doesn't name the other character goes to `shown` (the conversation
  // shown, if any), or else the one with the latest entry; with neither it
  // has nowhere to go, and is null too.
  take(line: string, time: number | null, shown: string | null): ConversationEntry | null {
    if (this.matcher.empty) return null;
    const match = this.matcher.match(line);
    if (!match) return null;
    let partner = shown ?? this.latest;
    if (match.them) {
      const key = match.them.toLowerCase();
      partner = this.partners.get(key) ?? match.them;
      this.partners.set(key, partner);
    }
    if (partner === null) return null;
    this.latest = partner;
    const name = match.from === "us" ? (match.us ?? this.us ?? "You") : (match.them ?? partner);
    return {
      partner,
      from: match.from,
      kind: match.kind,
      name,
      text: match.kind === "emote" ? `${name} ${match.message}`.trim() : match.message,
      initials: initials(name),
      time,
    };
  }

  // Forgets every conversation, as when a new connection starts.
  clear(): void {
    this.partners.clear();
    this.latest = null;
  }
}
