import { MAX_HELD_LINES, type HistoryPage, type HistoryRequest } from "./history-paging";
import { LogChain, LogPane, locateFromEnd, type PanePlace } from "./log-pane";
import { ScrollbackView, type ScrollbackViewOptions } from "./scrollback-view";
import { TimestampGutter } from "./timestamp-gutter";

// The share of the panes' height the history pane takes when it first opens.
const DEFAULT_FRACTION = 0.5;
// How small dragging the divider can make either pane, as a share of both.
const MIN_FRACTION = 0.15;

export interface HistoryPaneElements {
  // The column holding both panes, which the divider divides.
  panes: HTMLElement;
  row: HTMLElement;
  terminal: HTMLElement;
  gutter: HTMLElement;
  divider: HTMLElement;
  close: HTMLElement;
}

// The upper half of a split: a read-only window onto the character's log, for
// reading further back than the live scrollback below it holds. Scrolling the
// live scrollback up past its top opens it, at the history just before the live
// scrollback's oldest line; Escape, End, its close button, or scrolling down
// past the end of the log close it. Nothing live is ever written to it, so the
// live scrollback, and typing to the world, carry on as they are.
export class HistoryPane {
  readonly view: ScrollbackView;
  readonly gutter: TimestampGutter;
  private readonly pane: LogPane;
  // Counts openings, so a slow one that a close overtook doesn't open after it.
  private opens = 0;
  private opening = false;
  private fraction = DEFAULT_FRACTION;

  constructor(
    private readonly els: HistoryPaneElements,
    options: Omit<ScrollbackViewOptions, "maxLines" | "onResize">,
    private readonly live: ScrollbackView,
    private readonly getPage: (request: HistoryRequest) => Promise<HistoryPage>,
    // Whether the log holds history older than the live scrollback's oldest line.
    private readonly hasOlder: () => boolean,
    private readonly onToggle: (open: boolean) => void,
    warn: (message: string) => void,
  ) {
    // The size the server is told is the live scrollback's, not this one's.
    this.view = new ScrollbackView(els.terminal, { ...options, maxLines: MAX_HELD_LINES, onResize: () => {} });
    this.view.setTrimming(false);
    this.gutter = new TimestampGutter(els.gutter, this.view);
    this.pane = new LogPane(this.view, () => this.close(), warn);
    this.view.onScroll(() => this.pane.scrolled());

    live.element.addEventListener("wheel", (event) => {
      if (event.deltaY < 0 && live.scrollTop() <= 0) void this.openAbove();
    });
    els.terminal.addEventListener("wheel", (event) => {
      if (event.deltaY > 0 && this.pane.atEnd()) this.close();
    });
    els.close.addEventListener("mousedown", (event) => event.preventDefault());
    els.close.addEventListener("click", () => this.close());
    this.dragDivider();
  }

  get isOpen(): boolean {
    return !this.els.row.hidden;
  }

  // Opens at the history just before the live scrollback's oldest line, if the
  // log holds any.
  async openAbove(): Promise<void> {
    if (this.isOpen || this.opening || !this.hasOlder()) return;
    const mine = ++this.opens;
    this.opening = true;
    try {
      const chain = await LogChain.start(this.getPage);
      if (!chain || mine !== this.opens) return;
      // The live scrollback's lines that are in the log: not Clear Screen's
      // blanks, nor an unfinished last line, which isn't logged yet.
      const open = this.live.openLine;
      const logged = this.live.allLines().filter((line) => !line.filler && line !== open);
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
      await this.pane.show(chain, at.k, { line: at.line, at: "bottom" });
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
        this.fraction = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, fraction));
        row.style.flexBasis = `${this.fraction * 100}%`;
      };
      const done = (): void => {
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
