import type { LogChain } from "./log-pane";
import { findMatches, type SearchQuery } from "./scrollback-search";

// A match the scan found in the log: on line `line` of page `k` of its chain,
// characters [start, end) of it.
export interface LogHit {
  k: number;
  line: number;
  start: number;
  end: number;
}

// The most hits a scan remembers; past that it goes on counting them.
export const MAX_HITS = 100_000;
// The newest hits' line text is kept, to line them up with the live
// scrollback's matches (see alignLive), which keeps at most 1,000.
const TEXT_HITS = 5_000;

// Searches a whole chain of the log, from its end back to its start, a page at
// a time, for every match: newest first, as the hits are numbered. The search
// runs here in the window: the main process only hands out pages, and never
// runs a pattern the window sent it. Pages are read into lines with `read`, as
// the history pane reads them, so a hit's line is the pane's line.
export class LogScan {
  readonly hits: LogHit[] = [];
  // The line text of the newest TEXT_HITS hits.
  readonly texts: string[] = [];
  // How many matches there are in all (more than hits.length past MAX_HITS).
  count = 0;
  // How far back the scan has read, from 0 to 1.
  progress = 0;
  done = false;
  private cancelled = false;
  private waiters: Array<() => void> = [];

  constructor(
    readonly chain: LogChain,
    private readonly query: SearchQuery,
    private readonly read: (
      chunks: ReadonlyArray<Uint8Array>,
      times: ReadonlyArray<number | null>,
    ) => ReadonlyArray<{ text: string }>,
    // Told after each page: hits found, progress made, or the scan done.
    private readonly onUpdate: () => void,
  ) {}

  // Reads the chain to its start, unless cancelled first. A log rewritten under
  // it ends the scan as it is.
  async run(): Promise<void> {
    try {
      // The next page is asked for before this one is searched, so main reads
      // it meanwhile.
      let next = this.chain.has(0) ? this.chain.page(0) : null;
      for (let k = 0; !this.cancelled && next; k++) {
        const page = await next;
        if (this.cancelled || !page) break;
        next = this.chain.has(k + 1) ? this.chain.page(k + 1) : null;
        const lines = this.read(page.chunks, page.times);
        const { matches } = findMatches(lines, this.query, Number.POSITIVE_INFINITY);
        // Newest first: the page's last match is the first found.
        const lineOf = new Map(lines.map((line, i) => [line, i]));
        for (let i = matches.length - 1; i >= 0; i--) {
          const { line, start, end } = matches[i];
          this.count++;
          if (this.hits.length < MAX_HITS) this.hits.push({ k, line: lineOf.get(line) ?? 0, start, end });
          if (this.texts.length < TEXT_HITS) this.texts.push(line.text);
        }
        this.progress = this.chain.progress(k);
        this.wake();
        this.onUpdate();
      }
    } finally {
      this.done = true;
      this.progress = 1;
      this.wake();
      if (!this.cancelled) this.onUpdate();
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.wake();
  }

  // Resolves once hit `index` is found, or the scan is done or cancelled.
  async reach(index: number): Promise<void> {
    while (this.hits.length <= index && !this.done && !this.cancelled) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  // Resolves once the scan is done or cancelled.
  async finish(): Promise<void> {
    while (!this.done && !this.cancelled) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

// Which of a scan's newest hits are matches the live scrollback shows. The live
// scrollback holds the newest lines, so its matches, newest first, are the
// scan's first hits, after any that came in since the scan began. `live` is the
// live scrollback's matches, newest first, as line text and start; `hits` the
// scan's newest hits' text and start. Returns how many live matches are newer
// than the scan's first hit (`newer`), and how many after those are the scan's
// first hits (`shared`). Lined up by text, so a line one has and the other
// doesn't (a line the window wasn't sent, say) only shifts the count.
export function alignLive(
  live: ReadonlyArray<{ text: string; start: number }>,
  hits: ReadonlyArray<{ text: string; start: number }>,
): { newer: number; shared: number } {
  if (hits.length === 0) return { newer: live.length, shared: 0 };
  const same = (a: { text: string; start: number }, b: { text: string; start: number }) =>
    a.text === b.text && a.start === b.start;
  // The first live match that, with the ones after it, matches the first hits.
  let best = { newer: live.length, shared: 0 };
  for (let newer = 0; newer < live.length; newer++) {
    if (!same(live[newer], hits[0])) continue;
    let shared = 0;
    while (newer + shared < live.length && shared < hits.length && same(live[newer + shared], hits[shared])) shared++;
    if (shared > best.shared) best = { newer, shared };
    if (newer + shared === live.length || shared === hits.length) break;
  }
  return best;
}
