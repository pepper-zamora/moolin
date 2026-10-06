import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { worldsDialog } from "./worlds-dialog";
import { preferencesDialog } from "./preferences-dialog";
import { FindWidget } from "./find-widget";
import { SecurityStatus } from "./security-status";
import { CommandHistory, isOnFirstLine, isOnLastLine } from "./command-history";
import { InputUndoStack, type InputSnapshot } from "./input-undo";
import type { WindowState } from "./connection-manager";
import { countLineFeeds } from "./line-feeds";
import { LiveReplay } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";
import { fontFamilyFor, MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "./fonts";
import { WordWrapper } from "./word-wrap";
import { RawLineAccumulator } from "./raw-line-tracker";

window.addEventListener("error", (event) => {
  window.moolin.log("error", "renderer", "uncaught error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.moolin.log("error", "renderer", "unhandled rejection:", event.reason);
});

const APP_NAME = "Moolin";

// Configurable cap; the actual limit is also capped at 1/4 of the window height.
const MAX_INPUT_LINES = 8;

// The default font/size this window's terminal starts with, from main.ts via
// argv (see parseFontArgs); kept mutable so "Actual Size" (direction 0 below)
// and a newly saved Preferences default track the latest choice, not the
// value this window happened to start with.
const initialFont = window.moolin.initialFont;
let preferredFontSize = initialFont.fontSize;

const term = new Terminal({
  scrollback: 100000,
  convertEol: true,
  disableStdin: true, // scrollback is output-only; all typing goes to #input-area
  cursorInactiveStyle: "none", // term never actually has focus, so the hollow "inactive" cursor is just noise
  allowProposedApi: true, // the search addon's match highlighting uses decorations
  screenReaderMode: window.moolin.screenReaderMode,
  // A strip beside the scrollbar marking where search matches are.
  overviewRuler: { width: 10 },
  fontFamily: fontFamilyFor(initialFont.fontId),
  fontSize: initialFont.fontSize,
  theme: {
    background: "#000000",
    // Focus lives in the input area, so the scrollback is never focused;
    // draw its selection the same as a focused one rather than dimmed.
    selectionBackground: "#264f78",
    selectionInactiveBackground: "#264f78",
    // xterm draws its own scrollbar, so it is styled here rather than in CSS.
    scrollbarSliderBackground: "#5a5a5a",
    scrollbarSliderHoverBackground: "#7a7a7a",
    scrollbarSliderActiveBackground: "#9a9a9a",
    // The search-match strip's left edge. xterm draws it in white unless this
    // is set (its docs say black), so match the background to hide it.
    overviewRulerBorder: "#000000",
  },
});

// The scrollback takes no keyboard input, so xterm is kept out of key
// handling entirely. Otherwise, when it has focus (the input area is
// disabled while not connected, leaving it the last thing clicked), it
// turns Ctrl+letter into a control character and cancels the key event,
// which stops Electron's menu shortcuts (Ctrl+O, Ctrl+N, ...) from firing.
term.attachCustomKeyEventHandler(() => false);

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// Renderer has no direct access to Electron's `shell` module (sandboxed),
// so opening the link is proxied through main.ts.
term.loadAddon(
  new WebLinksAddon((_event, uri) => {
    window.moolin.openExternal(uri);
  }),
);

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const terminalContainer = element<HTMLDivElement>("terminal");
const gutter = element<HTMLDivElement>("gutter");
const inputArea = element<HTMLTextAreaElement>("input-area");
const statusBar = element<HTMLDivElement>("status-bar");
const statusText = element<HTMLSpanElement>("status-text");
const screenSize = element<HTMLSpanElement>("screen-size");
const loggingStatus = element<HTMLSpanElement>("logging-status");

term.open(terminalContainer);

// Keeps the input area and gutter's font matched to the terminal's, since
// neither is xterm's own DOM; used at startup and whenever the font changes
// (terminal-native zoom, or a new default saved in the Preferences dialog).
function applyFont(fontFamily: string, fontSize: number): void {
  inputArea.style.fontFamily = fontFamily;
  inputArea.style.fontSize = `${fontSize}px`;
  gutter.style.fontFamily = fontFamily;
  gutter.style.fontSize = `${fontSize}px`; // keep the gutter's cell height matched
  resizeInput();
  scheduleGutter();
}
applyFont(fontFamilyFor(initialFont.fontId), initialFont.fontSize);

const findWidget = new FindWidget(term, () => {
  if (!inputArea.disabled) inputArea.focus();
});

// True while either modal <dialog> (Worlds, Preferences) is open, so the
// input area doesn't steal focus or keyboard shortcuts from their own fields.
function modalOpen(): boolean {
  return worldsDialog.isOpen() || preferencesDialog.isOpen();
}

const securityStatus = new SecurityStatus(() => {
  if (!inputArea.disabled && !findWidget.isOpen() && !modalOpen()) inputArea.focus();
});

// How long to wait after the last resize event before re-wrapping, so
// dragging a window's edge doesn't trigger a full-scrollback redraw dozens
// of times per second — only once, after the size actually settles.
const RESIZE_REFLOW_DEBOUNCE_MS = 300;
let resizeReflowTimer: ReturnType<typeof setTimeout> | null = null;

term.onResize(({ cols, rows }) => {
  window.moolin.log("debug", "renderer", "terminal resized to", `${cols}x${rows}`);
  window.moolin.sendResize(cols, rows);
  screenSize.textContent = `${cols}x${rows}`;

  // Word-wrap's resize story, in full, because it's easy to get wrong:
  //
  // xterm's own reflow (its internal handling of a resize for ordinary,
  // non-word-wrapped text) already re-chunks hard-wrapped rows correctly by
  // column count — that's its normal job, and nothing here needs to touch
  // it. The problem is specific to OUR padding spaces (see word-wrap.ts):
  // xterm's reflow treats them as perfectly ordinary content and re-splits
  // them at the new column width with no idea they were ever meaningful,
  // landing them at whatever new position the raw cell count works out to
  // — almost never still a word boundary. Letting xterm reflow our own
  // padded output, in other words, is exactly how you'd get it wrong.
  //
  // The fix: when word-wrap is on, don't let xterm reflow our padded
  // content at all. Instead, re-derive the *entire* display from scratch,
  // from the untransformed source (the main process's ScrollbackBuffer,
  // which only ever stores the original, pre-wrap bytes — see
  // terminal-window.ts), re-run through a fresh-width WordWrapper. This
  // reuses applyReset() exactly as a reconnect does: clear the buffer,
  // replay from raw history. The only thing specific to a resize (as
  // opposed to a reconnect) is that we ask for a fresh getScrollback()
  // first, and we try to put the scrollbar back roughly where it was.
  if (!wordWrapEnabled) return; // xterm's own reflow already handles this case
  wordWrapper.setCols(cols); // takes effect on the next write regardless of the reflow below
  if (resizeReflowTimer !== null) clearTimeout(resizeReflowTimer);
  resizeReflowTimer = setTimeout(() => {
    resizeReflowTimer = null;
    void reflowForResize();
  }, RESIZE_REFLOW_DEBOUNCE_MS);
});
screenSize.textContent = `${term.cols}x${term.rows}`;

// Re-renders the whole scrollback at the terminal's current width, for a
// resize while word-wrap is on (see the long comment in term.onResize
// above for why this exists at all, instead of just letting xterm reflow).
//
// Cost and correctness, read before changing this:
//  - This re-fetches and re-writes the ENTIRE scrollback (up to 100,000
//    lines — see ScrollbackBuffer), not just what's on screen. That's a
//    deliberate v1 simplification, not an oversight: a lazy/virtualized
//    version would need to track, per region of the buffer, whether it's
//    already been re-wrapped for the current width, and recompute only
//    what actually scrolls into view. Doing the whole thing is simpler and
//    correct, at the cost of a visible pause on resize that scales with
//    scrollback size. Revisit only if that pause proves genuinely
//    bothersome in practice.
//  - Scroll position is restored *approximately*, as a proportion of the
//    buffer (how far down you were, 0 to 1, before vs. after), not
//    anchored to the exact logical line that was on screen. An exact
//    anchor would need per-logical-line marker tracking carried through
//    the clear-and-replay, since reflowing at a new width changes how many
//    visual rows each logical line occupies, so a plain row-index anchor
//    would drift. See TODO.md — this is flagged there as needing a harder
//    look before it's accepted as the long-term answer, not a settled
//    design decision.
//  - This only ever reads from the main process's scrollback/log; it never
//    writes back to them. The session log on disk and any other window
//    showing the same connection are completely untouched — this is a
//    per-window, renderer-side *display* operation, nothing more.
async function reflowForResize(): Promise<void> {
  const buffer = term.buffer.active;
  const scrollFraction = buffer.length > 0 ? buffer.viewportY / buffer.length : 0;
  const replay = await window.moolin.getScrollback();
  applyReset(replay);
  const newLength = term.buffer.active.length;
  term.scrollToLine(Math.round(scrollFraction * newLength));
}

try {
  term.loadAddon(new WebglAddon());
} catch {
  // Falls back to the default DOM renderer if WebGL is unavailable.
}

// --- Word wrap ---------------------------------------------------------------
// Wraps long server lines at word boundaries for display, resolved per
// connection from Global/World/Character (see connection-manager.ts and
// word-wrap.ts's own module comment for the actual wrapping mechanism and
// why it's copy-safe). This section only owns *when* WordWrapper runs and
// on what — the wrapping logic itself lives entirely in word-wrap.ts.
//
// IMPORTANT: this is the most complex piece of logic in the renderer, and
// the one most likely to come back from review with a correctness question.
// Read word-wrap.ts's module comment first; the notes below are about the
// three integration points specific to *this* file, not the algorithm.
let wordWrapEnabled = false;
const wordWrapper = new WordWrapper(term.cols);

// A word still being accumulated when a chunk ends (e.g. the server hasn't
// sent the space or newline that would end it yet) is held inside
// `wordWrapper`, not emitted — see WordWrapper.flushPending's own comment
// for why. If the server then goes quiet (most commonly: a prompt with no
// trailing newline, like "Password:"), nothing will arrive to end that
// word, so it would otherwise never reach the screen at all. This timer is
// the renderer's side of that contract: cleared and re-armed on every
// chunk, so it only fires once output has actually gone quiet, at which
// point whatever's held is flushed as-is. Zero-delay rather than some
// fixed "typing pause" guess, since the actual requirement is just "after
// this task's other synchronous work, if nothing else arrived in the
// meantime" — a real continuation arriving later cancels and re-arms it
// before it ever fires.
let wordWrapFlushTimer: ReturnType<typeof setTimeout> | null = null;

// The single place word-wrap actually runs. A pass-through when the
// resolved setting is off, so the two code paths (wrap / no-wrap) only ever
// diverge here, not in every caller.
function transformForWrite(data: string | Uint8Array): string | Uint8Array {
  if (!wordWrapEnabled) return data;
  if (wordWrapFlushTimer !== null) clearTimeout(wordWrapFlushTimer);
  const out = wordWrapper.transform(data);
  wordWrapFlushTimer = setTimeout(() => {
    wordWrapFlushTimer = null;
    const held = wordWrapper.flushPending();
    if (held) term.write(held);
  }, 0);
  return out;
}

// --- Line timestamps -------------------------------------------------------
// A gutter to the left of the terminal showing when each line arrived. xterm
// has no native gutter, so it's a separate element (see index.html) kept
// aligned to the viewport here. The time is never written into the terminal
// buffer: copy, search and the session log keep seeing the untimestamped
// text, matching MUSHclient's display-only model (see GAPS.md §8).
//
// Each stamped line is anchored with an xterm marker, which tracks its line as
// the buffer scrolls and self-disposes when the line ages out of scrollback.
// lineStamps stays sorted by marker.line (stamps are appended as new lines
// arrive, and the oldest scroll out of the front first), so the visible slice
// can be found by binary search rather than scanning every stamp each render.
// The arrival time is kept alongside each marker; renderGutter derives the
// time label and date from it, dedups a run of same-minute lines, and shows
// the date on the first stamped line and wherever the local day changes.
//
// Only lines that got a timestamp (server output, not Moolin's own status
// lines) go into lineStamps — renderGutter's same-minute/day-change collapsing
// depends on consecutive entries always being real timestamps. rawLines
// (below) is the dense counterpart: every completed line, timestamped or not.
const lineStamps: Array<{ marker: IMarker; time: Date }> = [];
let timestampsShown = false;

// The original (pre-word-wrap) plain text of every line still in the
// scrollback, keyed the same way as lineStamps (one entry per real line feed,
// sorted by marker.line). Used by getWrapAwareSelection (see copySelection)
// to substitute a word-wrapped paragraph's real text instead of xterm's
// padded display text when it's copied.
const rawLines: Array<{ marker: IMarker; text: string }> = [];
const rawLineAccumulator = new RawLineAccumulator();

// One entry queued per line feed a chunk contains, consumed one per real
// onLineFeed event below — time (or null, for a line that gets no stamp:
// Moolin's own status lines, Clear Screen's blank filler, and replayed
// history with no recorded time) and the line's raw plain text together,
// since both are always derived from the exact same chunk at the exact same
// call sites and must never drift relative to each other.
const pendingLines: Array<{ time: number | null; text: string }> = [];

// Writes a chunk and queues an entry for each line it contains, so the
// onLineFeed handler below consumes them in step. Line-feed counting and raw
// text extraction both always run on the original, untransformed `data` —
// word-wrap only ever inserts spaces (never a line feed) and holds back an
// incomplete trailing word instead of emitting it early (see WordWrapper), so
// neither can ever disagree with xterm's real line-feed count.
function writeStamped(data: string | Uint8Array, time: number | null): void {
  const texts = rawLineAccumulator.push(data);
  for (let i = 0, n = countLineFeeds(data); i < n; i++) pendingLines.push({ time, text: texts[i] ?? "" });
  term.write(transformForWrite(data));
}

// 12-hour, minute resolution, with a single-letter am/pm suffix: "9:05a",
// "12:10p". No seconds; a run of lines in the same minute is collapsed to one
// label in renderGutter.
function formatTime(time: Date): string {
  const hour = time.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = time.getMinutes().toString().padStart(2, "0");
  return `${hour12}:${minute}${hour < 12 ? "a" : "p"}`;
}

// "11/20" (local month/day), floated above the time when the day changes.
function dateLabel(time: Date): string {
  return `${time.getMonth() + 1}/${time.getDate()}`;
}

function dayKey(time: Date): string {
  return `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
}

// xterm's cell height isn't simply font-size × line-height (it depends on font
// metrics), so measure the rendered screen rather than compute it.
function cellHeight(): number {
  const screen = terminalContainer.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.rows > 0) return screen.clientHeight / term.rows;
  return lineHeightPx();
}

// Same idea, for width (see the fitToContentOnLoad report at the bottom of
// this file).
function cellWidth(): number {
  const screen = terminalContainer.querySelector<HTMLElement>(".xterm-screen");
  return screen && term.cols > 0 ? screen.clientWidth / term.cols : 0;
}

// Walks back from `row` over isWrapped continuation rows to the logical
// line's first visual row — the only row word-wrap's padding never touches
// (padding only ever lands at the end of a row immediately before a wrap).
// Also used by getWrapAwareSelection (see copySelection) to find where a
// touched logical line actually begins.
function logicalLineStart(row: number): number {
  const buffer = term.buffer.active;
  let r = row;
  while (r > 0 && buffer.getLine(r)?.isWrapped) r--;
  return r;
}

// Walks forward from a logical line's first row to its last visual row.
function logicalLineEnd(row: number): number {
  const buffer = term.buffer.active;
  let r = row;
  while (r + 1 < buffer.length && buffer.getLine(r + 1)?.isWrapped) r++;
  return r;
}

function clearLineRecords(): void {
  // Empty both lists before disposing, so each marker's onDispose handler
  // finds nothing to remove; splicing them out one by one would be O(n²)
  // across a full scrollback. rawLines holds every marker ever registered
  // here (lineStamps only a subset of the same markers), so disposing its
  // markers covers both.
  const markers = rawLines.splice(0).map((r) => r.marker);
  lineStamps.splice(0);
  for (const marker of markers) marker.dispose();
  gutter.replaceChildren();
}

// First index whose line is at or below the top of the viewport.
function firstVisibleStamp(top: number): number {
  let lo = 0;
  let hi = lineStamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineStamps[mid].marker.line < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function renderGutter(): void {
  if (!timestampsShown) return;
  const top = term.buffer.active.viewportY;
  const rows = term.rows;
  const cell = cellHeight();
  const entries: HTMLDivElement[] = [];
  let lastRow = -1; // row of entries' last element, or -1 when there is none
  for (let i = firstVisibleStamp(top); i < lineStamps.length; i++) {
    const { marker, time } = lineStamps[i];
    const row = marker.line - top;
    if (row >= rows) break;
    if (marker.isDisposed || row < 0) continue;
    const label = formatTime(time);
    const prev = i > 0 ? lineStamps[i - 1] : null;
    // Show the date on the first stamped line and at each day change.
    const dayChange = prev !== null && dayKey(prev.time) !== dayKey(time);
    const showDate = prev === null || dayChange;
    // Label the first line of each minute; a run within the same minute shows
    // nothing (a day boundary is never same-minute, so it is never collapsed).
    if (prev !== null && formatTime(prev.time) === label && !dayChange) continue;
    const entry = document.createElement("div");
    entry.className = "gutter-stamp";
    entry.style.top = `${row * cell}px`;
    entry.style.height = `${cell}px`;
    entry.style.lineHeight = `${cell}px`;
    if (showDate && row === 0) {
      // No row above to float the date onto (the dated line is at the very
      // top), so show the date in the cell in place of the time.
      entry.classList.add("gutter-datecell");
      entry.textContent = dateLabel(time);
    } else {
      if (showDate) {
        // Float the date just above the time, onto the row above. That row is
        // usually blank (Moolin's own status lines aren't stamped), but where
        // it has a time of its own — a session crossing midnight, or two days
        // meeting in replayed history — the date takes its place rather than
        // being drawn over it.
        if (lastRow === row - 1) entries.pop();
        const date = document.createElement("span");
        date.className = "gutter-date";
        date.textContent = dateLabel(time);
        entry.appendChild(date);
      }
      entry.appendChild(document.createTextNode(label));
    }
    entries.push(entry);
    lastRow = row;
  }
  gutter.replaceChildren(...entries);
}

let gutterScheduled = false;
function scheduleGutter(): void {
  if (gutterScheduled) return;
  gutterScheduled = true;
  requestAnimationFrame(() => {
    gutterScheduled = false;
    renderGutter();
  });
}

term.onLineFeed(() => {
  const entry = pendingLines.shift();
  const buffer = term.buffer.active;
  const cursorAbs = buffer.baseY + buffer.cursorY;
  // The line feed moved the cursor off the line it ended; that line is the
  // one just above the cursor.
  const startAbs = cursorAbs - 1;
  if (startAbs < 0) return;
  const lineStart = logicalLineStart(startAbs);
  const marker = term.registerMarker(lineStart - cursorAbs);
  if (!marker) return;

  const rawEntry = { marker, text: entry?.text ?? "" };
  rawLines.push(rawEntry);
  marker.onDispose(() => {
    const i = rawLines.indexOf(rawEntry);
    if (i !== -1) rawLines.splice(i, 1);
  });

  if (entry?.time != null) {
    const stamp = { marker, time: new Date(entry.time) };
    lineStamps.push(stamp);
    marker.onDispose(() => {
      const i = lineStamps.indexOf(stamp);
      if (i !== -1) lineStamps.splice(i, 1);
    });
  }
});
// Re-render on new output and on any scroll — xterm fires onScroll for the
// wheel and scrollbar as well as for output pushing the buffer up.
term.onRender(() => scheduleGutter());
term.onScroll(() => scheduleGutter());

function lineHeightPx(): number {
  const lh = parseFloat(window.getComputedStyle(inputArea).lineHeight);
  return Number.isFinite(lh) ? lh : 18;
}

function maxInputLines(): number {
  const byWindowHeight = Math.floor(window.innerHeight / 4 / lineHeightPx());
  return Math.max(1, Math.min(MAX_INPUT_LINES, byWindowHeight));
}

function resizeInput(): void {
  const lh = lineHeightPx();
  const maxHeight = lh * maxInputLines();

  inputArea.style.height = "auto";
  const desired = Math.min(inputArea.scrollHeight, maxHeight);
  inputArea.style.height = `${Math.max(desired, lh)}px`;
  inputArea.style.overflowY = inputArea.scrollHeight > maxHeight ? "auto" : "hidden";

  fitAddon.fit();
}

const history = new CommandHistory();
const inputUndo = new InputUndoStack();

function inputSnapshot(): InputSnapshot {
  return {
    value: inputArea.value,
    selectionStart: inputArea.selectionStart,
    selectionEnd: inputArea.selectionEnd,
  };
}

// Tells main when Undo/Redo become available or unavailable, for the Edit
// menu. Only changes are sent: each one rebuilds the window's menu, and this
// runs on every keystroke.
let reportedUndoState: string | null = null;
function reportUndoState(): void {
  const canUndo = inputUndo.canUndo();
  const canRedo = inputUndo.canRedo();
  const state = `${canUndo}/${canRedo}`;
  if (state === reportedUndoState) return;
  reportedUndoState = state;
  window.moolin.reportUndoState(canUndo, canRedo);
}

function applySnapshot(snapshot: InputSnapshot): void {
  inputArea.value = snapshot.value;
  inputArea.selectionStart = snapshot.selectionStart;
  inputArea.selectionEnd = snapshot.selectionEnd;
  resizeInput();
}

function undoInput(): void {
  const snapshot = inputUndo.undo(inputSnapshot());
  if (!snapshot) return;
  applySnapshot(snapshot);
  reportUndoState();
}

function redoInput(): void {
  const snapshot = inputUndo.redo(inputSnapshot());
  if (!snapshot) return;
  applySnapshot(snapshot);
  reportUndoState();
}

function showHistoryEntry(entry: string | null): void {
  if (entry === null) return;
  inputUndo.breakGroup();
  reportUndoState();
  inputArea.value = entry;
  inputArea.selectionStart = inputArea.selectionEnd = inputArea.value.length;
  resizeInput();
}

function sendInput(): void {
  inputUndo.breakGroup();
  reportUndoState();
  const text = inputArea.value;
  inputArea.value = "";
  resizeInput();
  history.push(text);
  window.moolin.log("debug", "renderer", "sending input, length =", text.length);
  window.moolin.sendInput(text);
}

// Scrolls the last real line fully off the top of the viewport by writing a
// screenful of blank lines, rather than touching xterm's scrollback buffer.
// The blanks are ordinary written lines: scrolling up reveals real history
// beneath them same as ever, and since new output just overwrites them from
// the top down (the terminal stays pinned to the bottom), there's nothing to
// clean up later — once they're filled or scrolled past, they're gone like
// any other line that scrolled out of the buffer.
//
// xterm's scrollback has no API for trimming lines back out, so a repeat
// press while already cleared is a no-op rather than stacking another blank
// screenful on top — otherwise mashing the key would litter history with
// redundant blank gaps. isCleared is reset the moment any real output
// arrives (see onTelnetData below).
let isCleared = false;
function clearToOffscreen(): void {
  if (isCleared) return;
  term.scrollToBottom();
  // The blank filler lines carry no timestamp.
  writeStamped("\n".repeat(term.rows), null);
  isCleared = true;
}

// Enter sends and Shift+Enter inserts a newline. Up/Down browse history when
// the caret is on the first/last line (otherwise they move between lines of
// a multi-line command); with Ctrl (Cmd on macOS) they always browse.
inputArea.addEventListener("keydown", (event) => {
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  const modOnly = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInput();
  } else if (
    event.key === "ArrowUp" &&
    (modOnly || (plain && isOnFirstLine(inputArea.value, inputArea.selectionStart)))
  ) {
    event.preventDefault();
    showHistoryEntry(history.previous(inputArea.value));
  } else if (
    event.key === "ArrowDown" &&
    (modOnly || (plain && isOnLastLine(inputArea.value, inputArea.selectionEnd)))
  ) {
    event.preventDefault();
    showHistoryEntry(history.next());
  }
});

inputArea.addEventListener("input", () => resizeInput());

// Captured before the value mutates (unlike "input", which fires after), so
// the pre-edit state can be pushed as an undo step. Consecutive keystrokes
// coalesce into one step via InputUndoStack's own debounce.
inputArea.addEventListener("beforeinput", () => {
  inputUndo.pushTyping(inputSnapshot(), Date.now());
  reportUndoState();
});

window.addEventListener("resize", () => resizeInput());

// Keyboard focus belongs in the input area whenever the window has it,
// unless the Worlds dialog is open or the find widget has it. The connection
// details popup is left alone while the pointer is over it, so its text can
// be selected and copied. The scrollback never keeps focus: xterm takes it
// on every click (its mouse selection doesn't need it), so it's handed back
// to the input area, or, while there's no connection to type to, just taken
// away, leaving keys to the window (and its menu shortcuts).
function reclaimFocus(): void {
  if (modalOpen()) return;
  const active = document.activeElement;
  if (findWidget.root.contains(active) || securityStatus.isHovered()) return;
  if (!inputArea.disabled) {
    if (active !== inputArea) inputArea.focus();
  } else if (active === term.textarea) {
    term.textarea.blur();
  }
}
// Checked wherever focus goes, once the event that moved it is done. Both
// directions are needed: in a window that isn't active, focus moves without
// any focusout (clicking an inactive window's scrollback hands xterm focus
// straight from nothing), and the window's own activation is a third way in.
document.addEventListener("focusout", () => setTimeout(reclaimFocus));
document.addEventListener("focusin", () => setTimeout(reclaimFocus));
window.addEventListener("focus", () => setTimeout(reclaimFocus));

// Selecting text in the input means Ctrl+C should copy that, not a stale
// scrollback selection.
inputArea.addEventListener("select", () => term.clearSelection());

// Exact-row lookup into rawLines (mirrors firstVisibleStamp's binary search,
// but for an exact match rather than "first at or after").
function findRawLine(row: number): string | null {
  let lo = 0;
  let hi = rawLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rawLines[mid].marker.line < row) lo = mid + 1;
    else hi = mid;
  }
  const hit = rawLines[lo];
  return hit && hit.marker.line === row && !hit.marker.isDisposed ? hit.text : null;
}

// Reconstructs a scrollback selection using the ORIGINAL pre-wrap server line
// for any paragraph word-wrap actually wrapped across more than one visual
// row — xterm's own padding spaces, which a plain term.getSelection() would
// include verbatim, only ever land at the end of such a row (see
// word-wrap.ts). A logical line that fits on one row is never padded, so it's
// extracted precisely via translateToString, clipped to the selection's
// start/end column only on the selection's first/last row respectively
// (exactly how xterm's own getSelection already joins ordinary multi-line
// selections). Returns null if reconstruction isn't possible (no selection,
// or a row with no raw line recorded yet — e.g. an in-progress line with no
// terminating line feed), so the caller can fall back to term.getSelection(),
// never worse than before.
//
// Deliberate tradeoff, per design discussion: a selection that only partly
// overlaps a wrapped paragraph still copies that paragraph's WHOLE original
// line, not just the highlighted portion — see CHANGELOG.md. Also assumes an
// ordinary linear selection; xterm's Alt+drag column/block select has no
// public API to detect from getSelectionPosition() alone and isn't handled
// specially (see TODO.md).
function getWrapAwareSelection(): string | null {
  const pos = term.getSelectionPosition();
  if (!pos) return null;
  const buffer = term.buffer.active;
  const { start, end } = pos;
  const parts: string[] = [];
  let row = start.y;
  while (row <= end.y) {
    // How far this row's wrap-chain extends *within the selection* — never
    // past end.y. A logical line can continue further off-selection (e.g.
    // double-clicking one word on the first row of a long wrapped
    // paragraph): that doesn't make this SELECTION wrapped, since nothing
    // padded was actually touched. Only a span that reaches past `row`
    // *inside* [start.y, end.y] means the selection itself crosses a real
    // wrap boundary, where xterm's padding could appear in a plain extract.
    const spanEnd = Math.min(logicalLineEnd(row), end.y);
    if (spanEnd > row) {
      // Crosses a wrap boundary: substitute the WHOLE original logical line
      // (which may extend further than spanEnd, if the paragraph continues
      // past where the selection ends) — looked up by the line's actual
      // start row, where rawLines' marker was registered, not `row` itself.
      const lineStart = logicalLineStart(row);
      const text = findRawLine(lineStart);
      if (text === null) return null;
      parts.push(text);
      row = logicalLineEnd(row) + 1; // skip the whole paragraph, not just the selected part
      continue;
    }
    const line = buffer.getLine(row);
    if (!line) return null;
    const colStart = parts.length === 0 ? start.x : 0;
    const colEnd = row === end.y ? end.x : undefined;
    parts.push(line.translateToString(true, colStart, colEnd));
    row = spanEnd + 1;
  }
  return parts.join("\n");
}

// Copy/paste go through Electron's clipboard module (via preload) rather
// than the browser's native copy/paste commands, which don't reliably see
// xterm.js's canvas/WebGL-rendered selection. A scrollback selection wins
// over one in the input area; selecting in the input clears the scrollback
// selection (above), so whichever was made last is what gets copied.
function copySelection(): void {
  const text =
    securityStatus.selectedText() ||
    (term.hasSelection()
      ? ((wordWrapEnabled ? getWrapAwareSelection() : null) ?? term.getSelection())
      : inputArea.value.slice(inputArea.selectionStart, inputArea.selectionEnd));
  if (text.length > 0) {
    window.moolin.clipboard.writeText(text);
  }
}

// The scrollback is read-only, so a scrollback selection can't actually be
// removed — Cut just falls back to Copy in that case. Otherwise it cuts from
// the input area like a normal text field.
function cutSelection(): void {
  if (term.hasSelection()) {
    copySelection();
    return;
  }
  const { selectionStart, selectionEnd } = inputArea;
  const text = inputArea.value.slice(selectionStart, selectionEnd);
  if (text.length === 0) return;
  window.moolin.clipboard.writeText(text);
  inputUndo.pushDiscrete(inputSnapshot());
  inputArea.value = inputArea.value.slice(0, selectionStart) + inputArea.value.slice(selectionEnd);
  inputArea.selectionStart = inputArea.selectionEnd = selectionStart;
  resizeInput();
  reportUndoState();
}

// The terminal is output-only, so pasted text always lands in the input
// area — at the current cursor/selection if it's focused, otherwise appended
// at the end.
async function pasteIntoInput(): Promise<void> {
  if (inputArea.disabled) return;
  const text = await window.moolin.clipboard.readText();
  if (!text) return;
  const active = document.activeElement === inputArea;
  const start = active ? inputArea.selectionStart : inputArea.value.length;
  const end = active ? inputArea.selectionEnd : inputArea.value.length;
  inputUndo.pushDiscrete(inputSnapshot());
  inputArea.value = inputArea.value.slice(0, start) + text + inputArea.value.slice(end);
  inputArea.focus();
  inputArea.selectionStart = inputArea.selectionEnd = start + text.length;
  resizeInput();
  reportUndoState();
}

window.moolin.onCopyRequested(() => copySelection());
window.moolin.onCutRequested(() => cutSelection());
window.moolin.onPasteRequested(() => void pasteIntoInput());
window.moolin.onSelectAllRequested(() => term.selectAll());
window.moolin.onUndoRequested(() => undoInput());
window.moolin.onRedoRequested(() => redoInput());
window.moolin.onFindRequested((action) => {
  if (action === "open") findWidget.open();
  else findWidget.findFromMenu(action);
});
window.moolin.onClearScreenRequested(() => clearToOffscreen());
window.moolin.onToggleTimestamps((show) => {
  timestampsShown = show;
  gutter.hidden = !show;
  // The gutter takes its width from the terminal when shown (and gives it
  // back when hidden), so refit cols/rows, then redraw the stamps.
  resizeInput();
  scheduleGutter();
});

// Starts the Edit menu's Undo/Redo items disabled until there's anything to act on.
reportUndoState();

// Window-wide keys, captured at the document so they apply wherever focus is
// and run before xterm's own handling. No menu item registers these as real
// accelerators (see main.ts), so they reach here as normal keydowns;
// preventDefault suppresses the browser's native (unreliable, and in the case
// of undo, already-broken — see input-undo.ts) handling.
document.addEventListener(
  "keydown",
  (event) => {
    // Both dialogs' fields keep the browser's native keys.
    if (modalOpen()) return;
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    const key = event.key.toLowerCase();
    // The find widget's search field keeps the browser's native editing keys.
    const editingFind = findWidget.root.contains(document.activeElement);
    let handled = true;
    if (mod && !event.shiftKey && key === "f") {
      findWidget.open();
    } else if (event.key === "F3" && !mod && !event.altKey) {
      findWidget.findFromMenu(event.shiftKey ? "previous" : "next");
    } else if (event.key === "Escape" && findWidget.isOpen()) {
      findWidget.close();
    } else if (editingFind && mod && ["c", "x", "v", "z", "y"].includes(key)) {
      handled = false;
    } else if (mod && key === "c") {
      copySelection();
    } else if (mod && key === "x") {
      cutSelection();
    } else if (mod && key === "v") {
      void pasteIntoInput();
    } else if (mod && key === "z" && !event.shiftKey) {
      undoInput();
    } else if (
      (mod && key === "z" && event.shiftKey) ||
      (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && key === "y")
    ) {
      redoInput();
    } else if (mod && !event.shiftKey && key === "l") {
      clearToOffscreen();
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      // Home/End are left to the input area.
      term.scrollPages(event.key === "PageUp" ? -1 : 1);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

document.addEventListener("contextmenu", (event) => {
  // Leave either dialog's fields their native context menu.
  if (modalOpen()) return;
  event.preventDefault();
  // Any selection Copy would act on (see copySelection).
  const hasSelection =
    securityStatus.selectedText() !== "" || term.hasSelection() || inputArea.selectionStart !== inputArea.selectionEnd;
  window.moolin.showContextMenu({ hasSelection });
});

// Replays buffered history (the in-memory buffer on reload, or a world's log
// on connect), queuing the recorded arrival time for each of its lines so the
// onLineFeed handler restamps them. Lines with no recorded time (null — old
// history, or Moolin's own lines) get no stamp (see GAPS.md §8).
//
// Every call to writeReplay represents a genuinely fresh start of the
// content stream (the initial page-load catch-up, a reconnect's
// applyReset, or a resize's reflowForResize), never a mid-stream
// continuation — so resetting the word-wrap state here, unconditionally,
// is always correct: there is no "old" in-progress word that still belongs
// to whatever comes next.
function writeReplay(replay: ScrollbackReplay): void {
  wordWrapEnabled = replay.wordWrap;
  if (wordWrapFlushTimer !== null) {
    clearTimeout(wordWrapFlushTimer);
    wordWrapFlushTimer = null;
  }
  wordWrapper.reset();
  wordWrapper.setCols(term.cols);
  rawLineAccumulator.reset();
  const texts: string[] = [];
  for (const chunk of replay.chunks) texts.push(...rawLineAccumulator.push(chunk));
  for (let i = 0; i < replay.times.length; i++) pendingLines.push({ time: replay.times[i], text: texts[i] ?? "" });
  for (const chunk of replay.chunks) term.write(transformForWrite(chunk));
}

// Starts over from a replay: the connect-time switch to a world's logged
// history. Reset in step with xterm's write queue rather than right away:
// output sent just before the reset (e.g. a "disconnected" status line) may
// not be parsed yet. Resetting from a write callback lets that output consume
// its own queued times first and keeps it out of the fresh buffer; the replay
// is queued behind the reset, so its lines get the replay's times.
function applyReset(replay: ScrollbackReplay): void {
  isCleared = false;
  term.write("", () => {
    clearLineRecords();
    term.reset();
  });
  writeReplay(replay);
}

function applyData(data: string | Uint8Array, time: number | null): void {
  isCleared = false;
  writeStamped(data, time);
}

// Replay the main process's in-memory scrollback buffer (survives a reload,
// and catches a new window up on what was written before its page loaded),
// then follow live output. Subscribing before fetching, and letting LiveReplay
// drop what the replay already contains, keeps any line from being lost or
// shown twice (see live-replay.ts).
async function loadScrollback(): Promise<void> {
  const live = new LiveReplay(writeReplay, (event) => {
    if (event.kind === "data") applyData(event.data, event.time);
    else applyReset(event.replay);
  });
  window.moolin.onTerminalReset((replay) => live.receive({ kind: "reset", replay }));
  window.moolin.onTelnetData((data, time, seq) => live.receive({ kind: "data", data, time, seq }));
  const replay = await window.moolin.getScrollback();
  window.moolin.log("debug", "renderer", "replaying", replay.chunks.length, "buffered chunk(s)");
  live.replay(replay);
}
void loadScrollback();

window.moolin.worlds.onOpen((options) => void worldsDialog.open(options));
worldsDialog.dialog.addEventListener("close", () => {
  if (!inputArea.disabled) inputArea.focus();
});

window.moolin.preferences.onOpen((prefs) => preferencesDialog.open(prefs));
preferencesDialog.dialog.addEventListener("close", () => {
  if (!inputArea.disabled) inputArea.focus();
});

// The input area is only usable while connected. The status bar below it
// says what the window is connected to, with the connection's security shown
// at its far right.
function applyConnectionState(state: WindowState): void {
  const connected = state.status === "connected";
  document.title = connected && state.label ? `${state.label} - ${APP_NAME}` : APP_NAME;
  inputArea.disabled = !connected;
  // Also set by writeReplay from the same underlying value (see
  // ScrollbackReplay.wordWrap's own comment for why it's duplicated there):
  // this is the two independent startup IPC calls' *other* half, needed so
  // that live writes arriving after the initial replay keep using the right
  // value even if this one resolves second.
  wordWrapEnabled = state.wordWrap;
  statusBar.dataset.status = state.status;
  statusText.textContent =
    state.status === "connected"
      ? `Connected to ${state.label}`
      : state.status === "connecting"
        ? `Connecting to ${state.label}…`
        : "Not connected";
  // Shown while connected, like the security shield beside it.
  loggingStatus.hidden = !connected;
  loggingStatus.dataset.logging = state.logging ? "on" : "off";
  loggingStatus.title = state.logging ? "Logging is enabled." : "Logging is disabled.";
  loggingStatus.setAttribute("aria-label", loggingStatus.title);
  securityStatus.update(state);
  resizeInput();
  if (connected && !modalOpen()) inputArea.focus();
}
window.moolin.getConnectionState().then(applyConnectionState);
window.moolin.onConnectionState(applyConnectionState);

// Terminal-native "zoom": resizes the actual font (and re-fits cols/rows),
// rather than Chromium's CSS page zoom, which breaks the WebGL canvas/scrollbar.
// direction 0 ("Actual Size") resets to the preferred size, not a fixed one,
// so it tracks whatever's currently saved in the Preferences dialog.
window.moolin.onZoom((direction) => {
  const current = term.options.fontSize ?? preferredFontSize;
  const next =
    direction === 0
      ? preferredFontSize
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + direction * FONT_SIZE_STEP));
  window.moolin.log("debug", "renderer", "zoom", direction, "-> fontSize", next);
  term.options.fontSize = next;
  applyFont(term.options.fontFamily ?? fontFamilyFor(initialFont.fontId), next);
});

// A new default font/size saved in the Preferences dialog; applies
// immediately to this window, same as zoom, but can also change the family.
window.moolin.onSetFont(({ fontFamily, fontSize }) => {
  preferredFontSize = fontSize;
  term.options.fontFamily = fontFamily;
  term.options.fontSize = fontSize;
  applyFont(fontFamily, fontSize);
});

resizeInput();

// A bundled @font-face (the default, Iosevka Moolin — see styles.css) loads
// asynchronously even though it's local, not fetched; xterm measures cell
// size once and doesn't re-measure on its own when a face it's using finishes
// loading. Re-fitting once fonts are actually ready catches that, and is
// cheap/harmless for a system font that was already available immediately.
document.fonts.ready.then(() => {
  fitAddon.fit();
  scheduleGutter();

  // A freshly opened (non-cascaded) window asks main.ts to size it so this
  // terminal shows 80x25 characters, centered on screen (see WindowManager).
  // Cell size and the chrome around the terminal (gutter, divider, input
  // area, status bar) are both measured rather than computed, for the same
  // reason cellHeight() is: they depend on the actual font and layout, not
  // just the numbers that went into them.
  if (window.moolin.fitToContentOnLoad) {
    window.moolin.reportInitialSize({
      width: cellWidth() * 80 + (window.innerWidth - terminalContainer.clientWidth),
      height: cellHeight() * 25 + (window.innerHeight - terminalContainer.clientHeight),
    });
  }
});
