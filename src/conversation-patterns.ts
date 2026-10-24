// Conversation patterns (see ConversationPattern in worlds-types.ts) are
// regular expressions matched against a whole server line. Named groups
// `us`, `them` and `message` pick out the two characters and what's said or
// done; {{us}}, {{them}} and {{message}} are shorthand for them. Shared by
// the main process and the renderer, so it must stay free of Node and
// Electron imports.
import type { ConversationKind, ConversationPattern, ConversationSpeaker } from "./worlds-types";

const GROUPS: Record<string, string> = {
  us: "(?<us>.+?)",
  them: "(?<them>.+?)",
  message: "(?<message>.*)",
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The pattern as a RegExp. With `us`, the character connected as, {{us}}
// matches only that name. Throws a SyntaxError for an invalid pattern.
export function compilePattern(template: string, us?: string): RegExp {
  const source = template.replace(/\{\{(us|them|message)\}\}/g, (_, name: string) =>
    name === "us" && us !== undefined ? `(?<us>${escapeRegExp(us)})` : GROUPS[name],
  );
  return new RegExp(`^(?:${source})$`);
}

// Why the pattern isn't a valid regular expression, or null if it is.
export function patternError(template: string): string | null {
  try {
    compilePattern(template);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// A server line a pattern matched: who it's from, whether it was said or
// emoted, the names it gave (null where the pattern has no such group) and
// the message (empty if none).
export interface ConversationMatch {
  from: ConversationSpeaker;
  kind: ConversationKind;
  us: string | null;
  them: string | null;
  message: string;
}

// A world's patterns, ready to match lines against. `us` is the character
// connected as, if any. A pattern that isn't valid is left out.
export class ConversationMatcher {
  private readonly compiled: Array<{ pattern: ConversationPattern; regex: RegExp }> = [];

  constructor(patterns: ReadonlyArray<ConversationPattern>, us: string | null) {
    for (const pattern of patterns) {
      if (pattern.template.trim() === "") continue;
      try {
        this.compiled.push({ pattern, regex: compilePattern(pattern.template, us ?? undefined) });
      } catch {
        // Flagged in the Worlds dialog; there's nothing to match with here.
      }
    }
  }

  get empty(): boolean {
    return this.compiled.length === 0;
  }

  // The first pattern, in order, that matches the whole line.
  match(line: string): ConversationMatch | null {
    for (const { pattern, regex } of this.compiled) {
      const found = regex.exec(line);
      if (!found) continue;
      const groups = found.groups;
      return {
        from: pattern.from,
        kind: pattern.kind,
        us: groups?.us ?? null,
        them: groups?.them?.trim() || null,
        message: groups?.message ?? "",
      };
    }
    return null;
  }
}

// What an avatar shows for a name: the first letters of its first two words,
// or its first letter, in capitals.
export function initials(name: string): string {
  const words = name.split(/[\s_.-]+/).filter((word) => word !== "");
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}
