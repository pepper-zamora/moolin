import type { HistoryPage, HistoryRequest, LogCursor } from "./history-paging";
import { findMatches, type SearchQuery } from "./scrollback-search";

// A match a search of the log found: the page it is on, how many lines the page
// makes, and which of them holds the match, with the match's character offsets.
export interface LogHit {
  page: HistoryPage;
  lines: number;
  line: number;
  start: number;
  end: number;
}

function sameCursor(a: LogCursor | null, b: LogCursor | null): boolean {
  return a === b || (a !== null && b !== null && a.offset === b.offset && a.skip === b.skip);
}

// Searches the log beyond the lines the view holds, a page at a time, for the
// match nearest a place in it. Pages are read into lines just as the view reads
// them (`read`), so a match is on the same line, at the same offset, once its page
// is shown. The search runs here in the window: the main process only hands
// out pages, and never runs a pattern the window sent it.
export class LogSearch {
  constructor(
    private readonly getPage: (request: HistoryRequest) => Promise<HistoryPage>,
    private readonly read: (
      chunks: ReadonlyArray<Uint8Array>,
      times: ReadonlyArray<number | null>,
    ) => ReadonlyArray<{ text: string }>,
  ) {}

  // The newest match older than `before`, or null if there is none (or
  // `wanted` says the search is no longer wanted). Throws for a pattern that
  // isn't a regular expression.
  async older(before: LogCursor, query: SearchQuery, wanted: () => boolean): Promise<LogHit | null> {
    for (let cursor: LogCursor | null = before; cursor !== null; ) {
      const page = await this.getPage({ before: cursor });
      if (!wanted() || page.stale) return null;
      const hit = this.hitIn(page, query, "newest");
      if (hit) return hit;
      if (sameCursor(page.before, cursor)) return null;
      cursor = page.before;
    }
    return null;
  }

  // The oldest match from `after` on (the start of the log if null), or null if
  // there is none; like older.
  async newer(after: LogCursor | null, query: SearchQuery, wanted: () => boolean): Promise<LogHit | null> {
    let cursor = after;
    for (;;) {
      const page = await this.getPage({ after: cursor });
      if (!wanted() || page.stale) return null;
      const hit = this.hitIn(page, query, "oldest");
      if (hit) return hit;
      if (page.after === null || sameCursor(page.after, cursor)) return null;
      cursor = page.after;
    }
  }

  private hitIn(page: HistoryPage, query: SearchQuery, which: "newest" | "oldest"): LogHit | null {
    if (page.chunks.length === 0) return null;
    const lines = this.read(page.chunks, page.times);
    const { matches } = findMatches(lines, query, which === "newest" ? 1 : Number.POSITIVE_INFINITY);
    const match = which === "newest" ? matches[matches.length - 1] : matches[0];
    if (!match) return null;
    return { page, lines: lines.length, line: lines.indexOf(match.line), start: match.start, end: match.end };
  }
}
