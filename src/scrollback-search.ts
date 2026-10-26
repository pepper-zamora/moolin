export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Match<T> {
  line: T;
  // Character offsets into line.text.
  start: number;
  end: number;
}

export interface SearchResult<T> {
  // Oldest first.
  matches: Array<Match<T>>;
  // More matches exist than the limit; the oldest were left out.
  truncated: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Throws SyntaxError for an unfinished regular expression.
export function buildPattern(query: SearchQuery): RegExp {
  const source = query.regex ? query.text : escapeRegExp(query.text);
  return new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, query.caseSensitive ? "g" : "gi");
}

// Finds matches line by line (a match never spans lines), keeping the newest
// `limit` when there are more: the recent output is what is usually wanted.
export function findMatches<T extends { text: string }>(
  lines: ReadonlyArray<T>,
  query: SearchQuery,
  limit: number,
): SearchResult<T> {
  const pattern = buildPattern(query);
  const found: Array<Match<T>> = [];
  let truncated = false;
  for (let i = lines.length - 1; i >= 0 && !truncated; i--) {
    const line = lines[i];
    pattern.lastIndex = 0;
    const inLine: Array<Match<T>> = [];
    for (let m = pattern.exec(line.text); m; m = pattern.exec(line.text)) {
      if (m[0].length === 0)
        pattern.lastIndex++; // an empty match would loop forever
      else inLine.push({ line, start: m.index, end: m.index + m[0].length });
    }
    for (let j = inLine.length - 1; j >= 0; j--) {
      if (found.length >= limit) {
        truncated = true;
        break;
      }
      found.push(inLine[j]);
    }
  }
  return { matches: found.reverse(), truncated };
}

export type FindMode = "incremental" | "refresh" | "next" | "previous";

// Which match is current after a search. Typing or new output keeps the current
// match while it still matches, and otherwise takes the first one at or below
// the top of the view (else the newest); next and previous step from the
// current one, wrapping. `kept` is the index of the previous current match in
// the new list, or -1 if it is gone.
export function chooseActive(mode: FindMode, count: number, kept: number, firstInView: () => number): number {
  if (count === 0) return -1;
  if (mode === "next") return kept >= 0 ? (kept + 1) % count : firstInView();
  if (mode === "previous") return kept >= 0 ? (kept - 1 + count) % count : count - 1;
  return kept >= 0 ? kept : firstInView();
}
