import { BrowserWindow, screen, type WebContents } from "electron";
import { TerminalWindow, type TerminalWindowHandlers } from "./terminal-window";
import { log } from "./logger";

const TERMINAL_WIDTH = 1000;
const TERMINAL_HEIGHT = 700;
// How far each new window is offset from the one it was opened from.
const CASCADE_OFFSET = 32;

// BrowserWindow's default placement (and modal centering on its parent) is
// unreliable across monitors on Linux WMs, so we compute explicit x/y
// ourselves rather than relying on Electron/the WM to pick a sane display.
function centeredOn(display: Electron.Display, width: number, height: number): { x: number; y: number } {
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = display.workArea;
  return {
    x: areaX + Math.round((areaWidth - width) / 2),
    y: areaY + Math.round((areaHeight - height) / 2),
  };
}

// Offsets from `from`, wrapping back to its display's top-left corner rather
// than walking off-screen.
function cascadedFrom(from: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const bounds = from.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  let x = bounds.x + CASCADE_OFFSET;
  let y = bounds.y + CASCADE_OFFSET;
  if (x + bounds.width > area.x + area.width || y + bounds.height > area.y + area.height) {
    x = area.x;
    y = area.y;
  }
  return { x, y, width: bounds.width, height: bounds.height };
}

export interface WindowManagerOptions {
  appIcon: string;
  preloadPath: string;
  rendererArgs: string[];
  indexHtmlPath: string;
}

// Owns every terminal window (one per connection) and each one's modal
// Worlds dialog, and maps an IPC sender back to the terminal it belongs to.
export class WindowManager {
  private readonly terminals = new Map<number, TerminalWindow>();
  private readonly worldsWindows = new Map<TerminalWindow, BrowserWindow>();

  constructor(
    private readonly options: WindowManagerOptions,
    private readonly handlers: Omit<TerminalWindowHandlers, "onClosed">,
  ) {}

  all(): TerminalWindow[] {
    return [...this.terminals.values()];
  }

  // `near` is the window this one was opened from, if any; the new window
  // cascades from it instead of being centered under the cursor.
  createTerminalWindow(near?: TerminalWindow): TerminalWindow {
    const bounds = near
      ? cascadedFrom(near.window)
      : {
          ...centeredOn(
            screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
            TERMINAL_WIDTH,
            TERMINAL_HEIGHT,
          ),
          width: TERMINAL_WIDTH,
          height: TERMINAL_HEIGHT,
        };
    const terminal = new TerminalWindow(
      { ...this.options, bounds },
      {
        ...this.handlers,
        onClosed: (closed) => {
          this.terminals.delete(webContentsId);
          this.worldsWindows.get(closed)?.close();
        },
      },
    );
    // Captured now: webContents is no longer accessible once the window closes.
    const webContentsId = terminal.window.webContents.id;
    this.terminals.set(webContentsId, terminal);
    log("debug", "main", "created terminal window", terminal.window.id, "- now", this.terminals.size, "open");
    return terminal;
  }

  // The terminal an IPC message came from: either its own window or its
  // Worlds dialog.
  terminalFor(sender: WebContents): TerminalWindow | undefined {
    const direct = this.terminals.get(sender.id);
    if (direct) return direct;
    for (const [terminal, worldsWindow] of this.worldsWindows) {
      if (!worldsWindow.isDestroyed() && worldsWindow.webContents.id === sender.id) return terminal;
    }
    return undefined;
  }

  sendToWorlds(terminal: TerminalWindow, channel: string, ...args: unknown[]): void {
    this.worldsWindows.get(terminal)?.webContents.send(channel, ...args);
  }

  openWorldsWindow(terminal: TerminalWindow, worldsHtmlPath: string, onReady?: () => void): void {
    const existing = this.worldsWindows.get(terminal);
    if (existing) {
      log("debug", "main", "worlds window already open, focusing");
      existing.focus();
      onReady?.();
      return;
    }

    log("debug", "main", "opening worlds window for terminal", terminal.window.id);
    const width = 640;
    const height = 420;
    const worldsWindow = new BrowserWindow({
      width,
      height,
      ...centeredOn(screen.getDisplayMatching(terminal.window.getBounds()), width, height),
      icon: this.options.appIcon,
      parent: terminal.window,
      modal: true,
      frame: false, // Linux WMs don't reliably honor minimizable/maximizable hints; drop the frame instead
      backgroundColor: "#1e1e1e",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: this.options.rendererArgs,
      },
    });
    this.worldsWindows.set(terminal, worldsWindow);
    worldsWindow.setMenuBarVisibility(false);
    worldsWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      log("debug", "worlds-console", `level=${level} ${sourceId}:${line} ${message}`);
    });
    worldsWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
      log("error", "main", "worlds did-fail-load", code, desc, url);
    });
    if (onReady) {
      worldsWindow.webContents.once("did-finish-load", onReady);
    }
    worldsWindow.loadFile(worldsHtmlPath);
    worldsWindow.on("closed", () => {
      log("debug", "main", "worlds window closed");
      this.worldsWindows.delete(terminal);
    });
  }
}
