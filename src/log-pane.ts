import { MAX_HELD_LINES, type HistoryPage, type HistoryRequest, type LogCursor } from "./history-paging";

// A walk back through a character's log from where it ended when the walk
// began, a page at a time: page 0 ends at that end, and page k + 1 ends where
// page k begins. The log only grows at its end, so page k is the same page
// whenever it is asked for (see HistoryPage.end), and the history pane and a
// search on the same chain can name a line as page and line within it and mean
// the same line.
export class LogChain {
  // Where each page ends, as far as is known: ends[k] for page k, null where
  // the log's start was reached (there is no page k). Each page read tells
  // where the next ends.
  private readonly ends: Array<LogCursor | null>;

  private constructor(
    private readonly getPage: (request: HistoryRequest) => Promise<HistoryPage>,
    end: LogCursor,
  ) {
    this.ends = [end];
  }

  // A chain from the log's end as it is now, or null if the log is empty or
  // can't be read.
  static async start(getPage: (request: HistoryRequest) => Promise<HistoryPage>): Promise<LogChain | null> {
    const tail = await getPage({ before: null });
    if (tail.stale || tail.end === null) return null;
    const chain = new LogChain(getPage, tail.end);
    chain.ends.push(tail.before);
    return chain;
  }

  // Whether page k exists: true, false (before the log's start, or k < 0), or
  // null when that isn't known until the page after it has been read.
  has(k: number): boolean | null {
    if (k < 0) return false;
    if (k >= this.ends.length) return null;
    return this.ends[k] !== null;
  }

  // Page k, which must be known to exist; null if the log no longer fits the
  // chain (it was rewritten), or k isn't known to exist.
  async page(k: number): Promise<HistoryPage | null> {
    const end = this.has(k) ? this.ends[k] : null;
    if (end === null) return null;
    const page = await this.getPage({ before: end });
    if (page.stale) return null;
    if (k + 1 === this.ends.length) this.ends.push(page.before);
    return page;
  }

  // How far back page k starts, from 0 at the chain's end to 1 at the log's
  // start, by bytes of the log: for showing progress.
  progress(k: number): number {
    const end = this.ends[0]?.offset ?? 0;
    const start = this.ends[k + 1];
    if (start === undefined) return 0;
    if (start === null || end <= 0) return 1;
    return Math.min(1, Math.max(0, 1 - start.offset / end));
  }
}

// What LogPane needs of the history pane's scrollback (ScrollbackView, or a
// test's stand-in). Lines are added and dropped without moving what is on screen.
export interface PaneView {
  readonly lineCount: number;
  nearTop(): boolean;
  nearBottom(): boolean;
  linesNearView(): { first: number; last: number };
  prepend(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
  append(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
  dropFront(count: number): void;
  dropBack(count: number): void;
  // Replaces every line, with the view at the top.
  showHistory(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
  // Scrolls line `index` into view: centred unless it is already, or at the
  // top or bottom edge.
  revealLineAt(index: number, at?: "center" | "top" | "bottom"): void;
  scrollToBottom(): void;
  isAtBottom(): boolean;
}

// Where the pane should be once a page is shown: a line in it (in view, or at
// the top or bottom edge), or the page's bottom.
export type PanePlace = { line: number; at?: "center" | "top" | "bottom" } | "bottom";

// The history pane's lines: a run of a chain's pages, oldest first, paged in
// as the view nears its top or bottom and dropped from the end away from the
// view past MAX_HELD_LINES. It never holds live output.
export class LogPane {
  private chain: LogChain | null = null;
  // The pages held, oldest (highest number) first, with how many lines each made.
  private pages: Array<{ k: number; lines: number }> = [];
  // Counts what has been shown, so a page fetched for something earlier is not
  // added to something later.
  private shows = 0;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly view: PaneView,
    // The log no longer fits the chain (it was rewritten): the pane should close.
    private readonly onStale: () => void,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  get isOpen(): boolean {
    return this.chain !== null;
  }

  // The chain the pane is on, if it is open.
  get currentChain(): LogChain | null {
    return this.chain;
  }

  // Whether the pane holds the newest page of its chain and is at its bottom:
  // scrolling on down means the live scrollback, below.
  atEnd(): boolean {
    return this.pages.at(-1)?.k === 0 && this.view.isAtBottom();
  }

  // Shows page k of `chain` at `place`: by scrolling to it if the pane holds
  // it, otherwise in place of everything held. Either way the pages either side
  // are paged in first, so a line near an end of its page can still be put where
  // it is wanted, with lines above and below it.
  async show(chain: LogChain, k: number, place: PanePlace): Promise<void> {
    const mine = ++this.shows;
    await this.run(async () => {
      if (this.shows !== mine) return;
      if (this.indexOf(chain, k, place) === null) {
        const page = await chain.page(k);
        if (this.shows !== mine) return;
        if (!page) return this.stale();
        this.chain = chain;
        this.pages = [{ k, lines: this.view.showHistory(page.chunks, page.times) }];
        if (place === "bottom") {
          this.view.scrollToBottom();
          return;
        }
      }
      if (place !== "bottom") {
        for (const side of [k + 1, k - 1]) {
          if (!chain.has(side) || this.pages.some((page) => page.k === side)) continue;
          const next = await chain.page(side);
          if (this.shows !== mine) return;
          if (!next) return this.stale();
          if (side > k) this.pages.unshift({ k: side, lines: this.view.prepend(next.chunks, next.times) });
          else this.pages.push({ k: side, lines: this.view.append(next.chunks, next.times) });
        }
      }
      const index = this.indexOf(chain, k, place);
      if (index === null) return;
      this.view.revealLineAt(index, place === "bottom" ? "bottom" : place.at);
      this.keepToCap("back");
    });
    this.scrolled();
  }

  // Where line `place` of page k of `chain` is among the lines held, or null if
  // the pane doesn't hold it.
  indexOf(chain: LogChain, k: number, place: PanePlace): number | null {
    if (chain !== this.chain) return null;
    let index = 0;
    for (const page of this.pages) {
      if (page.k === k) {
        if (place === "bottom") return index + page.lines - 1;
        return place.line < page.lines ? index + place.line : null;
      }
      index += page.lines;
    }
    return null;
  }

  // The page and line of `chain` that line `index` of the pane is, if the pane
  // is on that chain.
  placeOf(chain: LogChain, index: number): { k: number; line: number } | null {
    if (chain !== this.chain) return null;
    let start = 0;
    for (const page of this.pages) {
      if (index < start + page.lines) return { k: page.k, line: index - start };
      start += page.lines;
    }
    return null;
  }

  // Lets go of everything: the pane is closing.
  close(): void {
    this.shows++;
    this.chain = null;
    this.pages = [];
  }

  // The view scrolled: pages in what it is nearing, if there is more.
  scrolled(): void {
    if (this.pending > 0 || !this.chain) return;
    if (this.view.nearTop() && this.chain.has(this.oldest() + 1) !== false) void this.run(() => this.loadOlder());
    else if (this.view.nearBottom() && this.newest() > 0) void this.run(() => this.loadNewer());
  }

  private oldest(): number {
    return this.pages[0]?.k ?? 0;
  }

  private newest(): number {
    return this.pages.at(-1)?.k ?? 0;
  }

  // Runs `task` after any before it, and checks for more to page in after.
  private run(task: () => Promise<void>): Promise<void> {
    this.pending++;
    const done = this.queue.then(async () => {
      try {
        await task();
      } catch (error) {
        this.warn(`could not page through the history: ${String(error)}`);
      } finally {
        this.pending--;
      }
    });
    this.queue = done;
    void done.then(() => this.scrolled());
    return done;
  }

  private async loadOlder(): Promise<void> {
    const mine = this.shows;
    while (this.chain && this.view.nearTop()) {
      const chain = this.chain;
      const k = this.oldest() + 1;
      // The page before the oldest held is known to exist or not once that one
      // has been read, as it has.
      if (!chain.has(k)) return;
      const page = await chain.page(k);
      if (this.shows !== mine) return;
      if (!page) return this.stale();
      this.pages.unshift({ k, lines: this.view.prepend(page.chunks, page.times) });
      this.keepToCap("back");
    }
  }

  private async loadNewer(): Promise<void> {
    const mine = this.shows;
    while (this.chain && this.view.nearBottom() && this.newest() > 0) {
      const k = this.newest() - 1;
      const page = await this.chain.page(k);
      if (this.shows !== mine) return;
      if (!page) return this.stale();
      this.pages.push({ k, lines: this.view.append(page.chunks, page.times) });
      this.keepToCap("front");
    }
  }

  // Drops whole pages while more than MAX_HELD_LINES are held, from the end
  // `prefer` names if it is out of view, else from the other; never what is on
  // or near the screen, and never the last page.
  private keepToCap(prefer: "front" | "back"): void {
    while (this.view.lineCount > MAX_HELD_LINES && this.pages.length > 1) {
      const near = this.view.linesNearView();
      const first = this.pages[0];
      const last = this.pages[this.pages.length - 1];
      const front = near.first >= first.lines;
      const back = near.last < this.view.lineCount - last.lines;
      if ((prefer === "back" && back) || (back && !front)) {
        this.pages.pop();
        this.view.dropBack(last.lines);
      } else if (front) {
        this.pages.shift();
        this.view.dropFront(first.lines);
      } else {
        return;
      }
    }
  }

  private stale(): void {
    this.close();
    this.onStale();
  }
}

// Finds the line `distance` lines from the end of `chain` (1 for the last), as
// page and line within it: where the live scrollback's oldest line is in the
// log, given how many of its lines are in the log after it. The count can be a
// little out (a line the log has that the window wasn't sent, an unfinished
// line), so the line with `text` nearest the count is taken, if there is one
// within reach. Pages are read into lines with `read`, as the pane reads them.
// Null if the log no longer fits the chain; the log's first line if the
// distance reaches past its start.
export async function locateFromEnd(
  chain: LogChain,
  read: (chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>) => ReadonlyArray<{ text: string }>,
  distance: number,
  text: string,
  reach = 200,
): Promise<{ k: number; line: number } | null> {
  let after = 0;
  for (let k = 0; chain.has(k); k++) {
    const page = await chain.page(k);
    if (!page) return null;
    const lines = read(page.chunks, page.times);
    if (after + lines.length < distance && chain.has(k + 1)) {
      after += lines.length;
      continue;
    }
    const expected = Math.max(0, lines.length - (distance - after));
    for (let offset = 0; offset <= reach; offset++) {
      for (const line of [expected - offset, expected + offset]) {
        if (line >= 0 && line < lines.length && lines[line].text === text) return { k, line };
      }
    }
    return { k, line: expected };
  }
  return null;
}
