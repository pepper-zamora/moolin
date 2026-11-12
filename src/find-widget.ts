import type { HistoryPage, LogCursor } from "./history-paging";
import type { Line } from "./line-builder";
import type { LogHit, LogSearch } from "./log-search";
import type { ScrollbackView } from "./scrollback-view";
import {
  chooseActive,
  findMatches,
  type FindMode,
  type Match,
  type SearchQuery,
  type SearchResult,
} from "./scrollback-search";

// Most matches highlighted (and counted); past this the count shows as
// "1000+", and the oldest matches are the ones left out.
const MATCH_LIMIT = 1000;

// How long after output or a resize the matches are searched for again.
const REFRESH_DELAY_MS = 150;

// Match colours follow VS Code's dark theme (the highlight colours themselves
// are in styles.css, under ::highlight()).
const RULER_MATCH = "#d18616";
const RULER_ACTIVE = "#a0a0a0";

// What the widget needs to search the history beyond the lines the view holds
// (HistoryWindow).
export interface SearchableHistory {
  readonly searchable: boolean;
  readonly holdsAll: boolean;
  readonly showsLive: boolean;
  olderCursor(): Promise<LogCursor | null>;
  newerCursor(): LogCursor | null;
  show(page: HistoryPage): Promise<void>;
  toNewest(): Promise<void>;
}

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

// The find box floating at the top right of the scrollback, modelled on VS
// Code's editor find widget (minus replace, since the scrollback is
// read-only). Matches are highlighted throughout the lines held and marked on a
// ruler beside the scrollbar, and stay current as new output arrives. Next and
// Previous go on past the first and last of them into the rest of the log,
// and wrap around only at its ends.
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
  private matches: Array<Match<Line>> = [];
  private active: Match<Line> | null = null;
  private refreshScheduled = false;
  // Counts searches, so a search of the log that another has replaced stops.
  private searches = 0;
  // A search of the log is under way, which the count says meanwhile.
  private searchingLog = false;

  constructor(
    private readonly view: ScrollbackView,
    private readonly history: SearchableHistory,
    private readonly logSearch: LogSearch,
    // Called after the widget closes, to hand focus back.
    private readonly onClose: () => void,
  ) {
    this.ruler = new SearchRuler(element<HTMLCanvasElement>("search-ruler"), view);
    // New output (or a resize) can add, remove and move matches.
    view.onChange(() => this.scheduleRefresh());

    this.input.addEventListener("input", () => this.find("incremental"));
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.find(event.shiftKey ? "previous" : "next");
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
    element<HTMLButtonElement>("find-prev").addEventListener("click", () => this.find("previous"));
    element<HTMLButtonElement>("find-next").addEventListener("click", () => this.find("next"));
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
    const selection = this.view.selectedText();
    if (selection.length > 0 && !selection.includes("\n")) this.input.value = selection;
    const wasOpen = this.isOpen();
    this.root.hidden = false;
    this.ruler.hidden = false;
    this.input.focus();
    this.input.select();
    if (!wasOpen || selection.length > 0) this.find("incremental");
  }

  close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    this.ruler.hidden = true;
    this.searches++;
    this.clearResults();
    this.onClose();
  }

  // F3 / Shift+F3 and the Edit menu's Find Next/Previous: with nothing to
  // search for yet, open the widget so there's somewhere to type it.
  findFromMenu(direction: "next" | "previous"): void {
    if (!this.isOpen() || this.input.value === "") {
      this.open();
      return;
    }
    this.find(direction);
  }

  private toggle(option: keyof FindWidget["toggles"]): void {
    const button = this.toggles[option];
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    this.find("incremental");
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
      if (this.isOpen() && this.input.value !== "") this.find("refresh");
    }, REFRESH_DELAY_MS);
  }

  private clearResults(): void {
    this.matches = [];
    this.active = null;
    setHighlight("find-match", []);
    setHighlight("find-active", []);
    this.ruler.clear();
  }

  // "incremental" re-runs the search as the term or options change, staying
  // on the current match while it still matches (as VS Code does on typing);
  // "refresh" does the same after new output, without moving the view.
  private find(mode: FindMode): void {
    // A refresh for new output leaves a search of the log going; anything else
    // replaces it.
    if (mode !== "refresh") {
      this.searches++;
      this.searchingLog = false;
    }
    this.root.classList.remove("invalid");
    if (this.input.value === "") {
      this.clearResults();
      this.count.textContent = "No results";
      this.root.classList.remove("no-results");
      return;
    }
    let result: SearchResult<Line>;
    try {
      result = findMatches(this.view.allLines(), this.query(), MATCH_LIMIT);
    } catch {
      // An unfinished regex (e.g. "foo(") — wait for the user to complete it.
      this.clearResults();
      this.root.classList.add("invalid");
      this.count.textContent = "Invalid pattern";
      return;
    }
    const { matches, truncated } = result;
    const previous = this.active;
    const kept = previous ? matches.findIndex((m) => m.line === previous.line && m.start === previous.start) : -1;
    // Past the oldest or newest match held, go on into the rest of the log.
    const past =
      (mode === "previous" && (matches.length === 0 || kept === 0)) ||
      (mode === "next" && (matches.length === 0 || kept === matches.length - 1));
    if (past && mode === "previous" && truncated && kept === 0) {
      // Lines held above the oldest match counted are searched before the log.
      const above = this.view.allLines().indexOf(matches[0].line);
      const older = findMatches(this.view.allLines().slice(0, above), this.query(), MATCH_LIMIT);
      if (older.matches.length > 0) {
        this.show(older, older.matches.length - 1, true);
        return;
      }
    }
    if (past && !this.history.holdsAll) {
      this.show(result, kept, false);
      void this.searchLog(mode === "previous" ? "older" : "newer");
      return;
    }
    this.show(
      result,
      chooseActive(mode, matches.length, kept, () => this.firstInView(matches)),
      mode !== "refresh",
    );
  }

  // Makes `index` of `result`'s matches the current one (none if -1).
  private show(result: SearchResult<Line>, index: number, reveal: boolean): void {
    this.matches = result.matches;
    this.active = index >= 0 ? result.matches[index] : null;
    this.highlight();
    if (this.active && reveal) this.view.revealLine(this.active.line);
    this.ruler.draw(result.matches, this.active);
    if (!this.searchingLog) this.showCount(index, result.matches.length, result.truncated);
  }

  // Looks through the log beyond the lines held for the nearest match older or
  // newer than them, and shows its page. Found nothing that way, it wraps
  // around: Previous to the newest match, Next to the oldest.
  private async searchLog(direction: "older" | "newer"): Promise<void> {
    const mine = this.searches;
    const wanted = (): boolean => this.searches === mine && this.isOpen();
    const query = this.query();
    this.count.textContent = "Searching…";
    this.root.classList.remove("no-results");
    this.searchingLog = true;
    // Whatever the search shows last, the count says what it found.
    const done = (): boolean => {
      if (!wanted()) return false;
      this.searchingLog = false;
      return true;
    };
    try {
      let hit: LogHit | null = null;
      if (direction === "older") {
        const before = await this.history.olderCursor();
        if (before && wanted()) hit = await this.logSearch.older(before, query, wanted);
        if (!hit && wanted()) {
          // Around to the newest match: among the newest lines, else before them.
          await this.history.toNewest();
          if (!wanted()) return;
          const newest = findMatches(this.view.allLines(), query, MATCH_LIMIT);
          if (newest.matches.length > 0 && done()) {
            this.show(newest, newest.matches.length - 1, true);
            return;
          }
          const from = await this.history.olderCursor();
          if (from && wanted()) hit = await this.logSearch.older(from, query, wanted);
        }
      } else {
        const after = this.history.newerCursor();
        if (after) hit = await this.logSearch.newer(after, query, wanted);
        // Around to the oldest match, from the start of the log.
        if (!hit && wanted()) hit = await this.logSearch.newer(null, query, wanted);
      }
      if (!hit) {
        if (done()) this.show({ matches: [], truncated: false }, -1, false);
        return;
      }
      await this.history.show(hit.page);
      if (done()) this.showHit(hit, query);
    } catch (error) {
      if (!done()) return;
      this.root.classList.add("invalid");
      this.count.textContent = "Search failed";
      window.moolin.log("warn", "renderer", "searching the log failed:", String(error));
    }
  }

  // Once a match's page is shown, makes that match the current one.
  private showHit(hit: LogHit, query: SearchQuery): void {
    const all = this.view.allLines();
    // A page that reaches the end of the log is shown as the replay, which ends
    // as it does.
    const at = hit.page.after === null ? all.length - (hit.lines - hit.line) : hit.line;
    const result = findMatches(all, query, MATCH_LIMIT);
    let index = result.matches.findIndex((m) => m.line === all[at] && m.start === hit.start);
    if (index < 0) {
      // Not where it was expected: the nearest match to that line instead.
      let best = Number.POSITIVE_INFINITY;
      result.matches.forEach((m, i) => {
        const distance = Math.abs(all.indexOf(m.line) - at);
        if (distance < best) {
          best = distance;
          index = i;
        }
      });
    }
    this.show(result, index, true);
  }

  // The first match at or below the top of the view, else the newest.
  private firstInView(matches: ReadonlyArray<Match<Line>>): number {
    const top = this.view.scrollTop();
    const index = matches.findIndex((m) => this.view.lineOffset(m.line) >= top);
    return index >= 0 ? index : matches.length - 1;
  }

  private highlight(): void {
    const range = (m: Match<Line>) => this.view.rangeFor(m.line, m.start, m.end);
    setHighlight(
      "find-match",
      this.matches.map(range).filter((r): r is Range => r !== null),
    );
    const active = this.active ? range(this.active) : null;
    setHighlight("find-active", active ? [active] : []);
  }

  // The count is of the matches in the lines held; while the log holds more
  // history than that, it says so (Next and Previous search the rest).
  private showCount(index: number, total: number, truncated: boolean): void {
    const partial = !this.history.holdsAll;
    const limited = `${truncated ? `${MATCH_LIMIT}+` : String(total)}${partial ? " loaded" : ""}`;
    this.root.classList.toggle("no-results", total === 0 && this.input.value !== "" && !partial);
    if (total === 0) this.count.textContent = partial ? "None loaded" : "No results";
    else if (index < 0) this.count.textContent = `? of ${limited}`;
    else this.count.textContent = `${index + 1} of ${limited}`;
  }
}
