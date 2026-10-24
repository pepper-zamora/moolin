// Conversation patterns (see ConversationPattern in worlds-types.ts) are
// regular expressions matched against a whole server line. Named groups
// `us`, `them` and `message` pick out the two characters and what's said or
// done; {{us}}, {{them}} and {{message}} are shorthand for them. Shared by
// the main process and the renderer, so it must stay free of Node and
// Electron imports.

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
