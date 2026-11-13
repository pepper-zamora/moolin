import type { HistoryPage, HistoryRequest } from "./history-paging";
import type { HistoryPane } from "./history-pane";
import type { Line } from "./line-builder";
import { LogChain } from "./log-pane";
import { LogScan } from "./log-scan";
import type { ScrollbackView } from "./scrollback-view";
import { buildPattern, findMatches, type Match, type SearchQuery, type SearchResult } from "./scrollback-search";

// Most matches highlighted in a pane (and counted, without a log); past this
// the count shows as "1000+", and the oldest matches are the ones left out.
const MATCH_LIMIT = 1000;

// How long after output or a resize the matches are searched for again.
const REFRESH_DELAY_MS = 150;

// How long after the search term last changed the log is searched for it.
const SCAN_DELAY_MS = 300;

// How long a search of the log runs before the status bar says how it's going.
const PROGRESS_DELAY_MS = 1000;

// Match colours follow VS Code's dark theme (the highlight colours themselves
// are in styles.css, under ::highlight()).
const RULER_MATCH = "#d18616";
const RULER_ACTIVE = "#a0a0a0";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function setHighlight(name: string, ranges: Range[]): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (ranges.length === 0) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
}

// A strip over the scrollbar's track marking where the matches are, the way
// the editor's overview ruler does.
class SearchRuler {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: ScrollbackView,
  ) {}

  draw(matches: ReadonlyArray<Match<Line>>, active: Match<Line> | null): void {
    const scale = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    const context = this.canvas.getContext("2d");
    const total = this.view.contentHeight();
    if (!context || total === 0) return;
    const tick = Math.max(2, Math.round(2 * scale));
    const y = (match: Match<Line>) =>
      Math.min(this.canvas.height - tick, Math.round((this.view.lineOffset(match.line) / total) * this.canvas.height));
    context.fillStyle = RULER_MATCH;
    for (const match of matches) context.fillRect(0, y(match), this.canvas.width, tick);
    if (active) {
      context.fillStyle = RULER_ACTIVE;
      context.fillRect(0, y(active), this.canvas.width, tick);
    }
  }

  clear(): void {
    this.canvas.width = this.canvas.width; // resizing a canvas wipes it
  }

  set hidden(hidden: boolean) {
    this.canvas.hidden = hidden;
  }
}

// The current match: one the live scrollback shows, or a hit of the log search.
type Current = { kind: "live"; match: Match<Line> } | { kind: "log"; hit: number };

export interface LogAccess {
  getPage(request: HistoryRequest): Promise<HistoryPage>;
  // Whether the window has a log to search: only a replay from one does.
  available(): boolean;
}

// The find box floating at the top right of the panes, modelled on VS Code's
// editor find widget (minus replace, since the scrollback is read-only).
//
// Matches on screen are highlighted, in both panes, and marked on a ruler beside
// the live scrollback's scrollbar; they stay current as new output arrives.
// With a log, the whole log is searched, from its end back, in the background
// while the term stands, and the matches are numbered newest first, "3 of 25".
// Enter (and F3, ↑) goes to the next older match, Shift+Enter (Shift+F3, ↓) the
// next newer, from where the history pane is (or the newest line), wrapping
// around at the ends of the log. Each is shown in the history pane, in one move
// once found, so the live scrollback stays at the newest line. While a step
// waits on the search, the status bar says how far it has got. Without a log,
// it steps through the live scrollback's own matches, scrolling to them there.
export class FindWidget {
  readonly root = element<HTMLDivElement>("find-widget");
  private readonly input = element<HTMLInputElement>("find-input");
  private readonly count = element<HTMLSpanElement>("find-count");
  private readonly toggles = {
    caseSensitive: element<HTMLButtonElement>("find-case"),
    wholeWord: element<HTMLButtonElement>("find-word"),
    regex: element<HTMLButtonElement>("find-regex"),
  };
  private readonly ruler: SearchRuler;
  private readonly historyRuler: SearchRuler;
  // The live scrollback's matches, oldest first, and whether older ones were
  // left out past MATCH_LIMIT.
  private live: Array<Match<Line>> = [];
  private liveTruncated = false;
  // The history pane's matches, for highlighting.
  private paned: Array<Match<Line>> = [];
  private current: Current | null = null;
  private scan: LogScan | null = null;
  // The term and options the scan is of, and when it began.
  private scanKey = "";
  private scanStarted = 0;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshScheduled = false;
  // Counts steps, so a step waiting on the scan gives way to a later one.
  private steps = 0;
  private waiting = false;

  constructor(
    private readonly view: ScrollbackView,
    private readonly history: HistoryPane,
    private readonly log: LogAccess,
    private readonly status: HTMLElement,
    // Called after the widget closes, to hand focus back.
    private readonly onClose: () => void,
  ) {
    this.ruler = new SearchRuler(element<HTMLCanvasElement>("search-ruler"), view);
    this.historyRuler = new SearchRuler(element<HTMLCanvasElement>("history-ruler"), history.view);
    // New output (or a resize) can add, remove and move matches; the history
    // pane paging changes which of its lines are there to highlight.
    view.onChange(() => this.scheduleRefresh());
    history.view.onChange(() => this.scheduleRefresh());

    this.input.addEventListener("input", () => this.find());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.step(event.shiftKey ? "newer" : "older");
      }
    });
    // Keep VS Code's Alt+C/W/R toggles while focus is anywhere in the widget.
    this.root.addEventListener("keydown", (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const toggle = { c: "caseSensitive", w: "wholeWord", r: "regex" }[event.key.toLowerCase()];
      if (!toggle) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggle(toggle as keyof FindWidget["toggles"]);
    });

    for (const [option, button] of Object.entries(this.toggles)) {
      button.addEventListener("click", () => this.toggle(option as keyof FindWidget["toggles"]));
    }
    element<HTMLButtonElement>("find-older").addEventListener("click", () => void this.step("older"));
    element<HTMLButtonElement>("find-newer").addEventListener("click", () => void this.step("newer"));
    element<HTMLButtonElement>("find-close").addEventListener("click", () => this.close());
    // Clicking a button shouldn't pull focus out of the search field.
    for (const button of this.root.querySelectorAll("button")) {
      button.addEventListener("mousedown", (event) => event.preventDefault());
    }
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  // Shows the widget and focuses the search field with its text selected,
  // seeded from a single-line scrollback selection when there is one.
  open(): void {
    const selection = this.history.view.selectedText() || this.view.selectedText();
    if (selection.length > 0 && !selection.includes("\n")) this.input.value = selection;
    const wasOpen = this.isOpen();
    this.root.hidden = false;
    this.ruler.hidden = false;
    this.historyRuler.hidden = false;
    this.input.focus();
    this.input.select();
    if (!wasOpen || selection.length > 0) this.find();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    this.ruler.hidden = true;
    this.historyRuler.hidden = true;
    this.stopScan();
    this.steps++;
    this.current = null;
    this.clearResults();
    this.onClose();
  }

  // F3 / Shift+F3, Cmd+G / Cmd+Shift+G, and the Edit menu's Find Next/Previous
  // (older and newer): with nothing to search for yet, open the widget so there's
  // somewhere to type it.
  findFromMenu(direction: "older" | "newer"): void {
    if (!this.isOpen() || this.input.value === "") {
      this.open();
      return;
    }
    void this.step(direction);
  }

  private toggle(option: keyof FindWidget["toggles"]): void {
    const button = this.toggles[option];
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    this.find();
  }

  private query(): SearchQuery {
    const pressed = (button: HTMLButtonElement) => button.getAttribute("aria-pressed") === "true";
    return {
      text: this.input.value,
      caseSensitive: pressed(this.toggles.caseSensitive),
      wholeWord: pressed(this.toggles.wholeWord),
      regex: pressed(this.toggles.regex),
    };
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled || !this.isOpen() || this.input.value === "") return;
    this.refreshScheduled = true;
    // Output can arrive every frame; searching all the lines that often would
    // cost more than keeping the highlights that current is worth.
    setTimeout(() => {
      this.refreshScheduled = false;
      if (this.isOpen() && this.input.value !== "") this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private clearResults(): void {
    this.live = [];
    this.paned = [];
    this.liveTruncated = false;
    setHighlight("find-match", []);
    setHighlight("find-active", []);
    this.ruler.clear();
    this.historyRuler.clear();
  }

  // The term or options changed: searches the live scrollback again, staying on
  // the current match while it still matches (as VS Code does on typing), or
  // taking the first one at or below the top of the view (else the newest), and
  // starts searching the log for it.
  private find(): void {
    this.steps++;
    this.root.classList.remove("invalid");
    if (this.input.value === "") {
      this.stopScan();
      this.current = null;
      this.clearResults();
      this.count.textContent = "No results";
      this.root.classList.remove("no-results");
      return;
    }
    try {
      buildPattern(this.query());
    } catch {
      // An unfinished regex (e.g. "foo(") — wait for the user to complete it.
      this.stopScan();
      this.current = null;
      this.clearResults();
      this.root.classList.add("invalid");
      this.count.textContent = "Invalid pattern";
      return;
    }
    if (this.scanKey !== JSON.stringify(this.query())) {
      this.stopScan();
      this.scheduleScan();
    }
    const kept = this.current?.kind === "live" ? this.current.match : null;
    this.searchPanes();
    if (this.log.available()) {
      // The matches are the log's, stepped through in the history pane; none is
      // current until a step.
      this.current = null;
    } else {
      const match = (kept && this.liveMatching(kept)) ?? this.firstInView();
      this.current = match ? { kind: "live", match } : null;
      if (match) this.view.revealLine(match.line);
    }
    this.show();
  }

  // New output, a resize, or the history pane paging: the same search again,
  // keeping the current match, without moving either pane.
  private refresh(): void {
    try {
      buildPattern(this.query());
    } catch {
      return;
    }
    const kept = this.current?.kind === "live" ? this.current.match : null;
    this.searchPanes();
    if (kept) {
      const match = this.liveMatching(kept);
      this.current = match ? { kind: "live", match } : null;
    }
    this.show();
  }

  private searchPanes(): void {
    const query = this.query();
    const live: SearchResult<Line> = findMatches(this.view.allLines(), query, MATCH_LIMIT);
    this.live = live.matches;
    this.liveTruncated = live.truncated;
    this.paned = this.history.isOpen ? findMatches(this.history.view.allLines(), query, MATCH_LIMIT).matches : [];
  }

  // The live match that is `match` again after a new search, if there is one.
  private liveMatching(match: Match<Line>): Match<Line> | null {
    return this.live.find((m) => m.line === match.line && m.start === match.start) ?? null;
  }

  // The first live match at or below the top of the view, else the newest.
  private firstInView(): Match<Line> | null {
    const top = this.view.scrollTop();
    return this.live.find((m) => this.view.lineOffset(m.line) >= top) ?? this.live.at(-1) ?? null;
  }

  // --- The log ---------------------------------------------------------------

  private scheduleScan(): void {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.startScan();
    }, SCAN_DELAY_MS);
  }

  private async startScan(): Promise<LogScan | null> {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    const key = JSON.stringify(this.query());
    if (this.scan && this.scanKey === key) return this.scan;
    this.stopScan();
    if (!this.log.available() || !this.isOpen() || this.input.value === "") return null;
    this.scanKey = key;
    const query = this.query();
    const chain = await LogChain.start((request) => this.log.getPage(request));
    if (!chain || this.scanKey !== key || this.scan) return this.scan;
    const scan = new LogScan(
      chain,
      query,
      (chunks, times) => this.history.read(chunks, times),
      () => {
        if (this.scan !== scan) return;
        this.showProgress();
        this.show();
      },
    );
    this.scan = scan;
    this.scanStarted = Date.now();
    void scan.run();
    // The status bar shows how it's going once it has run a while.
    setTimeout(() => this.showProgress(), PROGRESS_DELAY_MS);
    return scan;
  }

  private stopScan(): void {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.scan?.cancel();
    this.scan = null;
    this.scanKey = "";
    this.showProgress();
  }

  private showProgress(): void {
    const scan = this.scan;
    const running = scan !== null && !scan.done && (this.waiting || Date.now() - this.scanStarted >= PROGRESS_DELAY_MS);
    this.status.hidden = !running;
    if (!running || !scan) return;
    const percent = Math.floor(scan.progress * 100);
    const found = scan.count === 1 ? "1 found" : `${scan.count.toLocaleString()} found`;
    this.status.textContent = `Searching for “${this.input.value}”… ${percent}%, ${found}`;
  }

  // --- Stepping through the matches ----------------------------------------------

  // The matches in order, newest first: with a log, the scan's hits, all shown
  // in the history pane (the live scrollback stays at the newest line);
  // without one, the live scrollback's own matches. `newer` counts the live
  // matches before the scan's hits: all of them without a scan, none with one.
  private order(): { live: Array<Match<Line>>; newer: number } {
    const live = [...this.live].reverse();
    return { live, newer: this.scan ? 0 : live.length };
  }

  // Where the current match is in the order, or -1.
  private indexOf(current: Current | null, order: ReturnType<FindWidget["order"]>): number {
    if (!current) return -1;
    if (current.kind === "log") return order.newer + current.hit;
    return order.live.indexOf(current.match);
  }

  private async step(direction: "older" | "newer"): Promise<void> {
    if (this.input.value === "" || this.root.classList.contains("invalid")) return;
    const mine = ++this.steps;
    // The search of the log, at once if it was waiting on the term to settle.
    const scan = this.log.available() ? await this.startScan() : null;
    if (mine !== this.steps) return;
    let order = this.order();
    const index = this.indexOf(this.current, order);
    let target: number;
    if (index >= 0) target = index + (direction === "older" ? 1 : -1);
    else if (scan) {
      target = await this.startInLog(scan, direction);
      if (mine !== this.steps || this.scan !== scan) return;
    } else target = direction === "older" ? this.startOlder(order) : -1;
    const known = () => (scan ? order.newer + scan.hits.length : order.live.length);
    if (scan && (target >= known() || target < 0) && !scan.done) {
      // Past the matches found so far: wait for the search to find the next, or
      // (going round from the newest) to finish.
      this.waiting = true;
      this.showProgress();
      try {
        if (target < 0) await scan.finish();
        else await scan.reach(target - order.newer);
      } finally {
        this.waiting = false;
        this.showProgress();
      }
      if (mine !== this.steps || this.scan !== scan) return;
      order = this.order();
    }
    const total = known();
    if (total === 0) {
      this.show();
      return;
    }
    target = ((target % total) + total) % total;
    await this.go(target, order);
  }

  // Where a step starts from in the log without a current match: from where the
  // history pane is, if it is open on the scan's chain, else from the newest
  // line. Going older, the nearest hit at or above the pane's bottom edge
  // (waiting for the scan to get that far); going newer, the nearest at or
  // below its top edge. -1, or past the hits, goes round.
  private async startInLog(scan: LogScan, direction: "older" | "newer"): Promise<number> {
    const edges = this.history.edges(scan.chain);
    if (direction === "older") {
      if (!edges) return 0;
      const { k, line } = edges.bottom;
      const above = (hit: { k: number; line: number }) => hit.k > k || (hit.k === k && hit.line <= line);
      for (;;) {
        const index = scan.hits.findIndex(above);
        if (index >= 0) return index;
        if (scan.done || this.scan !== scan) return scan.hits.length;
        await scan.reach(scan.hits.length);
      }
    }
    if (!edges) return -1;
    const { k, line } = edges.top;
    const below = (hit: { k: number; line: number }) => hit.k < k || (hit.k === k && hit.line >= line);
    let last = -1;
    for (let i = 0; i < scan.hits.length && below(scan.hits[i]); i++) last = i;
    return last;
  }

  // Where going older starts from without a current match and without a log:
  // the newest live match at or above the bottom of the view.
  private startOlder(order: ReturnType<FindWidget["order"]>): number {
    const bottom = this.view.scrollTop() + this.view.element.clientHeight;
    const index = order.live.findIndex((m) => this.view.lineOffset(m.line) < bottom);
    return index >= 0 ? index : 0;
  }

  private async go(index: number, order: ReturnType<FindWidget["order"]>): Promise<void> {
    const mine = this.steps;
    if (index < order.newer) {
      const match = order.live[index];
      this.current = { kind: "live", match };
      this.view.revealLine(match.line);
      this.show();
      return;
    }
    const scan = this.scan;
    const hit = scan?.hits[index - order.newer];
    if (!scan || !hit) return;
    this.current = { kind: "log", hit: index - order.newer };
    await this.history.showPage(scan.chain, hit.k, { line: hit.line, at: "center" });
    if (mine !== this.steps) return;
    this.searchPanes();
    this.show();
  }

  // --- Showing it ----------------------------------------------------------------

  private show(): void {
    const order = this.order();
    const current = this.current;
    let active: Range | null = null;
    let liveActive: Match<Line> | null = null;
    let paneActive: Match<Line> | null = null;
    if (current?.kind === "live") {
      liveActive = current.match;
      active = this.view.rangeFor(current.match.line, current.match.start, current.match.end);
    } else if (current?.kind === "log" && this.scan) {
      const hit = this.scan.hits[current.hit];
      const line = hit ? this.history.lineAt(this.scan.chain, hit.k, hit.line) : null;
      if (hit && line) {
        active = this.history.view.rangeFor(line, hit.start, hit.end);
        paneActive = { line, start: hit.start, end: hit.end };
      }
    }
    const ranges = [
      ...this.live.map((m) => this.view.rangeFor(m.line, m.start, m.end)),
      ...this.paned.map((m) => this.history.view.rangeFor(m.line, m.start, m.end)),
    ];
    setHighlight(
      "find-match",
      ranges.filter((r): r is Range => r !== null),
    );
    setHighlight("find-active", active ? [active] : []);
    this.ruler.draw(this.live, liveActive);
    if (this.history.isOpen) this.historyRuler.draw(this.paned, paneActive);
    else this.historyRuler.clear();
    this.showCount(this.indexOf(current, order), order);
  }

  private showCount(index: number, order: ReturnType<FindWidget["order"]>): void {
    const scan = this.scan;
    let total: string;
    let none: boolean;
    if (scan) {
      const count = order.newer + scan.count;
      total = `${count.toLocaleString()}${scan.done ? "" : "…"}`;
      none = count === 0 && scan.done;
    } else {
      total = this.liveTruncated ? `${MATCH_LIMIT}+` : String(this.live.length);
      none = this.live.length === 0 && !this.scanTimer;
    }
    this.root.classList.toggle("no-results", none);
    if (none) this.count.textContent = "No results";
    else if (index < 0) this.count.textContent = `? of ${total}`;
    else this.count.textContent = `${(index + 1).toLocaleString()} of ${total}`;
  }
}
