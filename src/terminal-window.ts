import { BrowserWindow, Menu } from "electron";
import { ConnectionManager } from "./connection-manager";
import { ScrollbackBuffer, type TerminalChunk } from "./scrollback-buffer";
import { IpcChannels } from "./ipc-channels";
import { log } from "./logger";
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

    this.connection = new ConnectionManager(
      {
        onStateChange: () => {
          handlers.onStateChange(this);
          this.send(IpcChannels.connectionState, this.connection.getState());
        },
        onMessage: (text) => this.write(text),
        onData: (data) => this.write(data),
        onConnected: (target) => handlers.onConnected(target),
      },
      (level, ...args) => log(level, `telnet:${id}`, ...args),
    );

    this.window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
      log("debug", `console:${id}`, `level=${level} ${sourceId}:${lineNumber} ${message}`);
    });
    this.window.webContents.on("did-fail-load", (_event, code, desc, url) => {
      log("error", "main", `window ${id} did-fail-load`, code, desc, url);
    });
    // macOS has one application menu, so it follows the focused window.
    this.window.on("focus", () => {
      if (process.platform === "darwin" && this.menu) Menu.setApplicationMenu(this.menu);
    });
    this.window.on("closed", () => {
      log("debug", "main", `window ${id} closed`);
      this.connection.disconnect();
      handlers.onClosed(this);
    });
    this.window.loadFile(options.indexHtmlPath);
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

  // Appends to the scrollback, both live and in the replay buffer.
  write(data: TerminalChunk): void {
    this.scrollback.append(data);
    this.send(IpcChannels.telnetData, data);
  }

  getScrollback(): TerminalChunk[] {
    return this.scrollback.snapshot();
  }
}
