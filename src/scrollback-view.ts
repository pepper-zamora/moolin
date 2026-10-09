import { appearance } from "./ansi-parser";
import { HeldSelection } from "./held-selection";
import type { Line, Run } from "./line-builder";
import { LineStream } from "./line-stream";
import { linkify } from "./linkify";

// Pixels from the bottom within which the view counts as scrolled to the bottom.
const STICK_THRESHOLD = 4;

// Output is drawn once per animation frame, but a hidden window gets none, so
// it is also drawn by a timer, and at once when this many lines are waiting.
const FLUSH_FALLBACK_MS = 250;
const EAGER_FLUSH_LINES = 2000;

// A trim drops this fraction of the cap at once, so a full scrollback is
// trimmed every so many lines rather than on every one.
const TRIM_SLACK_FRACTION = 0.1;

export interface ScrollbackViewOptions {
  // The most lines kept; the oldest are dropped past it.
  maxLines: number;
  fontFamily: string;
  fontSize: number;
  // Wrap at word boundaries (otherwise at the last column, mid-word).
  wordWrap: boolean;
  // The view's size in character cells changed (sent to the server as NAWS).
  onResize: (cols: number, rows: number) => void;
  onOpenUrl: (url: string) => void;
  // The pointer moved onto a web address (given), or off it (null).
  onHoverUrl: (url: string | null) => void;
  // The primary mouse button went down in the scrollback, starting a click or
  // drag (a double or triple click goes down, up, down...), and went up again.
  onPointerDown: () => void;
  onPointerUp: () => void;
}

// The scrollback: one <div> per line in a scrolling element, drawn from the
// lines a LineStream makes. The browser does the wrapping, selection and
// scrolling; this keeps it pinned to the bottom, trims it, and reports its size.
export class ScrollbackView {
  private readonly stream = new LineStream();
  private readonly linesEl = document.createElement("div");
  private readonly probe = document.createElement("span");
  private readonly held: HeldSelection;
  private readonly changeListeners: Array<() => void> = [];
  private readonly scrollListeners: Array<() => void> = [];
  private stuck = true;
  private flushPending = false;
  private flushFrame = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cols = 0;
  private rows = 0;
  private cellHeight = 18;
  private cellWidthPx = 0;
  private size: number;
  private hoveredUrl: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly options: ScrollbackViewOptions,
  ) {
    this.size = options.fontSize;
    this.linesEl.className = "lines";
    this.probe.className = "probe";
    this.probe.setAttribute("aria-hidden", "true");
    this.probe.textContent = "M".repeat(10);
    el.append(this.linesEl, this.probe);
    el.style.fontFamily = options.fontFamily;
    el.style.fontSize = `${this.size}px`;
    el.classList.toggle("wrap-words", options.wordWrap);
    this.held = new HeldSelection(el, options.onPointerDown, options.onPointerUp);

    el.addEventListener("scroll", () => {
      this.stuck = this.atBottom();
      for (const listener of this.scrollListeners) listener();
    });
    new ResizeObserver(() => {
      if (this.stuck) this.scrollToBottomNow();
      this.refit();
      this.emitChange();
    }).observe(el);

    el.addEventListener("click", (event) => {
      const url = this.urlAt(event.target);
      // A drag that ends over an address is a selection, not a click on it.
      if (url && document.getSelection()?.isCollapsed !== false) options.onOpenUrl(url);
    });
    el.addEventListener("mouseover", (event) => this.hover(this.urlAt(event.target)));
    el.addEventListener("mouseleave", () => this.hover(null));

    this.refit();
  }

  private urlAt(target: EventTarget | null): string | null {
    return (target as Element | null)?.closest<HTMLElement>(".url")?.dataset.url ?? null;
  }

  private hover(url: string | null): void {
    if (url === this.hoveredUrl) return;
    this.hoveredUrl = url;
    this.options.onHoverUrl(url);
  }

  // A mouse button is down in the scrollback: a click or a drag selection.
  isSelecting(): boolean {
    return this.held.isSelecting();
  }

  get fontSize(): number {
    return this.size;
  }

  setFont(fontFamily: string, fontSize: number): void {
    this.size = fontSize;
    this.el.style.fontFamily = fontFamily;
    this.el.style.fontSize = `${fontSize}px`;
    this.refit();
    this.emitChange();
  }

  setWordWrap(wordWrap: boolean): void {
    this.el.classList.toggle("wrap-words", wordWrap);
    this.emitChange();
  }

  // Every line, drawn or not yet.
  allLines(): ReadonlyArray<Line> {
    this.flush();
    return this.stream.lines;
  }

  // Adds server (or Moolin) output; see LineStream.write.
  write(data: string | Uint8Array, time: number | null): void {
    this.stream.write(data, time);
    this.scheduleFlush();
  }

  // Adds history; see LineStream.replay.
  replay(chunks: ReadonlyArray<string | Uint8Array>, times: ReadonlyArray<number | null>): void {
    this.stream.replay(chunks, times);
    this.flush();
  }

  // Starts over: no lines, and no half-received escape sequence or style.
  reset(): void {
    this.stream.reset();
    this.linesEl.replaceChildren();
    this.held.clear();
    this.stuck = true;
    this.emitChange();
  }

  // Clear Screen: scrolls the last real line fully off the top of the view with
  // a screenful of blank lines (see LineStream.blankScreen), so earlier output
  // stays scrollable.
  clear(): void {
    this.stuck = true;
    this.stream.blankScreen(Math.ceil(this.el.clientHeight / this.cellHeight));
    this.flush();
  }

  // Output is parsed as it arrives but drawn in batches: one DOM update (and
  // layout) per frame however many chunks came in.
  private scheduleFlush(): void {
    if (this.stream.dirtyCount > EAGER_FLUSH_LINES) {
      this.flush();
      return;
    }
    if (this.flushPending) return;
    this.flushPending = true;
    this.flushFrame = requestAnimationFrame(() => this.flush());
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_FALLBACK_MS);
  }

  // Draws what has been added since the last flush.
  flush(): void {
    if (this.flushPending) {
      cancelAnimationFrame(this.flushFrame);
      if (this.flushTimer !== null) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushPending = false;
    }
    const dirty = this.stream.takeDirty();
    if (dirty.length === 0) return;
    // Trim first, so lines about to be discarded (a replay longer than the
    // cap) are never drawn.
    this.trim();
    const fresh = document.createDocumentFragment();
    for (const line of dirty) {
      // Dropped before it was drawn.
      if (line.dropped) continue;
      if (!line.el) {
        line.el = document.createElement("div");
        line.el.className = "line";
        fresh.append(line.el);
      }
      this.draw(line);
      if (line !== this.stream.openLine) line.runs = null;
    }
    this.linesEl.append(fresh);
    if (this.stuck) this.scrollToBottomNow();
    this.emitChange();
  }

  private draw(line: Line): void {
    const nodes: Node[] = [];
    for (const run of line.runs ?? []) nodes.push(...this.runNodes(run));
    if (nodes.length === 0) nodes.push(document.createElement("br")); // keeps an empty line's height
    (line.el as HTMLElement).replaceChildren(...nodes);
  }

  private runNodes(run: Run): Node[] {
    const { className, css } = appearance(run.style);
    const nodes: Node[] = [];
    for (const segment of linkify(run.text)) {
      if (className === "" && css === "" && !segment.url) {
        nodes.push(document.createTextNode(segment.text));
        continue;
      }
      const span = document.createElement("span");
      const classes = segment.url ? `${className} url`.trim() : className;
      if (classes) span.className = classes;
      if (css) span.style.cssText = css;
      if (segment.url) span.dataset.url = segment.url;
      span.textContent = segment.text;
      nodes.push(span);
    }
    return nodes;
  }

  private trim(): void {
    const { maxLines } = this.options;
    const count = this.stream.lines.length;
    if (count <= maxLines + Math.ceil(maxLines * TRIM_SLACK_FRACTION)) return;
    // Only the lines already drawn have anything to remove; they are the
    // oldest, so they are a run at the front.
    const drawn = this.stream.dropFront(count - maxLines).filter((line) => line.el);
    if (drawn.length === 0) return;
    const first = drawn[0].el as HTMLElement;
    const last = drawn[drawn.length - 1].el as HTMLElement;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    range.deleteContents();
  }

  // --- Scrolling ---------------------------------------------------------

  private atBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < STICK_THRESHOLD;
  }

  private scrollToBottomNow(): void {
    this.el.scrollTop = this.el.scrollHeight;
    this.stuck = true;
  }

  // Page Up / Page Down: a page less one line, so one line of context stays.
  scrollPages(pages: number): void {
    this.el.scrollBy({ top: pages * Math.max(this.cellHeight, this.el.clientHeight - this.cellHeight) });
  }

  onScroll(listener: () => void): void {
    this.scrollListeners.push(listener);
  }

  // Fired when the lines or the view's size change.
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  // --- Geometry ----------------------------------------------------------

  // The size of a character cell in pixels, as last measured.
  lineHeight(): number {
    return this.cellHeight;
  }

  cellWidth(): number {
    return this.cellWidthPx;
  }

  // The size in character cells, as last reported to onResize.
  get cells(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  // Remeasures the character cell and reports the size in cells if it changed.
  refit(): void {
    const computed = Number.parseFloat(window.getComputedStyle(this.el).lineHeight);
    this.cellHeight = Number.isFinite(computed) && computed > 0 ? computed : this.size * 1.25;
    this.cellWidthPx = this.probe.getBoundingClientRect().width / 10;
    if (!(this.cellWidthPx > 0) || this.el.clientWidth === 0 || this.el.clientHeight === 0) return;
    const cols = Math.max(2, Math.floor(this.el.clientWidth / this.cellWidthPx + 0.0001));
    const rows = Math.max(1, Math.floor(this.el.clientHeight / this.cellHeight));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.options.onResize(cols, rows);
  }

  // The lines in or near view, with their top edge relative to the view, and
  // the time of the closest stamped line above them (for the gutter).
  visibleLines(): { prevTime: number | null; lines: Array<{ time: number | null; top: number }> } {
    const all = this.allLines();
    const scrollTop = this.el.scrollTop;
    const bottom = scrollTop + this.el.clientHeight;
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const el = all[mid].el as HTMLElement;
      if (el.offsetTop + el.offsetHeight <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    let prevTime: number | null = null;
    for (let i = lo - 1; i >= 0 && prevTime === null; i--) prevTime = all[i].time;
    const lines: Array<{ time: number | null; top: number }> = [];
    for (let i = lo; i < all.length; i++) {
      const top = (all[i].el as HTMLElement).offsetTop;
      if (top >= bottom) break;
      lines.push({ time: all[i].time, top: top - scrollTop });
    }
    return { prevTime, lines };
  }

  // --- Search support ----------------------------------------------------

  // The DOM range for characters [start, end) of a line's text.
  rangeFor(line: Line, start: number, end: number): Range | null {
    if (!line.el) return null;
    const walker = document.createTreeWalker(line.el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = (node as Text).length;
      if (!started && start < offset + length) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && end <= offset + length) {
        range.setEnd(node, end - offset);
        return range;
      }
      offset += length;
    }
    return null;
  }

  // Scrolls so the line is in view (centred), unless it already is.
  revealLine(line: Line): void {
    const el = line.el;
    if (!el) return;
    const top = el.offsetTop - this.el.scrollTop;
    if (top >= 0 && top + el.offsetHeight <= this.el.clientHeight) return;
    el.scrollIntoView({ block: "center" });
  }

  // The line's position, and the scrollable height, for the search ruler.
  lineOffset(line: Line): number {
    return line.el?.offsetTop ?? 0;
  }

  scrollTop(): number {
    return this.el.scrollTop;
  }

  contentHeight(): number {
    this.flush();
    return this.el.scrollHeight;
  }

  // --- Selection ---------------------------------------------------------

  // The selected scrollback text, or "" when nothing is selected. It stays
  // available after focus moves to the input area.
  selectedText(): string {
    return this.held.selectedText();
  }

  clearSelection(): void {
    this.held.clearSelection();
  }

  selectAll(): void {
    this.flush();
    this.held.selectAll(this.linesEl);
  }
}
