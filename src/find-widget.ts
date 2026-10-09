import type { Line } from "./line-builder";
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
// read-only). Matches are highlighted throughout the buffer and marked on a
// ruler beside the scrollbar, and stay current as new output arrives.
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

  constructor(
    private readonly view: ScrollbackView,
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
    const index = chooseActive(mode, matches.length, kept, () => this.firstInView(matches));
    this.matches = matches;
    this.active = index >= 0 ? matches[index] : null;
    this.highlight();
    if (this.active && mode !== "refresh") this.view.revealLine(this.active.line);
    this.ruler.draw(matches, this.active);
    this.showCount(index, matches.length, truncated);
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

  private showCount(index: number, total: number, truncated: boolean): void {
    const limited = truncated ? `${MATCH_LIMIT}+` : String(total);
    this.root.classList.toggle("no-results", total === 0 && this.input.value !== "");
    if (total === 0) this.count.textContent = "No results";
    else if (index < 0) this.count.textContent = `? of ${limited}`;
    else this.count.textContent = `${index + 1} of ${limited}`;
  }
}
