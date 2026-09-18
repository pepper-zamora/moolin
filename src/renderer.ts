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
  } else if (event.altKey && event.key === "ArrowUp") {
    event.preventDefault();
    if (historyIndex > 0) {
      if (historyIndex === commandHistory.length) {
        draft = inputArea.value;
      }
      historyIndex -= 1;
      showHistoryEntry();
    }
  } else if (event.altKey && event.key === "ArrowDown") {
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
