import "./styles.css";
import { worldsDialog } from "./worlds-dialog";
import { preferencesDialog } from "./preferences-dialog";
import { FindWidget } from "./find-widget";
import { SecurityStatus } from "./security-status";
import { CommandHistory, isOnFirstLine, isOnLastLine } from "./command-history";
import { InputUndoStack, type InputSnapshot } from "./input-undo";
import type { WindowState } from "./connection-manager";
import { LinkMenu } from "./link-menu";
import { LiveReplay } from "./live-replay";
import { linkCommands } from "./pueblo";
import type { ScrollbackReplay } from "./scrollback-buffer";
import { fontFamilyFor, MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "./fonts";
import { chooseSelectAllTarget, type SelectAllTarget } from "./select-all";
import { ScrollbackView } from "./scrollback-view";
import { TimestampGutter } from "./timestamp-gutter";

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
let fontFamily = fontFamilyFor(initialFont.fontId);

// Lines kept in the scrollback; the oldest are dropped past this.
const SCROLLBACK_LINES = 20000;

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const terminalContainer = element<HTMLDivElement>("terminal");
const gutterElement = element<HTMLDivElement>("gutter");
const inputArea = element<HTMLTextAreaElement>("input-area");
const statusBar = element<HTMLDivElement>("status-bar");
const statusText = element<HTMLSpanElement>("status-text");
const screenSize = element<HTMLSpanElement>("screen-size");
const loggingStatus = element<HTMLSpanElement>("logging-status");

// What the status bar's left area says when the pointer isn't over a link:
// the connection state, which a link's target temporarily replaces.
let statusMessage = statusText.textContent ?? "";
let hoverMessage: string | null = null;
function showStatus(): void {
  statusText.textContent = hoverMessage ?? statusMessage;
}
function setHoverMessage(message: string | null): void {
  hoverMessage = message;
  showStatus();
}

// A Pueblo link's command goes out as if typed (and is echoed the same way).
function sendLinkCommand(command: string): void {
  window.moolin.sendInput(command);
}

const linkMenu = new LinkMenu(sendLinkCommand);

// The scrollback is output-only; all typing goes to #input-area, and the
// scrollback never takes keyboard focus (see reclaimFocus).

// How long after a click in the scrollback another can still make it a double
// or triple click (the usual system default).
const MULTI_CLICK_MS = 500;
let reclaimTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPendingReclaim(): void {
  if (reclaimTimer !== null) clearTimeout(reclaimTimer);
  reclaimTimer = null;
}

const view = new ScrollbackView(terminalContainer, {
  maxLines: SCROLLBACK_LINES,
  fontFamily,
  fontSize: initialFont.fontSize,
  wordWrap: false, // set from the connection once it's known (applyConnectionState)
  onResize: (cols, rows) => {
    window.moolin.log("debug", "renderer", "terminal resized to", `${cols}x${rows}`);
    window.moolin.sendResize(cols, rows);
    screenSize.textContent = `${cols}x${rows}`;
  },
  // Renderer has no direct access to Electron's `shell` module (sandboxed),
  // so opening the link is proxied through main.ts.
  onOpenUrl: (url) => window.moolin.openExternal(url),
  onLink: (link) => {
    if (link.cmd !== null) {
      const [command] = linkCommands(link.cmd, link.text);
      if (command) sendLinkCommand(command);
    } else if (link.href !== null && /^https?:\/\//i.test(link.href)) {
      window.moolin.openExternal(link.href);
    }
  },
  // A link with several commands offers them in a menu.
  onLinkMenu: (link, event) => {
    const commands = link.cmd === null ? [] : linkCommands(link.cmd, link.text);
    if (commands.length < 2) return false;
    linkMenu.show(commands, event.clientX, event.clientY);
    return true;
  },
  // Where a link goes is shown in the status bar while the pointer is on it.
  onHover: (target) => {
    if (target === null) setHoverMessage(null);
    else if ("url" in target) setHoverMessage(target.url);
    else if (target.link.cmd !== null)
      setHoverMessage(`Send: ${linkCommands(target.link.cmd, target.link.text).join(" | ")}`);
    else setHoverMessage(target.link.href);
  },
  log: (message) => window.moolin.log("debug", "renderer", message),
  onPointerDown: () => cancelPendingReclaim(),
  onPointerUp: () => {
    // Not at once: focusing the input area replaces the document's selection,
    // which would cut short a double or triple click still going on. Only the
    // time the system allows between clicks is waited out, and typing in the
    // meantime claims focus straight away (see the keydown handler).
    cancelPendingReclaim();
    reclaimTimer = setTimeout(() => {
      reclaimTimer = null;
      reclaimFocus();
    }, MULTI_CLICK_MS);
  },
});
screenSize.textContent = `${view.cells.cols}x${view.cells.rows}`;

const gutter = new TimestampGutter(gutterElement, view);

// Keeps the input area and gutter's font matched to the scrollback's, since
// neither shares its element; used at startup and whenever the font changes
// (terminal-native zoom, or a new default saved in the Preferences dialog).
function applyFont(family: string, size: number): void {
  fontFamily = family;
  inputArea.style.fontFamily = family;
  inputArea.style.fontSize = `${size}px`;
  view.setFont(family, size);
  gutter.setFont(family, size);
  resizeInput();
}
applyFont(fontFamily, initialFont.fontSize);

const findWidget = new FindWidget(view, () => {
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

// Clear Screen (Ctrl+L, and View > Clear Screen): see ScrollbackView.clear.
function clearToOffscreen(): void {
  view.clear();
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

// Working in the input line (clicking into it, or editing it) ends a lingering
// scrollback selection, so Select All then means the input line.
inputArea.addEventListener("mousedown", () => view.clearSelection());
// "beforeinput" is captured before the value mutates (unlike "input", which
// fires after), so the pre-edit state can be pushed as an undo step.
// Consecutive keystrokes coalesce into one step via InputUndoStack's own
// debounce.
inputArea.addEventListener("beforeinput", () => {
  view.clearSelection();
  inputUndo.pushTyping(inputSnapshot(), Date.now());
  reportUndoState();
});

window.addEventListener("resize", () => resizeInput());

// Keyboard focus belongs in the input area whenever the window has it,
// unless the Worlds dialog is open or the find widget has it. The connection
// details popup is left alone while the pointer is over it, so its text can
// be selected and copied. The scrollback itself can't take focus, so a click
// in it moves focus to the page, and it's handed back to the input area once
// the mouse is released (not during a drag, which would end the selection).
// While there's no connection to type to, focus is just left off the input,
// leaving keys to the window (and its menu shortcuts).
function reclaimFocus(): void {
  if (modalOpen() || view.isSelecting()) return;
  const active = document.activeElement;
  if (findWidget.root.contains(active) || securityStatus.isHovered()) return;
  if (!inputArea.disabled && active !== inputArea) inputArea.focus();
}
// Checked wherever focus goes, once the event that moved it is done. Both
// directions are needed: in a window that isn't active, focus moves without
// any focusout (clicking an inactive window's scrollback moves focus straight
// from nothing), and the window's own activation is a third way in.
document.addEventListener("focusout", () => setTimeout(reclaimFocus));
document.addEventListener("focusin", () => setTimeout(reclaimFocus));
window.addEventListener("focus", () => setTimeout(reclaimFocus));

// Selecting text in the input means Ctrl+C should copy that, not a stale
// scrollback selection.
inputArea.addEventListener("select", () => view.clearSelection());

// Copy/paste go through Electron's clipboard module (via preload) rather
// than the browser's native copy/paste commands, which act on whichever
// element has focus, and focus is usually in the input area. A scrollback
// selection wins over one in the input area; selecting in the input clears
// the scrollback selection (above), so whichever was made last is what gets
// copied.
function copySelection(): void {
  const text =
    securityStatus.selectedText() ||
    view.selectedText() ||
    inputArea.value.slice(inputArea.selectionStart, inputArea.selectionEnd);
  if (text.length > 0) {
    window.moolin.clipboard.writeText(text);
  }
}

// The scrollback is read-only, so a scrollback selection can't actually be
// removed — Cut just falls back to Copy in that case. Otherwise it cuts from
// the input area like a normal text field.
function cutSelection(): void {
  if (view.selectedText() !== "") {
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
// Select All: the input line, unless something is selected in the scrollback
// (see select-all.ts). Reached from the keyboard and from the Edit and context
// menus; the menus name their target only where they know it.
function selectAll(requested?: SelectAllTarget): void {
  const target = chooseSelectAllTarget(requested, view.selectedText() !== "", !inputArea.disabled);
  if (target === "scrollback") {
    view.selectAll();
  } else {
    inputArea.focus();
    inputArea.select(); // which also lets go of any scrollback selection (see the "select" handler)
  }
}
window.moolin.onSelectAllRequested(selectAll);
window.moolin.onUndoRequested(() => undoInput());
window.moolin.onRedoRequested(() => redoInput());
window.moolin.onFindRequested((action) => {
  if (action === "open") findWidget.open();
  else findWidget.findFromMenu(action);
});
window.moolin.onClearScreenRequested(() => clearToOffscreen());
window.moolin.onToggleTimestamps((show) => {
  // The gutter takes its width from the scrollback when shown (and gives it
  // back when hidden); the view refits itself when its width changes.
  gutter.setShown(show);
});

// Starts the Edit menu's Undo/Redo items disabled until there's anything to act on.
reportUndoState();

// Window-wide keys, captured at the document so they apply wherever focus is
// and run before any other handling. No menu item registers these as real
// accelerators (see main.ts), so they reach here as normal keydowns;
// preventDefault suppresses the browser's native (unreliable, and in the case
// of undo, already-broken — see input-undo.ts) handling.
document.addEventListener(
  "keydown",
  (event) => {
    // Typing right after a click in the scrollback: focus goes to the input
    // area now rather than when the multi-click wait is up.
    if (reclaimTimer !== null) {
      cancelPendingReclaim();
      reclaimFocus();
    }
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
    } else if (editingFind && mod && ["a", "c", "x", "v", "z", "y"].includes(key)) {
      handled = false;
    } else if (mod && !event.shiftKey && key === "a") {
      selectAll();
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
      view.scrollPages(event.key === "PageUp" ? -1 : 1);
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
    securityStatus.selectedText() !== "" ||
    view.selectedText() !== "" ||
    inputArea.selectionStart !== inputArea.selectionEnd;
  // Select All there means what was clicked on: the scrollback, or the input line.
  const selectAllTarget = terminalContainer.contains(event.target as Node) ? "scrollback" : "input";
  window.moolin.showContextMenu({ hasSelection, selectAllTarget });
});

// Replays buffered history (the in-memory buffer on reload, or a world's log
// on connect), giving each line the recorded arrival time that goes with it.
// Lines with no recorded time (null — old history, or Moolin's own lines) get
// no stamp (see GAPS.md §8).
function writeReplay(replay: ScrollbackReplay): void {
  view.replay(replay.chunks, replay.times, replay.pueblo, replay.greetingOpen);
}

// Starts over from a replay: the connect-time switch to a world's logged
// history.
function applyReset(replay: ScrollbackReplay): void {
  view.reset();
  writeReplay(replay);
}

function applyData(data: string | Uint8Array, time: number | null): void {
  view.write(data, time);
}

// Replay the main process's in-memory scrollback buffer (survives a reload,
// and catches a new window up on what was written before its page loaded),
// then follow live output. Subscribing before fetching, and letting LiveReplay
// drop what the replay already contains, keeps any line from being lost or
// shown twice (see live-replay.ts).
async function loadScrollback(): Promise<void> {
  const live = new LiveReplay(writeReplay, (event) => {
    if (event.kind === "data") applyData(event.data, event.time);
    else if (event.kind === "greetingClosed") view.closeGreeting();
    else applyReset(event.replay);
  });
  window.moolin.onTerminalReset((replay) => live.receive({ kind: "reset", replay }));
  window.moolin.onTelnetData((data, time, seq) => live.receive({ kind: "data", data, time, seq }));
  window.moolin.onGreetingClosed((seq) => live.receive({ kind: "greetingClosed", seq }));
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
  view.setWordWrap(state.wordWrap);
  statusBar.dataset.status = state.status;
  statusMessage =
    state.status === "connected"
      ? `Connected to ${state.label}`
      : state.status === "connecting"
        ? `Connecting to ${state.label}…`
        : "Not connected";
  showStatus();
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
// rather than Chromium's CSS page zoom, which would scale the scrollbar and
// leave the cols/rows the server was told out of step.
// direction 0 ("Actual Size") resets to the preferred size, not a fixed one,
// so it tracks whatever's currently saved in the Preferences dialog.
window.moolin.onZoom((direction) => {
  const current = view.fontSize;
  const next =
    direction === 0
      ? preferredFontSize
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + direction * FONT_SIZE_STEP));
  window.moolin.log("debug", "renderer", "zoom", direction, "-> fontSize", next);
  applyFont(fontFamily, next);
});

// A new default font/size saved in the Preferences dialog; applies
// immediately to this window, same as zoom, but can also change the family.
window.moolin.onSetFont(({ fontFamily: family, fontSize }) => {
  preferredFontSize = fontSize;
  applyFont(family, fontSize);
});

resizeInput();

// A bundled @font-face (the default, Iosevka Moolin — see styles.css) loads
// asynchronously even though it's local, not fetched, and the character cell
// measured before it arrived is the fallback font's. Remeasuring once fonts
// are actually ready catches that, and is cheap/harmless for a system font
// that was already available immediately.
document.fonts.ready.then(() => {
  view.refit();
  gutter.schedule();

  // A freshly opened (non-cascaded) window asks main.ts to size it so this
  // scrollback shows 80x25 characters, centered on screen (see WindowManager).
  // Cell size and the chrome around the scrollback (gutter, divider, input
  // area, status bar) are both measured rather than computed, since they
  // depend on the actual font and layout, not just the numbers that went into
  // them.
  if (window.moolin.fitToContentOnLoad) {
    window.moolin.reportInitialSize({
      width: view.cellWidth() * 80 + (window.innerWidth - terminalContainer.clientWidth),
      height: view.lineHeight() * 25 + (window.innerHeight - terminalContainer.clientHeight),
    });
  }
});
