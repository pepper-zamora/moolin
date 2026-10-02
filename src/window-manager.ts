import { BrowserWindow, screen } from "electron";
import { log } from "./logger";

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

// Owns the two windows this app ever opens (the main terminal window and the
// modal Worlds dialog) so main.ts doesn't have to track their lifecycle as
// loose module-level globals.
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private worldsWindow: BrowserWindow | null = null;

  constructor(
    private readonly appIcon: string,
    private readonly preloadPath: string,
    private readonly rendererArgs: string[],
  ) {}

  get main(): BrowserWindow | null {
    return this.mainWindow;
  }

  // Forwards to the main window's webContents; a no-op if it isn't open.
  send(channel: string, ...args: unknown[]): void {
    this.mainWindow?.webContents.send(channel, ...args);
  }

  sendToWorlds(channel: string, ...args: unknown[]): void {
    this.worldsWindow?.webContents.send(channel, ...args);
  }

  createMainWindow(indexHtmlPath: string): void {
    log("debug", "main", "creating main window");
    const width = 1000;
    const height = 700;
    const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const mainWindow = new BrowserWindow({
      width,
      height,
      ...centeredOn(targetDisplay, width, height),
      icon: this.appIcon,
      backgroundColor: "#000000",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: this.rendererArgs,
      },
    });
    this.mainWindow = mainWindow;

    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      log("debug", "main-console", `level=${level} ${sourceId}:${line} ${message}`);
    });
    mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
      log("error", "main", "did-fail-load", code, desc, url);
    });
    mainWindow.loadFile(indexHtmlPath);
  }

  openWorldsWindow(worldsHtmlPath: string, onReady?: () => void): void {
    if (this.worldsWindow) {
      log("debug", "main", "worlds window already open, focusing");
      this.worldsWindow.focus();
      onReady?.();
      return;
    }

    log("debug", "main", "opening worlds window");
    const width = 640;
    const height = 420;
    const targetDisplay = this.mainWindow
      ? screen.getDisplayMatching(this.mainWindow.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const worldsWindow = new BrowserWindow({
      width,
      height,
      ...centeredOn(targetDisplay, width, height),
      icon: this.appIcon,
      parent: this.mainWindow ?? undefined,
      modal: true,
      frame: false, // Linux WMs don't reliably honor minimizable/maximizable hints; drop the frame instead
      backgroundColor: "#1e1e1e",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: this.rendererArgs,
      },
    });
    this.worldsWindow = worldsWindow;
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
      this.worldsWindow = null;
    });
  }
}
