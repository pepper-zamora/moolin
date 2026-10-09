import { BrowserWindow, Menu } from "electron";
import { ConnectionManager, type WindowState } from "./connection-manager";
import { ScrollbackBuffer, type ScrollbackReplay, type TerminalChunk } from "./scrollback-buffer";
import { IpcChannels } from "./ipc-channels";
import { log } from "./logger";
import { WindowLog, type LogHistory, type SessionLogRegistry } from "./session-log";
import type { ConnectTarget } from "./worlds-types";

const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;

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

  // Switches to `target`'s log. If this window gets to own it, the scrollback
  // is replaced by the log's tail; otherwise (another window is connected to
  // the same world/character and logging it) the window starts empty and
  // doesn't log, so nothing is recorded twice. The status bar shows which
  // (see getState).
  private startLog(target: ConnectTarget): void {
    let history: LogHistory = { bytes: new Uint8Array(), times: [] };
    try {
      history = this.sessionLog.open(target.world, target.character, MAX_SCROLLBACK_BYTES);
    } catch (error) {
      // Couldn't find or rename its folder; connect anyway, without a log.
      log("error", "main", `window ${this.window.id} log unavailable:`, (error as Error).message);
    }
    log("debug", "main", `window ${this.window.id} log`, this.sessionLog.file ?? "owned by another window");
    this.scrollback.reset(history.bytes.length > 0 ? [history.bytes] : [], history.times);
    this.seq++;
    this.send(IpcChannels.terminalReset, this.getScrollback());
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
  // session log if this window owns one. `time` is the line's arrival time, or
  // null for lines that carry no timestamp.
  private write(data: TerminalChunk, time: number | null): void {
    this.sessionLog.append(data, time);
    this.scrollback.append(data, time);
    this.send(IpcChannels.telnetData, data, time, ++this.seq);
  }

  getState(): WindowState {
    const connection = this.connection.getState();
    return { ...connection, logging: connection.status !== "disconnected" && this.sessionLog.owned };
  }

  getScrollback(): ScrollbackReplay {
    return {
      chunks: this.scrollback.snapshot(),
      times: this.scrollback.snapshotTimes(),
      seq: this.seq,
      pueblo: this.connection.isPueblo(),
      greetingOpen: this.connection.isGreetingOpen(),
    };
  }
}
