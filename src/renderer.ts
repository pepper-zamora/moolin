import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { worldsDialog } from "./worlds-dialog";
import { CommandHistory, isOnFirstLine, isOnLastLine } from "./command-history";
import { InputUndoStack, type InputSnapshot } from "./input-undo";
import type { ConnectionState } from "./connection-manager";

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
  },
});

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
const inputArea = element<HTMLTextAreaElement>("input-area");
const statusBar = element<HTMLDivElement>("status-bar");
const statusText = element<HTMLSpanElement>("status-text");

term.open(terminalContainer);

term.onResize(({ cols, rows }) => {
  window.moolin.log("debug", "renderer", "terminal resized to", `${cols}x${rows}`);
  window.moolin.sendResize(cols, rows);
});

try {
  term.loadAddon(new WebglAddon());
} catch {
  // Falls back to the default DOM renderer if WebGL is unavailable.
}

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

function reportUndoState(): void {
  window.moolin.reportUndoState(inputUndo.canUndo(), inputUndo.canRedo());
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
  term.write("\n".repeat(term.rows));
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
// unless the Worlds dialog is open or there's no connection to type to.
// Clicking the scrollback (e.g. to select text) would otherwise take it;
// xterm's mouse selection doesn't need focus, so it still works.
document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (worldsDialog.isOpen() || inputArea.hidden) return;
    if (document.activeElement !== inputArea) inputArea.focus();
  });
});

// Selecting text in the input means Ctrl+C should copy that, not a stale
// scrollback selection.
inputArea.addEventListener("select", () => term.clearSelection());

// Copy/paste go through Electron's clipboard module (via preload) rather
// than the browser's native copy/paste commands, which don't reliably see
// xterm.js's canvas/WebGL-rendered selection. A scrollback selection wins
// over one in the input area; selecting in the input clears the scrollback
// selection (above), so whichever was made last is what gets copied.
function copySelection(): void {
  const text = term.hasSelection()
    ? term.getSelection()
    : inputArea.value.slice(inputArea.selectionStart, inputArea.selectionEnd);
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
  if (inputArea.hidden) return;
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
window.moolin.onClearScreenRequested(() => clearToOffscreen());

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
    let handled = true;
    if (mod && key === "c") {
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
  window.moolin.showContextMenu({ hasSelection: term.hasSelection() });
});

// Replay the main process's in-memory scrollback buffer (survives a reload),
// then subscribe to live data — in that order, so nothing arriving during the
// fetch gets written twice.
async function loadScrollback(): Promise<void> {
  const chunks = await window.moolin.getScrollback();
  window.moolin.log("debug", "renderer", "replaying", chunks.length, "buffered chunk(s)");
  for (const chunk of chunks) {
    term.write(chunk);
  }
  // Connecting swaps in the world's logged history: start over from it. The
  // chunks ride along in the message so they stay ordered with live data.
  window.moolin.onTerminalReset((history) => {
    isCleared = false;
    term.reset();
    for (const chunk of history) term.write(chunk);
  });
  window.moolin.onTelnetData((data) => {
    isCleared = false;
    term.write(data);
  });
}
void loadScrollback();

window.moolin.worlds.onOpen((options) => void worldsDialog.open(options));
worldsDialog.dialog.addEventListener("close", () => {
  if (!inputArea.hidden) inputArea.focus();
});

// The input area is only usable while connected; otherwise a status strip
// takes its place. The input's background shows whether the connection is
// over TLS.
function applyConnectionState(state: ConnectionState): void {
  const connected = state.status === "connected";
  document.title = connected && state.label ? `${state.label} - ${APP_NAME}` : APP_NAME;
  inputArea.hidden = !connected;
  inputArea.classList.toggle("secure", state.secure);
  statusBar.hidden = connected;
  statusBar.dataset.status = state.status;
  statusText.textContent = state.status === "connecting" ? `Connecting to ${state.label}…` : "Not connected";
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
  resizeInput();
});

resizeInput();
