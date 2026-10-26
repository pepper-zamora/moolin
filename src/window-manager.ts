import { screen, type BrowserWindow, type WebContents } from "electron";
import type { SessionLogRegistry } from "./session-log";
import { TerminalWindow, type TerminalWindowHandlers } from "./terminal-window";
import { log } from "./logger";

// Used only until a fresh (non-cascaded) window reports its actual measured
// size for an 80x25 terminal at its starting font (see applyInitialSize);
// kept as a sane starting point so the window isn't absurdly sized for the
// instant before that report arrives.
const TERMINAL_WIDTH = 1000;
const TERMINAL_HEIGHT = 700;
// How far each new window is offset from the one it was opened from.
const CASCADE_OFFSET = 32;
// If an 80x25 fit would overflow the display, fall back to this fraction of
// its work area instead — most likely reachable only with a very large font.
const FALLBACK_SCREEN_FRACTION = 0.75;

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

// Falls back to a fixed fraction of the work area if the desired content
// size wouldn't fit it at all, rather than fighting the OS to force it.
function clampToWorkArea(display: Electron.Display, width: number, height: number): { width: number; height: number } {
  const { width: areaWidth, height: areaHeight } = display.workArea;
  if (width > areaWidth || height > areaHeight) {
    return {
      width: Math.round(areaWidth * FALLBACK_SCREEN_FRACTION),
      height: Math.round(areaHeight * FALLBACK_SCREEN_FRACTION),
    };
  }
  return { width: Math.round(width), height: Math.round(height) };
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
  // Computed fresh for each window (not a fixed array), since the font
  // preferences it carries can change at runtime via the Preferences dialog.
  rendererArgs: () => string[];
  indexHtmlPath: string;
  // Where session logs live, and who currently owns which.
  logRoot: string;
  logs: SessionLogRegistry;
}

// Owns every terminal window (one per connection) and maps an IPC sender
// back to the terminal it belongs to.
export class WindowManager {
  private readonly terminals = new Map<number, TerminalWindow>();
  // Windows awaiting their one-shot initial-size report (see
  // applyInitialSize); only fresh, non-cascaded windows ask for one.
  private readonly pendingInitialFit = new Set<number>();

  constructor(
    private readonly options: WindowManagerOptions,
    private readonly handlers: Omit<TerminalWindowHandlers, "onClosed">,
  ) {}

  all(): TerminalWindow[] {
    return [...this.terminals.values()];
  }

  // `near` is the window this one was opened from, if any; the new window
  // cascades from it instead of being centered and fit to an 80x25 terminal.
  createTerminalWindow(near?: TerminalWindow): TerminalWindow {
    const fitToContent = !near;
    const bounds = near
      ? cascadedFrom(near.window)
      : {
          ...centeredOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), TERMINAL_WIDTH, TERMINAL_HEIGHT),
          width: TERMINAL_WIDTH,
          height: TERMINAL_HEIGHT,
        };
    const rendererArgs = this.options.rendererArgs();
    const terminal = new TerminalWindow(
      {
        ...this.options,
        rendererArgs: fitToContent ? [...rendererArgs, "--fit-to-content"] : rendererArgs,
        bounds,
      },
      {
        ...this.handlers,
        onClosed: () => {
          this.terminals.delete(webContentsId);
          this.pendingInitialFit.delete(terminal.window.id);
        },
      },
    );
    // Captured now: webContents is no longer accessible once the window closes.
    const webContentsId = terminal.window.webContents.id;
    this.terminals.set(webContentsId, terminal);
    if (fitToContent) this.pendingInitialFit.add(terminal.window.id);
    log("debug", "main", "created terminal window", terminal.window.id, "- now", this.terminals.size, "open");
    return terminal;
  }

  terminalFor(sender: WebContents): TerminalWindow | undefined {
    return this.terminals.get(sender.id);
  }

  // A fresh window's one-shot report of the content size it measured for an
  // 80x25 terminal at its starting font. Applied once, then ignored for any
  // further reports and for windows that never asked (a cascaded window, or
  // a duplicate/late report) — no back-and-forth with the OS over it.
  applyInitialSize(sender: WebContents, size: { width: number; height: number }): void {
    const terminal = this.terminalFor(sender);
    if (!terminal || !this.pendingInitialFit.delete(terminal.window.id)) return;
    if (!(size.width > 0 && size.height > 0)) {
      log("warn", "main", "ignoring a degenerate initial-size report:", JSON.stringify(size));
      return;
    }
    const display = screen.getDisplayMatching(terminal.window.getBounds());
    const { width, height } = clampToWorkArea(display, size.width, size.height);
    terminal.window.setContentSize(width, height);
    const outer = terminal.window.getBounds();
    const { x, y } = centeredOn(display, outer.width, outer.height);
    terminal.window.setPosition(x, y);
  }
}
