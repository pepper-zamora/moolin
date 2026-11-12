import { BrowserWindow, Menu } from "electron";
import { ConnectionManager, type WindowState } from "./connection-manager";
import { ScrollbackBuffer, type ScrollbackReplay, type TerminalChunk } from "./scrollback-buffer";
import {
  PAGE_BYTES,
  PAGE_LINES,
  SCROLLBACK_LINES,
  STALE_PAGE,
  type HistoryPage,
  type HistoryRequest,
} from "./history-paging";
import { IpcChannels } from "./ipc-channels";
import type { LogPage } from "./log-format";
import { log } from "./logger";
import { WindowLog, type SessionLogRegistry } from "./session-log";
import type { ConnectTarget } from "./worlds-types";

const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;

// `replay` with its history taken from the log: `page`, and after it the
// unfinished line the window has yet to log.
function withPage(replay: ScrollbackReplay, page: LogPage, held: Uint8Array): ScrollbackReplay {
  const chunks = [page.bytes, held].filter((chunk) => chunk.length > 0);
  return { ...replay, chunks, times: page.times, fromLog: true, before: page.before };
}

export interface TerminalWindowHandlers {
  // Connected/secure state changed — refresh this window's menu.
  onStateChange: (terminal: TerminalWindow) => void;
  // A successful connection, for MRU persistence.
  onConnected: (target: ConnectTarget) => void;
  onClosed: (terminal: TerminalWindow) => void;
}

export interface TerminalWindowOptions {
  appIcon: string;
  preloadPath: string;
  rendererArgs: string[];
  indexHtmlPath: string;
  logRoot: string;
  logs: SessionLogRegistry;
  bounds: { x: number; y: number; width: number; height: number };
}

// One terminal window and everything that belongs to it: its BrowserWindow,
// its (at most one) connection, and the replay buffer of what it has shown.
// Each world gets its own window, so nothing here is shared between them.
export class TerminalWindow {
  readonly window: BrowserWindow;
  readonly connection: ConnectionManager;
  private readonly scrollback = new ScrollbackBuffer(MAX_SCROLLBACK_BYTES);
  private menu: Menu | null = null;
  // Reported by the renderer whenever the input's undo/redo stacks change,
  // so the Edit menu's Undo/Redo items can be rebuilt with the right
  // `enabled` state (see buildMenu in main.ts).
  canUndoInput = false;
  canRedoInput = false;
  // Whether the per-line timestamp gutter is shown. Lives here (not just in
  // the renderer) so the View menu's checkbox keeps its state across menu
  // rebuilds, and so it can be re-pushed to the renderer after a reload.
  showTimestamps = false;
  // The persistent log of this window's connection. It's held from the start
  // of a connection attempt until it ends, unless another window connected
  // to the same world/character already holds it.
  private readonly sessionLog: WindowLog;
  // Numbers each write and reset sent to the renderer, so a renderer that
  // fetches the scrollback (getScrollback) while live output is also arriving
  // can tell which live messages that replay already contains. The replay
  // comes back over a different IPC path from the live messages, so the two
  // aren't ordered relative to each other.
  private seq = 0;

  constructor(options: TerminalWindowOptions, handlers: TerminalWindowHandlers) {
    this.window = new BrowserWindow({
      ...options.bounds,
      icon: options.appIcon,
      backgroundColor: "#000000",
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // The default since Electron 20, stated so that it stays so.
        sandbox: true,
        additionalArguments: options.rendererArgs,
      },
    });
    const id = this.window.id;
    this.sessionLog = new WindowLog(options.logs, options.logRoot);

    this.connection = new ConnectionManager(
      {
        onConnecting: (target) => this.startLog(target),
        onStateChange: () => {
          // Closing the window disconnects it, which lands here after the
          // BrowserWindow is destroyed; there is no menu left to refresh.
          if (this.window.isDestroyed()) return;
          handlers.onStateChange(this);
          this.send(IpcChannels.connectionState, this.getState());
        },
        onMessage: (text) => this.writeStatus(text),
        onData: (data) => this.writeServerData(data),
        onConnected: (target) => handlers.onConnected(target),
        // After the "disconnected" line, so the log ends with it.
        onDisconnected: () => this.sessionLog.release(),
        onGreetingClosed: () => this.send(IpcChannels.terminalGreetingClosed, ++this.seq),
      },
      (level, ...args) => log(level, `telnet:${id}`, ...args),
    );

    // The page is local and never navigates or opens windows of its own; a
    // link in the scrollback is opened through the main process, http(s) only.
    // (A reload is not a navigation, so View > Reload still works.)
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.window.webContents.on("will-attach-webview", (event) => event.preventDefault());

    this.window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
      log("debug", `console:${id}`, `level=${level} ${sourceId}:${lineNumber} ${message}`);
    });
    this.window.webContents.on("did-fail-load", (_event, code, desc, url) => {
      log("error", "main", `window ${id} did-fail-load`, code, desc, url);
    });
    // The renderer starts each (re)load with the gutter hidden; re-push the
    // remembered state so a reload doesn't desync it from the menu checkbox.
    this.window.webContents.on("did-finish-load", () => {
      this.send(IpcChannels.terminalToggleTimestamps, this.showTimestamps);
    });
    // macOS has one application menu, so it follows the focused window.
    this.window.on("focus", () => {
      if (process.platform === "darwin" && this.menu) Menu.setApplicationMenu(this.menu);
    });
    this.window.on("closed", () => {
      log("debug", "main", `window ${id} closed`);
      // Logs the disconnect and releases the log (see onDisconnected); the
      // release also covers a window that has no connection.
      this.connection.disconnect();
      this.sessionLog.release();
      handlers.onClosed(this);
    });
    this.window.loadFile(options.indexHtmlPath);
  }

  // Returns whether anything changed (and so the menu needs rebuilding).
  setUndoState(canUndo: boolean, canRedo: boolean): boolean {
    if (canUndo === this.canUndoInput && canRedo === this.canRedoInput) return false;
    this.canUndoInput = canUndo;
    this.canRedoInput = canRedo;
    return true;
  }

  setMenu(menu: Menu): void {
    this.menu = menu;
    if (process.platform === "darwin") {
      if (this.window.isFocused()) Menu.setApplicationMenu(menu);
    } else {
      this.window.setMenu(menu);
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, ...args);
  }

  // Switches to `target`'s log, shared with any other window connected to the
  // same world and character (it keeps one copy of each line they all receive),
  // and replaces the scrollback with the log's tail. If the log can't be
  // opened the window starts empty and doesn't log; the status bar shows
  // whether it is logging (see getState).
  private startLog(target: ConnectTarget): void {
    let history: LogPage = { bytes: new Uint8Array(), times: [], before: null, after: null };
    let unavailable: string | null = null;
    try {
      history = this.sessionLog.open(target.world, target.character, MAX_SCROLLBACK_BYTES, SCROLLBACK_LINES);
    } catch (error) {
      // Couldn't find or rename its folder; connect anyway, without a log.
      unavailable = (error as Error).message;
      log("error", "main", `window ${this.window.id} log unavailable:`, unavailable);
    }
    log("debug", "main", `window ${this.window.id} log`, this.sessionLog.file ?? "none");
    this.scrollback.reset(history.bytes.length > 0 ? [history.bytes] : [], history.times);
    this.seq++;
    this.send(IpcChannels.terminalReset, this.replayOf(this.sessionLog.logging ? history : null, new Uint8Array()));
    if (unavailable) this.writeStatus(`\x1b[33m[not logging: ${unavailable}]\x1b[0m\r\n`);
  }

  // Server output, timestamped with its arrival time (the only lines that get
  // a timestamp in the gutter).
  writeServerData(data: TerminalChunk): void {
    this.write(data, Date.now());
  }

  // Moolin's own lines — connection status, warnings, echoed commands. Logged
  // and shown like server output but never timestamped (time null), so the
  // gutter leaves them blank and the first real server line keeps the stamp.
  writeStatus(data: TerminalChunk): void {
    this.write(data, null);
  }

  // Appends to the scrollback, both live and in the replay buffer, and to the
  // session log if this window is writing one. `time` is the line's arrival time, or
  // null for lines that carry no timestamp.
  private write(data: TerminalChunk, time: number | null): void {
    this.sessionLog.append(data, time);
    this.scrollback.append(data, time);
    this.send(IpcChannels.telnetData, data, time, ++this.seq);
  }

  getState(): WindowState {
    const connection = this.connection.getState();
    return { ...connection, logging: connection.status !== "disconnected" && this.sessionLog.logging };
  }

  // What a window that has just loaded (or reloaded) shows. From the log when
  // there is one, since it holds what every window on the character was sent,
  // and so can be paged back from the line this starts at; otherwise from the
  // buffer, with nothing to page. A line another window has logged but this
  // one has not been sent yet is in the log, so it is shown now and again when
  // it arrives; the gap is the few milliseconds between two connections.
  async getScrollback(): Promise<ScrollbackReplay> {
    // The read starts here, so the page, the unfinished line and the sequence
    // number below all describe the same moment.
    const reading = this.sessionLog.page(
      { before: null },
      { maxBytes: MAX_SCROLLBACK_BYTES, maxLines: SCROLLBACK_LINES },
    );
    const held = this.sessionLog.held();
    const now = this.replayOf(null, held);
    const page = await reading;
    return page ? withPage(now, page, held) : now;
  }

  // A replay of `page` and the unfinished line after it, or of the buffer when
  // there is no page, numbered with the writes so far.
  private replayOf(page: LogPage | null, held: Uint8Array): ScrollbackReplay {
    const replay: ScrollbackReplay = {
      seq: this.seq,
      pueblo: this.connection.isPueblo(),
      greetingOpen: this.connection.isGreetingOpen(),
      chunks: this.scrollback.snapshot(),
      times: this.scrollback.snapshotTimes(),
      fromLog: false,
      before: null,
    };
    return page ? withPage(replay, page, held) : replay;
  }

  // The page of the log before or after a cursor, for scrolling through more
  // history than the window holds. One that reaches the end of the log carries
  // the window's unfinished line and says which writes it covers, so the window
  // can go on from it with live output.
  async getHistoryPage(request: HistoryRequest): Promise<HistoryPage> {
    const from = "before" in request ? { before: request.before } : { after: request.after };
    const reading = this.sessionLog.page(from, { maxBytes: PAGE_BYTES, maxLines: PAGE_LINES, lenient: true });
    const held = this.sessionLog.held();
    const seq = this.seq;
    const page = await reading;
    if (!page) return STALE_PAGE;
    const chunks = [page.bytes];
    if ("after" in request && page.after === null) chunks.push(held);
    return {
      chunks: chunks.filter((chunk) => chunk.length > 0),
      times: page.times,
      before: page.before,
      after: page.after,
      seq,
      stale: false,
    };
  }
}
