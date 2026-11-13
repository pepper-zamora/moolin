import { MAX_HELD_LINES, type HistoryPage, type HistoryRequest } from "./history-paging";
import type { Line } from "./line-builder";
import { LogChain, LogPane, locateFromEnd, type PanePlace } from "./log-pane";
import { ScrollbackView, type ScrollbackViewOptions } from "./scrollback-view";
import { TimestampGutter } from "./timestamp-gutter";

// The share of the panes' height the history pane takes when it first opens.
const DEFAULT_FRACTION = 0.5;
// How small dragging the divider can make either pane, as a share of both.
const MIN_FRACTION = 0.15;
// Where the divider was last left, kept in the window's local storage so every
// window, in this run and later ones, opens the pane at the same height.
const FRACTION_KEY = "historyPaneFraction";

function clampFraction(fraction: number): number {
  return Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, fraction));
}

function storedFraction(): number {
  const stored = Number(localStorage.getItem(FRACTION_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampFraction(stored) : DEFAULT_FRACTION;
}

export interface HistoryPaneElements {
  // The column holding both panes, which the divider divides.
  panes: HTMLElement;
  row: HTMLElement;
  terminal: HTMLElement;
  gutter: HTMLElement;
  divider: HTMLElement;
  close: HTMLElement;
}

// The upper half of a split: a read-only window onto the character's log, where
// all reading back happens. With a log, the live scrollback below is pinned to
// the newest lines and can't be scrolled itself: scrolling up over it (the
// wheel, or Page Up) opens this pane first, with the live scrollback's top
// line at its top, and the scrolling goes on in here; while it's open, the
// wheel over the live scrollback scrolls this pane. Escape, End, its close
// button, or scrolling down to the end of the log close it. Nothing live is
// ever written to it. Without a log there is nothing for it to read, and the
// live scrollback scrolls back as it always has.
export class HistoryPane {
  readonly view: ScrollbackView;
  readonly gutter: TimestampGutter;
  private readonly pane: LogPane;
  // Counts openings, so a slow one that a close overtook doesn't open after it.
  private opens = 0;
  private opening = false;
  private fraction = storedFraction();
  // Until when scrolling down counts as asked for (a turn of the wheel, Page
  // Down), so reaching the end of the log by it closes the pane, while paging
  // or placing a line there doesn't.
  private downUntil = 0;

  constructor(
    private readonly els: HistoryPaneElements,
    options: Omit<ScrollbackViewOptions, "maxLines" | "onResize">,
    private readonly live: ScrollbackView,
    private readonly getPage: (request: HistoryRequest) => Promise<HistoryPage>,
    // Whether there is a log to read back through: only a replay from one is.
    private readonly hasLog: () => boolean,
    private readonly onToggle: (open: boolean) => void,
    warn: (message: string) => void,
  ) {
    // The size the server is told is the live scrollback's, not this one's.
    this.view = new ScrollbackView(els.terminal, { ...options, maxLines: MAX_HELD_LINES, onResize: () => {} });
    this.view.setTrimming(false);
    this.gutter = new TimestampGutter(els.gutter, this.view);
    this.pane = new LogPane(this.view, () => this.close(), warn);
    this.view.onScroll(() => {
      this.pane.scrolled();
      if (Date.now() < this.downUntil && this.pane.atEnd()) this.close();
    });

    // Should the live scrollback be scrolled all the same (it can't be by hand
    // while pinned), it goes back to the newest line.
    live.onScroll(() => {
      if (this.hasLog() && !live.isAtBottom() && !live.isSelecting()) live.scrollToBottom();
    });
    live.element.addEventListener(
      "wheel",
      (event) => {
        if (!this.hasLog()) return;
        event.preventDefault();
        if (this.isOpen) this.scrollBy(event.deltaY);
        else if (event.deltaY < 0) void this.openHere().then(() => this.scrollBy(event.deltaY));
      },
      { passive: false },
    );
    els.terminal.addEventListener("wheel", (event) => {
      if (event.deltaY > 0) this.goingDown();
    });
    els.close.addEventListener("mousedown", (event) => event.preventDefault());
    els.close.addEventListener("click", () => this.close());
    this.dragDivider();
  }

  get isOpen(): boolean {
    return !this.els.row.hidden;
  }

  // A replay came: with a log, the live scrollback is pinned to the newest line
  // (reading back happens here); without one, it scrolls back itself, and the
  // pane, with nothing to read, closes.
  logChanged(): void {
    this.live.element.classList.toggle("pinned", this.hasLog());
    if (this.hasLog()) this.live.scrollToBottom();
    else this.close();
  }

  // Page Up and Page Down while the pane is open, or Page Up opening it.
  scrollPages(pages: number): void {
    if (pages > 0) this.goingDown();
    if (this.isOpen) this.view.scrollPages(pages);
    else if (pages < 0) void this.openHere().then(() => this.view.scrollPages(pages));
  }

  // Scrolls the pane by `pixels` (the wheel over the live scrollback).
  private scrollBy(pixels: number): void {
    if (!this.isOpen) return;
    if (pixels > 0) this.goingDown();
    this.view.element.scrollBy({ top: pixels });
  }

  // Scrolling down was asked for: at the end of the log already, that closes
  // the pane; otherwise reaching the end by it shortly will (see the pane's
  // scroll listener).
  private goingDown(): void {
    if (this.pane.atEnd()) this.close();
    else this.downUntil = Date.now() + 600;
  }

  // Opens with the line at the top of the live scrollback at its top, and puts
  // the live scrollback back at the newest line.
  async openHere(): Promise<void> {
    if (this.isOpen || this.opening || !this.hasLog()) return;
    const mine = ++this.opens;
    this.opening = true;
    try {
      const chain = await LogChain.start(this.getPage);
      if (!chain || mine !== this.opens) return;
      // From the top line on, the live scrollback's lines that are in the log:
      // not Clear Screen's blanks, nor an unfinished last line, which isn't
      // logged yet.
      const open = this.live.openLine;
      const logged = this.live
        .allLines()
        .slice(this.live.topLineIndex())
        .filter((line) => !line.filler && line !== open);
      if (logged.length === 0) return;
      this.view.setPuebloEnabled(this.live.puebloEnabled);
      const at = await locateFromEnd(
        chain,
        (chunks, times) => this.view.readHistory(chunks, times),
        logged.length,
        logged[0].text,
      );
      if (!at || mine !== this.opens) return;
      this.show();
      this.live.scrollToBottom();
      this.downUntil = 0;
      await this.pane.show(chain, at.k, { line: at.line, at: "top" });
    } finally {
      this.opening = false;
    }
  }

  // Opens (if it isn't) at line `place` of page k of `chain`.
  async showPage(chain: LogChain, k: number, place: PanePlace): Promise<void> {
    this.opens++;
    this.view.setPuebloEnabled(this.live.puebloEnabled);
    this.show();
    await this.pane.show(chain, k, place);
  }

  // Reads a page of the log into lines as this pane would show them (in the
  // connection's Pueblo mode), without showing them: what search looks through.
  read(chunks: ReadonlyArray<Uint8Array>, times: ReadonlyArray<number | null>): ReadonlyArray<Line> {
    this.view.setPuebloEnabled(this.live.puebloEnabled);
    return this.view.readHistory(chunks, times);
  }

  // The page and line of `chain` at the pane's top and bottom edges, if it is
  // open on that chain.
  edges(chain: LogChain): { top: { k: number; line: number }; bottom: { k: number; line: number } } | null {
    if (!this.isOpen) return null;
    const top = this.pane.placeOf(chain, this.view.topLineIndex());
    const bottom = this.pane.placeOf(chain, this.view.bottomLineIndex());
    return top && bottom ? { top, bottom } : null;
  }

  // The line of the pane that is line `line` of page k of `chain`, if it holds it.
  lineAt(chain: LogChain, k: number, line: number): Line | null {
    const index = this.pane.indexOf(chain, k, { line });
    return index === null ? null : (this.view.allLines()[index] ?? null);
  }

  close(): void {
    this.opens++;
    if (!this.isOpen) return;
    this.els.row.hidden = true;
    this.els.divider.hidden = true;
    this.pane.close();
    this.view.reset();
    this.onToggle(false);
  }

  private show(): void {
    if (this.isOpen) return;
    // Another window may have moved the divider since.
    this.fraction = storedFraction();
    this.els.row.style.flexBasis = `${this.fraction * 100}%`;
    this.els.row.hidden = false;
    this.els.divider.hidden = false;
    this.onToggle(true);
  }

  // Dragging the divider shares the height between the panes.
  private dragDivider(): void {
    const { divider, panes, row } = this.els;
    divider.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target === this.els.close) return;
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      const move = (moved: PointerEvent): void => {
        const box = panes.getBoundingClientRect();
        if (box.height <= 0) return;
        const fraction = (moved.clientY - box.top) / box.height;
        this.fraction = clampFraction(fraction);
        row.style.flexBasis = `${this.fraction * 100}%`;
      };
      const done = (): void => {
        localStorage.setItem(FRACTION_KEY, String(this.fraction));
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", done);
        divider.removeEventListener("pointercancel", done);
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", done);
      divider.addEventListener("pointercancel", done);
    });
  }
}
