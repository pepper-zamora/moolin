import type { Terminal } from "@xterm/xterm";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";

// Max matches the addon highlights (and counts); past this the count shows
// as "1000+".
const HIGHLIGHT_LIMIT = 1000;

// Match colors follow VS Code's dark theme. The addon wants #RRGGBB, so the
// translucent orange of an inactive match is pre-blended onto the black
// background.
const DECORATIONS: ISearchOptions["decorations"] = {
  matchBackground: "#4e1f00",
  matchOverviewRuler: "#d18616",
  activeMatchBackground: "#515c6a",
  activeMatchBorder: "#74879f",
  activeMatchColorOverviewRuler: "#a0a0a0",
};

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

// The find box floating at the top right of the scrollback, modelled on VS
// Code's editor find widget (minus replace, since the scrollback is
// read-only). Matches are highlighted throughout the buffer and on the
// scrollbar, and stay current as new output arrives (the addon re-runs the
// search after each write).
export class FindWidget {
  readonly root = element<HTMLDivElement>("find-widget");
  private readonly input = element<HTMLInputElement>("find-input");
  private readonly count = element<HTMLSpanElement>("find-count");
  private readonly toggles = {
    caseSensitive: element<HTMLButtonElement>("find-case"),
    wholeWord: element<HTMLButtonElement>("find-word"),
    regex: element<HTMLButtonElement>("find-regex"),
  };
  private readonly search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });

  constructor(
    private readonly term: Terminal,
    // Called after the widget closes, to hand focus back.
    private readonly onClose: () => void,
  ) {
    term.loadAddon(this.search);
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => this.showCount(resultIndex, resultCount));

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
    const selection = this.term.hasSelection() ? this.term.getSelection() : "";
    if (selection.length > 0 && !selection.includes("\n")) this.input.value = selection;
    const wasOpen = this.isOpen();
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    if (!wasOpen || selection.length > 0) this.find("incremental");
  }

  close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    this.search.clearDecorations();
    this.term.clearSelection();
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

  private options(incremental: boolean): ISearchOptions {
    const pressed = (button: HTMLButtonElement) => button.getAttribute("aria-pressed") === "true";
    return {
      caseSensitive: pressed(this.toggles.caseSensitive),
      wholeWord: pressed(this.toggles.wholeWord),
      regex: pressed(this.toggles.regex),
      incremental,
      decorations: DECORATIONS,
    };
  }

  // "incremental" re-runs the search as the term or options change, staying
  // on the current match while it still matches (as VS Code does on typing).
  private find(mode: "incremental" | "next" | "previous"): void {
    const text = this.input.value;
    this.root.classList.remove("invalid");
    if (text === "") {
      this.search.clearDecorations();
      this.term.clearSelection();
      this.count.textContent = "No results";
      this.root.classList.remove("no-results");
      return;
    }
    try {
      const options = this.options(mode === "incremental");
      if (mode === "previous") this.search.findPrevious(text, options);
      else this.search.findNext(text, options);
    } catch {
      // An unfinished regex (e.g. "foo(") — wait for the user to complete it.
      this.search.clearDecorations();
      this.root.classList.add("invalid");
      this.count.textContent = "Invalid pattern";
    }
  }

  private showCount(index: number, total: number): void {
    const limited = total >= HIGHLIGHT_LIMIT ? `${HIGHLIGHT_LIMIT}+` : String(total);
    this.root.classList.toggle("no-results", total === 0 && this.input.value !== "");
    if (total === 0) this.count.textContent = "No results";
    else if (index < 0) this.count.textContent = `? of ${limited}`;
    else this.count.textContent = `${index + 1} of ${limited}`;
  }
}
