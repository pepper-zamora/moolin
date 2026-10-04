import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { worldsDialog } from "./worlds-dialog";
import { FindWidget } from "./find-widget";
import { SecurityStatus } from "./security-status";
import { CommandHistory, isOnFirstLine, isOnLastLine } from "./command-history";
import { InputUndoStack, type InputSnapshot } from "./input-undo";
import type { WindowState } from "./connection-manager";
import { countLineFeeds } from "./line-feeds";
import { LiveReplay } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";

window.addEventListener("error", (event) => {
  window.moolin.log("error", "renderer", "uncaught error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.moolin.log("error", "renderer", "unhandled rejection:", event.reason);
});

const APP_NAME = "Moolin";

// Configurable cap; the actual limit is also capped at 1/4 of the window height.
const MAX_INPUT_LINES = 8;

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const FONT_SIZE_STEP = 2;

const term = new Terminal({
  scrollback: 100000,
  convertEol: true,
  disableStdin: true, // scrollback is output-only; all typing goes to #input-area
  cursorInactiveStyle: "none", // term never actually has focus, so the hollow "inactive" cursor is just noise
  allowProposedApi: true, // the search addon's match highlighting uses decorations
  // A strip beside the scrollbar marking where search matches are.
  overviewRuler: { width: 10 },
  fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  fontSize: DEFAULT_FONT_SIZE,
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
const loggingStatus = element<HTMLSpanElement>("logging-status");

term.open(terminalContainer);

const findWidget = new FindWidget(term, () => {
  if (!inputArea.disabled) inputArea.focus();
});

const securityStatus = new SecurityStatus(() => {
  if (!inputArea.disabled && !findWidget.isOpen() && !worldsDialog.isOpen()) inputArea.focus();
});

term.onResize(({ cols, rows }) => {
  window.moolin.log("debug", "renderer", "terminal resized to", `${cols}x${rows}`);
  window.moolin.sendResize(cols, rows);
});

try {
  term.loadAddon(new WebglAddon());
} catch {
  // Falls back to the default DOM renderer if WebGL is unavailable.
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
const lineStamps: Array<{ marker: IMarker; time: Date }> = [];
let timestampsShown = false;
// The time (epoch ms) to stamp onto each upcoming line, or null for a line
// that gets no stamp — Moolin's own status lines, Clear Screen's blank filler,
// and replayed history with no recorded time. Filled in the same order lines
// are written and consumed one per onLineFeed (which fires once for each byte
// countLineFeeds counts), so every line gets exactly the time recorded for it.
const stampQueue: Array<number | null> = [];

// Writes a chunk and queues `time` (or null) for each line it contains, so the
// onLineFeed handler stamps them in step.
function writeStamped(data: string | Uint8Array, time: number | null): void {
  for (let i = 0, n = countLineFeeds(data); i < n; i++) stampQueue.push(time);
  term.write(data);
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

function stampLine(time: Date): void {
  const buffer = term.buffer.active;
  const cursorAbs = buffer.baseY + buffer.cursorY;
  // The line feed moved the cursor off the line it ended; that line is the one
  // just above the cursor. Walk back over wrapped continuation rows so the
  // stamp lands on the logical line's first visual row, not its last.
  let startAbs = cursorAbs - 1;
  if (startAbs < 0) return;
  while (startAbs > 0 && buffer.getLine(startAbs)?.isWrapped) startAbs--;
  const marker = term.registerMarker(startAbs - cursorAbs);
  if (!marker) return;
  const stamp = { marker, time };
  lineStamps.push(stamp);
  marker.onDispose(() => {
    const i = lineStamps.indexOf(stamp);
    if (i !== -1) lineStamps.splice(i, 1);
  });
}

function clearStamps(): void {
  // Empty the list before disposing, so each marker's onDispose handler finds
  // nothing to remove; splicing them out one by one would be O(n²) across a
  // full scrollback.
  for (const { marker } of lineStamps.splice(0)) marker.dispose();
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
  // One queued time per line feed; null means this line carries no stamp.
  const time = stampQueue.shift();
  if (time != null) stampLine(new Date(time));
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
// a multi-line command); with Ctrl they always browse.
inputArea.addEventListener("keydown", (event) => {
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  const ctrlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInput();
  } else if (
    event.key === "ArrowUp" &&
    (ctrlOnly || (plain && isOnFirstLine(inputArea.value, inputArea.selectionStart)))
  ) {
    event.preventDefault();
    showHistoryEntry(history.previous(inputArea.value));
  } else if (
    event.key === "ArrowDown" &&
    (ctrlOnly || (plain && isOnLastLine(inputArea.value, inputArea.selectionEnd)))
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
  if (worldsDialog.isOpen()) return;
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

// Copy/paste go through Electron's clipboard module (via preload) rather
// than the browser's native copy/paste commands, which don't reliably see
// xterm.js's canvas/WebGL-rendered selection. A scrollback selection wins
// over one in the input area; selecting in the input clears the scrollback
// selection (above), so whichever was made last is what gets copied.
function copySelection(): void {
  const text =
    securityStatus.selectedText() ||
    (term.hasSelection()
      ? term.getSelection()
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
    // The Worlds dialog's fields keep the browser's native keys.
    if (worldsDialog.isOpen()) return;
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
    } else if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && key === "l") {
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
  // Leave the Worlds dialog's fields their native context menu.
  if (worldsDialog.isOpen()) return;
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
function writeReplay(replay: ScrollbackReplay): void {
  for (const time of replay.times) stampQueue.push(time);
  for (const chunk of replay.chunks) term.write(chunk);
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
    clearStamps();
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

// The input area is only usable while connected. The status bar below it
// says what the window is connected to, with the connection's security shown
// at its far right.
function applyConnectionState(state: WindowState): void {
  const connected = state.status === "connected";
  document.title = connected && state.label ? `${state.label} - ${APP_NAME}` : APP_NAME;
  inputArea.disabled = !connected;
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
  if (connected && !worldsDialog.isOpen()) inputArea.focus();
}
window.moolin.getConnectionState().then(applyConnectionState);
window.moolin.onConnectionState(applyConnectionState);

// Terminal-native "zoom": resizes the actual font (and re-fits cols/rows),
// rather than Chromium's CSS page zoom, which breaks the WebGL canvas/scrollbar.
window.moolin.onZoom((direction) => {
  const current = term.options.fontSize ?? DEFAULT_FONT_SIZE;
  const next =
    direction === 0
      ? DEFAULT_FONT_SIZE
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + direction * FONT_SIZE_STEP));
  window.moolin.log("debug", "renderer", "zoom", direction, "-> fontSize", next);
  term.options.fontSize = next;
  inputArea.style.fontSize = `${next}px`;
  gutter.style.fontSize = `${next}px`; // keep the gutter's cell height matched
  resizeInput();
  scheduleGutter();
});

resizeInput();
