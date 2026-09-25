import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

window.addEventListener("error", (event) => {
  window.moolin.log("error", "renderer", "uncaught error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.moolin.log("error", "renderer", "unhandled rejection:", event.reason);
});

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
  fontFamily: "Menlo, Consolas, monospace",
  fontSize: DEFAULT_FONT_SIZE,
  theme: {
    background: "#000000",
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const terminalContainer = document.getElementById("terminal");
if (!terminalContainer) throw new Error("missing #terminal container");
term.open(terminalContainer);

term.onResize(({ cols, rows }) => {
  window.moolin.log("debug", "renderer", "terminal resized to", `${cols}x${rows}`);
  window.moolin.sendResize(cols, rows);
});

try {
  term.loadAddon(new WebglAddon());
} catch {
  // Falls back to the default canvas renderer if WebGL is unavailable.
}

const inputArea = document.getElementById("input-area") as HTMLTextAreaElement;

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

const commandHistory: string[] = [];
let historyIndex = 0; // equals commandHistory.length when not browsing history
let draft = ""; // what was typed before navigating into history, restored past the newest entry

function showHistoryEntry(): void {
  inputArea.value = historyIndex < commandHistory.length ? commandHistory[historyIndex] : draft;
  inputArea.selectionStart = inputArea.selectionEnd = inputArea.value.length;
  resizeInput();
}

function sendInput(): void {
  const text = inputArea.value;
  inputArea.value = "";
  resizeInput();
  if (text.length > 0) {
    commandHistory.push(text);
  }
  historyIndex = commandHistory.length;
  draft = "";
  window.moolin.log("debug", "renderer", "sending input, length =", text.length);
  window.moolin.sendInput(text);
}

inputArea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendInput();
  } else if (event.key === "PageUp") {
    event.preventDefault();
    term.scrollPages(-1);
  } else if (event.key === "PageDown") {
    event.preventDefault();
    term.scrollPages(1);
  } else if (event.ctrlKey && event.key === "ArrowUp") {
    event.preventDefault();
    if (historyIndex > 0) {
      if (historyIndex === commandHistory.length) {
        draft = inputArea.value;
      }
      historyIndex -= 1;
      showHistoryEntry();
    }
  } else if (event.ctrlKey && event.key === "ArrowDown") {
    event.preventDefault();
    if (historyIndex < commandHistory.length) {
      historyIndex += 1;
      showHistoryEntry();
    }
  }
});

inputArea.addEventListener("input", () => resizeInput());

window.addEventListener("resize", () => resizeInput());

// Clicking into the scrollback should return focus to the input, unless the
// click was part of selecting text to copy.
terminalContainer.addEventListener("mouseup", () => {
  const selection = window.getSelection();
  if (!selection || selection.toString() === "") {
    inputArea.focus();
  }
});

// Copy/paste go through Electron's clipboard module (via preload) rather
// than the browser's native copy/paste commands, which don't reliably see
// xterm.js's canvas/WebGL-rendered selection. Prefers an active input-area
// selection over a terminal selection, so copying works no matter which one
// the user last selected in.
function copySelection(): void {
  if (document.activeElement === inputArea && inputArea.selectionStart !== inputArea.selectionEnd) {
    window.moolin.clipboard.writeText(
      inputArea.value.slice(inputArea.selectionStart ?? 0, inputArea.selectionEnd ?? 0),
    );
    return;
  }
  const text = term.getSelection();
  if (text.length > 0) {
    window.moolin.clipboard.writeText(text);
  }
}

// The terminal is output-only, so pasted text always lands in the input
// area — at the current cursor/selection if it's focused, otherwise appended
// at the end.
async function pasteIntoInput(): Promise<void> {
  const text = await window.moolin.clipboard.readText();
  if (!text) return;
  const active = document.activeElement === inputArea;
  const start = active ? (inputArea.selectionStart ?? inputArea.value.length) : inputArea.value.length;
  const end = active ? (inputArea.selectionEnd ?? inputArea.value.length) : inputArea.value.length;
  inputArea.value = inputArea.value.slice(0, start) + text + inputArea.value.slice(end);
  inputArea.focus();
  inputArea.selectionStart = inputArea.selectionEnd = start + text.length;
  resizeInput();
}

// xterm's own keydown handling runs in the capture phase on its internal
// helper textarea (which holds focus while the user drags to select terminal
// text) and stops the event from ever bubbling to the window listener below.
// Returning false here short-circuits xterm's handling for Ctrl/Cmd+C/+V
// before that happens, letting the event continue to the window listener.
term.attachCustomKeyEventHandler((event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.type !== "keydown" || !mod) return true;
  const key = event.key.toLowerCase();
  return key !== "c" && key !== "v";
});

window.moolin.onCopyRequested(() => copySelection());
window.moolin.onPasteRequested(() => void pasteIntoInput());
window.moolin.onSelectAllRequested(() => term.selectAll());

// No accelerator claims Ctrl/Cmd+C or +V at the menu level (see main.ts), so
// they reach here as normal keydown events; preventDefault suppresses the
// browser's native (unreliable) copy/paste before it can run.
window.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  if (event.key.toLowerCase() === "c") {
    event.preventDefault();
    copySelection();
  } else if (event.key.toLowerCase() === "v") {
    event.preventDefault();
    void pasteIntoInput();
  }
});

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.moolin.showContextMenu({ hasSelection: term.hasSelection() });
});

resizeInput();
inputArea.focus();

// Replay the main process's in-memory scrollback buffer (survives a reload),
// then subscribe to live data — in that order, so nothing arriving during the
// fetch gets written twice.
async function loadScrollback(): Promise<void> {
  const chunks = await window.moolin.getScrollback();
  window.moolin.log("debug", "renderer", "replaying", chunks.length, "buffered chunk(s)");
  for (const chunk of chunks) {
    term.write(chunk);
  }
  window.moolin.onTelnetData((data) => term.write(data));
}
void loadScrollback();

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
