import {
  MAX_HELD_LINES,
  SCROLLBACK_LINES,
  type HistoryPage,
  type HistoryRequest,
  type LogCursor,
} from "./history-paging";
import type { LiveReplay } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";

// What HistoryWindow needs of the scrollback (ScrollbackView, or a test's
// stand-in). Lines are added and dropped without moving what is on screen.
export interface HistoryView {
  readonly lineCount: number;
  readonly hasTrimmed: boolean;
  setTrimming(trimming: boolean): void;
  nearTop(): boolean;
  nearBottom(): boolean;
  settledAtBottom(): boolean;
  linesNearView(): { first: number; last: number };
  prepend(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
  append(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
  catchUp(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): void;
  dropFront(count: number): void;
  dropBack(count: number): void;
  distanceFromBottom(): number;
  scrollToDistanceFromBottom(distance: number): void;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  showHistory(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): number;
}

// Where history comes from: the main process, through window.moolin.
export interface HistorySource {
  getScrollback(): Promise<ScrollbackReplay>;
  getHistoryPage(request: HistoryRequest): Promise<HistoryPage>;
}

// A page of history the view holds: how many lines it made, and where it starts
// and ends in the log.
interface Page {
  lines: number;
  before: LogCursor | null;
  after: LogCursor;
}

function sameCursor(a: LogCursor | null, b: LogCursor | null): boolean {
  return a === b || (a !== null && b !== null && a.offset === b.offset && a.skip === b.skip);
}

// Pages a character's history through the scrollback as the view nears its
// top or bottom. The view holds the live lines (the replay, then live output)
// and pages of older history in front of them, up to MAX_HELD_LINES in all.
// Past that, whole pages are dropped from the end away from the view; when
// that end is the live lines, they are let go of too, and live output isn't
// shown until scrolling back down has paged forward to it again. Back at the
// bottom with live output, the pages are let go of, so the scrollback keeps to
// its usual size. Only a replay from the log can be paged through.
export class HistoryWindow {
  // Pages held besides the live lines, oldest first: all older than them, or,
  // while the live lines are let go of, all there is.
  private pages: Page[] = [];
  // Where the live lines start in the log, or null while they are let go of.
  private live: { before: LogCursor | null } | null = { before: null };
  private fromLog = false;
  // Counts the replays written, so a page fetched for an earlier one is not
  // added to a later.
  private replays = 0;
  // Tasks queued or running; while there are any, nothing else changes the pages.
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  // Dropping lines tells the view's listeners, which come back to linesAdded.
  private enforcing = false;

  constructor(
    private readonly view: HistoryView,
    private readonly source: HistorySource,
    private readonly events: LiveReplay,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  // Whether live output is shown: not while the live lines are let go of to
  // hold older history.
  get showsLive(): boolean {
    return this.live !== null;
  }

  // A replay was written: the first, a reset, or one started over from.
  replayed(replay: ScrollbackReplay): void {
    this.replays++;
    this.fromLog = replay.fromLog;
    this.pages = [];
    this.live = { before: replay.before };
    this.view.setTrimming(true);
  }

  // The view scrolled: pages history in or out as its place calls for.
  scrolled(): void {
    if (this.pending > 0) return;
    if (this.live && this.pages.length > 0 && this.view.settledAtBottom()) this.release();
    if (!this.fromLog) return;
    if (this.view.nearTop() && this.olderAvailable()) void this.queue(() => this.loadOlder());
    else if (!this.live && this.view.nearBottom()) void this.queue(() => this.loadNewer());
  }

  // Lines were added at the bottom (live output): keeps within the cap.
  linesAdded(): void {
    if (this.pending === 0 && this.pages.length > 0) this.enforceCap("back");
  }

  // Whether the newest line is on screen: live output shown, at the bottom.
  atNewest(): boolean {
    return this.live !== null && this.view.isAtBottom();
  }

  // Goes to the newest line (End, or the screen cleared): to the bottom, paging
  // back to live output first if it was let go of.
  async toNewest(): Promise<void> {
    await this.queue(async () => {
      // At the bottom, the scroll lets go of the pages held (see scrolled).
      if (this.live) this.view.scrollToBottom();
      else await this.startOver(false);
    });
  }

  // Whether the history can be searched beyond the lines held: only a replay
  // from the log can.
  get searchable(): boolean {
    return this.fromLog;
  }

  // Whether the view holds all of the history there is to search.
  get holdsAll(): boolean {
    return !this.fromLog || (this.live !== null && !this.olderAvailable());
  }

  // Where the history older than the view's oldest line ends, or null when
  // there is none. Lines trimmed off the top since the replay mean starting over
  // from an exact one first.
  async olderCursor(): Promise<LogCursor | null> {
    const cursor = await this.queue(async () => {
      if (!this.fromLog) return null;
      if (this.pages.length === 0 && this.view.hasTrimmed && !(await this.startOver(true))) return null;
      return this.pages.length > 0 ? this.pages[0].before : (this.live?.before ?? null);
    });
    return cursor ?? null;
  }

  // Where the history newer than the view's newest line starts, or null when
  // the view shows live output, so nothing is newer.
  newerCursor(): LogCursor | null {
    return this.live === null && this.pages.length > 0 ? this.pages[this.pages.length - 1].after : null;
  }

  // Shows a page of history a search found, in place of everything held. A page
  // that reaches the end of the log is shown by starting over from the replay,
  // which ends as it does.
  async show(page: HistoryPage): Promise<void> {
    await this.queue(async () => {
      if (page.after === null) {
        await this.startOver(false);
        return;
      }
      this.replays++;
      this.live = null;
      this.pages = [];
      this.view.setTrimming(false);
      const lines = this.view.showHistory(page.chunks, page.times);
      this.pages = [{ lines, before: page.before, after: page.after }];
    });
  }

  // The log was rewritten, so the places held in it no longer fit: starts over
  // from a fresh replay, where the view was if it is showing live output.
  async rewritten(): Promise<void> {
    if (this.fromLog) await this.queue(() => this.startOver(this.live !== null));
  }

  // Runs `task` after any before it, so only one changes the pages at a time.
  // Undefined if it failed (which is logged).
  private queue<T>(task: () => Promise<T>): Promise<T | undefined> {
    this.pending++;
    const run = this.chain.then(async () => {
      try {
        return await task();
      } catch (error) {
        this.warn(`could not page through the history: ${String(error)}`);
        return undefined;
      } finally {
        this.pending--;
      }
    });
    this.chain = run.then(() => {});
    // The view may want more once this is done.
    void run.then(() => this.scrolled());
    return run;
  }

  // Whether the log holds history older than the view's oldest line: before
  // the oldest page, or before the live lines (or lines trimmed off the top).
  private olderAvailable(): boolean {
    if (this.pages.length > 0) return this.pages[0].before !== null;
    return this.live !== null && (this.live.before !== null || this.view.hasTrimmed);
  }

  private pagedLines(): number {
    return this.pages.reduce((sum, page) => sum + page.lines, 0);
  }

  // Adds pages before the oldest line held, for as long as the view is near the
  // top and there is more.
  private async loadOlder(): Promise<void> {
    // Where the view was before starting over, measured from the bottom, while
    // the replay is too short to reach it, and where it was put instead.
    let lost: { want: number; at: number } | null = null;
    while (this.fromLog && this.view.nearTop() && this.olderAvailable()) {
      if (this.pages.length === 0 && this.view.hasTrimmed) {
        // Lines trimmed off the top since the replay are not what its cursor
        // follows, so start over from a replay that is exact. It may hold fewer
        // lines than the view did (which trims only once well past its cap,
        // and the replay is limited in bytes too), putting the view's place
        // above its top; the pages before it bring that back.
        const want = this.view.distanceFromBottom();
        if (!(await this.startOver(true))) return;
        const at = this.view.distanceFromBottom();
        lost = at < want - 1 ? { want, at } : null;
        continue;
      }
      const before = this.pages.length > 0 ? this.pages[0].before : (this.live?.before ?? null);
      if (before === null) return;
      const mine = this.replays;
      const page = await this.source.getHistoryPage({ before });
      if (this.replays !== mine) continue; // a reset or a new replay came first
      if (page.stale) {
        await this.startOver(false);
        return;
      }
      const lines = page.chunks.length > 0 ? this.view.prepend(page.chunks, page.times) : 0;
      // A page that doesn't move on means there is nothing older to be had.
      const stuck = lines === 0 && sameCursor(page.before, before);
      this.pages.unshift({ lines, before: stuck ? null : page.before, after: before });
      this.view.setTrimming(false);
      // Back to the place lost, unless the view was scrolled from where it was
      // put meanwhile (prepending keeps that distance from the bottom).
      if (lost && Math.abs(this.view.distanceFromBottom() - lost.at) <= 1) {
        this.view.scrollToDistanceFromBottom(lost.want);
        const at = this.view.distanceFromBottom();
        lost = at < lost.want - 1 ? { want: lost.want, at } : null;
      } else {
        lost = null;
      }
      this.enforceCap("back");
    }
  }

  // Adds pages after the newest line held, while the live lines are let go of,
  // for as long as the view is near the bottom; the page that reaches the end of
  // the log brings live output back.
  private async loadNewer(): Promise<void> {
    while (!this.live && this.view.nearBottom()) {
      const after = this.pages[this.pages.length - 1].after;
      // Live output is held while the page is fetched, so the page that reaches
      // the end can be gone on from without losing or repeating any.
      this.events.hold();
      let page: HistoryPage;
      try {
        page = await this.source.getHistoryPage({ after });
      } catch (error) {
        this.events.resume();
        throw error;
      }
      if (page.stale) {
        this.events.resume();
        await this.startOver(false);
        return;
      }
      if (page.after === null) {
        // If a reset came first, it has replaced everything already.
        if (this.events.catchUp(page.seq, () => this.view.catchUp(page.chunks, page.times))) {
          this.live = { before: after };
          this.enforceCap("front");
        }
        return;
      }
      this.events.resume();
      const lines = page.chunks.length > 0 ? this.view.append(page.chunks, page.times) : 0;
      if (lines === 0 && sameCursor(page.after, after)) {
        await this.startOver(false);
        return;
      }
      this.pages.push({ lines, before: after, after: page.after });
      this.enforceCap("front");
    }
  }

  // Back at the bottom with live output: lets go of the oldest pages held, down
  // to the scrollback's usual size, and counts those left as live lines, so the
  // scrollback's own cap applies again.
  private release(): void {
    let excess = this.view.lineCount - SCROLLBACK_LINES;
    let dropped = 0;
    while (this.pages.length > 0 && this.pages[0].lines <= excess) {
      const page = this.pages.shift() as Page;
      dropped += page.lines;
      excess -= page.lines;
    }
    if (this.pages.length > 0 && this.live) this.live = { before: this.pages[0].before };
    this.pages = [];
    this.view.setTrimming(true);
    this.view.dropFront(dropped);
    this.view.scrollToBottom();
  }

  // Drops whole pages (or the live lines) while the view holds more than
  // MAX_HELD_LINES, from the end `prefer` names if it is out of view, otherwise
  // from the other end. Never what is on or near the screen, and never all of it.
  private enforceCap(prefer: "front" | "back"): void {
    if (this.enforcing) return;
    this.enforcing = true;
    try {
      this.keepToCap(prefer);
    } finally {
      this.enforcing = false;
    }
  }

  private keepToCap(prefer: "front" | "back"): void {
    while (this.view.lineCount > MAX_HELD_LINES && this.pages.length > 0) {
      const total = this.view.lineCount;
      const near = this.view.linesNearView();
      const canDrop = this.pages.length > 1 || this.live !== null;
      const backLines = this.live ? total - this.pagedLines() : this.pages[this.pages.length - 1].lines;
      const front = canDrop && near.first >= this.pages[0].lines;
      const back = canDrop && near.last < total - backLines;
      if ((prefer === "back" && back) || (back && !front)) this.dropBack(backLines);
      else if (front) this.dropFront();
      else return;
    }
  }

  private dropFront(): void {
    const page = this.pages.shift() as Page;
    if (this.pages.length === 0 && this.live) this.view.setTrimming(true);
    this.view.dropFront(page.lines);
  }

  // The pages are brought up to date before the view, which tells its listeners.
  private dropBack(lines: number): void {
    if (this.live) this.live = null;
    else this.pages.pop();
    this.view.dropBack(lines);
  }

  // Fetches the replay again and starts from it, either where the view was,
  // measured from the bottom (the newest lines are the same), or at the bottom.
  private async startOver(keepPlace: boolean): Promise<boolean> {
    const distance = this.view.distanceFromBottom();
    this.events.hold();
    try {
      this.events.replay(await this.source.getScrollback());
    } catch (error) {
      this.events.resume();
      this.warn(`could not fetch the log again: ${String(error)}`);
      return false;
    }
    if (keepPlace) this.view.scrollToDistanceFromBottom(distance);
    else this.view.scrollToBottom();
    return true;
  }
}
