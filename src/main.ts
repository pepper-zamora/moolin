import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, net, shell } from "electron";
import * as path from "node:path";
import {
  backupPathFor,
  parseWorld,
  readWorldsFile,
  resolveWorldsPath,
  saveWorlds,
  updateMru as updateMruState,
} from "./worlds";
import { WindowManager } from "./window-manager";
import type { TerminalWindow } from "./terminal-window";
import { configureLogger, getCliLogLevel, log, type LogLevel } from "./logger";
import { SessionLogRegistry } from "./session-log";
import { IpcChannels } from "./ipc-channels";
import {
  preferencesPath,
  readPreferences,
  sanitizePreferences,
  writePreferences,
  type Preferences,
} from "./preferences";
import type { ConnectTarget, MruEntry, World, WorldsLoadResult } from "./worlds-types";
import { targetLabel } from "./world-utils";
import type { WindowState } from "./connection-manager";
import { checkForUpdate } from "./update-check";
import { fontFamilyFor } from "./fonts";

function cliArgs(): string[] {
  return app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
}

function getCliWorldsArg(): string | undefined {
  return cliArgs().find((arg) => !arg.startsWith("-"));
}

// A throwaway test run (scripts/smoke.mjs) that needs its config and log
// directories isolated from the real ones sets these explicitly, since
// Electron only honors XDG_CONFIG_HOME/user-dirs.dirs on Linux — on macOS
// and Windows app.getPath("userData"/"documents") ignores them. Must happen
// before anything below reads either path.
if (process.env.MOOLIN_CONFIG_DIR) {
  app.setPath("userData", process.env.MOOLIN_CONFIG_DIR);
}
if (process.env.MOOLIN_DOCUMENTS_DIR) {
  app.setPath("documents", process.env.MOOLIN_DOCUMENTS_DIR);
}

const logLevel = getCliLogLevel(process.argv);
configureLogger(logLevel);
// Renderer/preload processes are separate OS processes with their own argv
// (Chromium's internal --type=renderer flags, not ours) — hand the level
// down explicitly so preload.ts can compute the same value. Computed fresh
// per window (not a fixed array) since the font prefs it carries can change
// at runtime via the Preferences dialog.
function rendererArgs(): string[] {
  return [`--log-level=${logLevel}`, `--font-id=${prefs.fontId}`, `--font-size=${prefs.fontSize}`];
}

const worldsPath = resolveWorldsPath(getCliWorldsArg());

// One process owns every window, so the worlds file has a single writer.
// Launching moolin again opens a new window in the running instance instead
// of starting a second process.
const isPrimaryInstance = app.requestSingleInstanceLock({ worldsPath });
if (!isPrimaryInstance) {
  app.quit();
} else {
  log("info", "main", "starting, worldsPath =", worldsPath);
}

const MAX_MRU = 5;

const prefsPath = preferencesPath(app.getPath("userData"));
const prefs = readPreferences(prefsPath);

const APP_ICON = path.join(__dirname, "..", "icons", "icon-512.png");
const INDEX_HTML = path.join(__dirname, "..", "src", "index.html");
const PRELOAD_PATH = path.join(__dirname, "preload.js");

const windowManager = new WindowManager(
  {
    appIcon: APP_ICON,
    preloadPath: PRELOAD_PATH,
    rendererArgs,
    indexHtmlPath: INDEX_HTML,
    logRoot: path.join(app.getPath("documents"), "Moolin"),
    logs: new SessionLogRegistry((file, error) => log("error", "main", "session log failed", file, error.message)),
  },
  {
    onStateChange: (terminal) => buildMenu(terminal),
    onConnected: (target) => updateMru(target),
  },
);

function newTerminalWindow(near?: TerminalWindow): TerminalWindow {
  const terminal = windowManager.createTerminalWindow(near);
  // Pushed to the renderer once its page loads (see TerminalWindow).
  terminal.showTimestamps = prefs.showTimestamps;
  buildMenu(terminal);
  return terminal;
}

function rebuildAllMenus(): void {
  for (const terminal of windowManager.all()) buildMenu(terminal);
}

function updateMru(target: ConnectTarget): void {
  const entry: MruEntry = target.character
    ? { worldId: target.world.id, characterId: target.character.id }
    : { worldId: target.world.id };
  const updated = updateMruState(worldsPath, (mru) =>
    [entry, ...mru.filter((e) => e.worldId !== entry.worldId || e.characterId !== entry.characterId)].slice(0, MAX_MRU),
  );
  log("debug", "worlds", "mru updated:", updated);
  rebuildAllMenus();
}

// MRU entries whose world (and character, if any) still exist.
function mruTargets(): ConnectTarget[] {
  const { state } = readWorldsFile(worldsPath);
  const targets: ConnectTarget[] = [];
  for (const entry of state.mru) {
    const world = state.worlds.find((w) => w.id === entry.worldId);
    if (!world) continue;
    if (entry.characterId === undefined) {
      targets.push({ world, character: null });
      continue;
    }
    const character = world.characters.find((c) => c.id === entry.characterId);
    if (character) targets.push({ world, character });
  }
  return targets.slice(0, MAX_MRU);
}

// A window holds at most one connection. Connecting from a window that
// already has one opens the new connection in a window of its own.
function connectOrNewWindow(terminal: TerminalWindow, target: ConnectTarget): void {
  if (terminal.connection.isActive()) {
    newTerminalWindow(terminal).connection.connect(target);
  } else {
    terminal.connection.connect(target);
  }
}

// Asks before doing something; Cancel is the default, so a stray Enter
// (or the Delete key hit by accident) doesn't confirm it.
async function confirmAction(
  parentWindow: BrowserWindow | undefined,
  message: string,
  confirmLabel: string,
  detail?: string,
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Cancel", confirmLabel],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
  };
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);
  const confirmed = result.response === 1;
  log("debug", "main", "confirm dialog:", JSON.stringify(message), "->", confirmed);
  return confirmed;
}

async function confirmDisconnect(terminal: TerminalWindow): Promise<void> {
  const target = terminal.connection.getConnected();
  if (!target) return;
  const label = targetLabel(target.world, target.character);
  const confirmed = await confirmAction(terminal.window, `Disconnect from "${label}"?`, "Disconnect");
  if (confirmed) terminal.connection.disconnect();
}

// The Worlds dialog lives in the terminal window's renderer. "New World"
// reuses the dialog's own create logic rather than main owning a duplicate
// worlds list; the dialog finishes loading the list before creating.
function openWorldsDialog(terminal: TerminalWindow, createNew: boolean): void {
  log("debug", "main", "opening worlds dialog, createNew =", createNew);
  terminal.window.focus();
  terminal.send(IpcChannels.worldsOpen, { createNew });
}

function openPreferences(terminal: TerminalWindow): void {
  terminal.window.focus();
  // showTimestamps is per-window state (see the View menu's checkbox below);
  // the dialog edits this window's actual value, which may have drifted from
  // the stored default if only this window's checkbox was toggled.
  terminal.send(IpcChannels.preferencesOpen, { ...prefs, showTimestamps: terminal.showTimestamps });
}

// How long after startup the automatic update check runs, so it doesn't
// compete with opening the first window.
const UPDATE_CHECK_DELAY_MS = 5000;

// Asks GitHub whether a newer release exists, and if so offers its page.
// The automatic check at startup stays quiet unless there's an update;
// Help > Check for Updates also reports "up to date" and failures.
async function checkForUpdates(parentWindow: BrowserWindow | undefined, manual: boolean): Promise<void> {
  const current = app.getVersion();
  const result = await checkForUpdate(current, net.fetch as unknown as typeof fetch);
  log("info", "main", "update check:", JSON.stringify(result));
  const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined;
  const show = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);

  if (result.status === "update-available") {
    const { response } = await show({
      type: "info",
      buttons: ["Later", "Download"],
      defaultId: 1,
      cancelId: 0,
      message: "A new release of Moolin is available",
      detail: `Moolin ${result.release.version} is available; you have ${current}.\n\nDownload opens the release's page on GitHub.`,
    });
    if (response === 1) void shell.openExternal(result.release.url);
  } else if (manual && result.status === "up-to-date") {
    void show({
      type: "info",
      message: "Moolin is up to date",
      detail: result.latest
        ? `You have ${current}, the latest release.`
        : `You have ${current}; no release is published yet.`,
    });
  } else if (manual && result.status === "failed") {
    void show({ type: "warning", message: "Couldn't check for updates", detail: result.error });
  }
}

// Each window has its own menu, since Disconnect and the MRU entries act on
// that window's connection.
function buildMenu(terminal: TerminalWindow): void {
  const connected = terminal.connection.getConnected() !== null;
  log("debug", "main", "rebuilding menu for window", terminal.window.id, "connected =", connected);
  const mruItems: Electron.MenuItemConstructorOptions[] = mruTargets().map((target, index) => ({
    label: targetLabel(target.world, target.character),
    accelerator: `CmdOrCtrl+${index + 1}`,
    click: () => connectOrNewWindow(terminal, target),
  }));

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "&Worlds",
      submenu: [
        { label: "&New World…", accelerator: "CmdOrCtrl+N", click: () => openWorldsDialog(terminal, true) },
        { label: "&Open World…", accelerator: "CmdOrCtrl+O", click: () => openWorldsDialog(terminal, false) },
        {
          label: "&Disconnect",
          accelerator: "CmdOrCtrl+K",
          enabled: connected,
          click: () => void confirmDisconnect(terminal),
        },
        {
          label: "Close &Window",
          accelerator: "CmdOrCtrl+W",
          click: () => terminal.window.close(),
        },
        ...(mruItems.length > 0 ? ([{ type: "separator" }, ...mruItems] as Electron.MenuItemConstructorOptions[]) : []),
        { type: "separator" },
        { label: "&Preferences…", click: () => openPreferences(terminal) },
        { type: "separator" },
        { role: "quit", label: "&Quit" },
      ],
    },
    {
      // Not the built-in "editMenu" role: its items rely on Chromium's
      // native edit commands against the focused DOM selection, which don't
      // reliably reach into xterm.js's canvas/WebGL-rendered selection (for
      // Cut/Copy/Paste), and whose native undo stack is unusable here anyway
      // (see input-undo.ts). Every item below carries a display-only
      // accelerator (`registerAccelerator: false`): the shortcut text shows
      // up for discoverability, matching the Worlds/View menus, but the key
      // itself is never actually bound here — that would intercept it
      // window-wide, hijacking native editing in the Worlds dialog's own
      // text fields. The renderer's own keydown handling (see renderer.ts)
      // stays the single source of truth for what these keys do.
      label: "&Edit",
      submenu: [
        {
          label: "&Undo",
          accelerator: "CmdOrCtrl+Z",
          registerAccelerator: false,
          enabled: terminal.canUndoInput,
          click: () => terminal.send(IpcChannels.terminalUndoRequested),
        },
        {
          label: "&Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          registerAccelerator: false,
          enabled: terminal.canRedoInput,
          click: () => terminal.send(IpcChannels.terminalRedoRequested),
        },
        { type: "separator" },
        {
          label: "Cu&t",
          accelerator: "CmdOrCtrl+X",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalCutRequested),
        },
        {
          label: "&Copy",
          accelerator: "CmdOrCtrl+C",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalCopyRequested),
        },
        {
          label: "&Paste",
          accelerator: "CmdOrCtrl+V",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalPasteRequested),
        },
        { type: "separator" },
        {
          label: "Select &All",
          accelerator: "CmdOrCtrl+A",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalSelectAllRequested),
        },
        { type: "separator" },
        {
          label: "&Find…",
          accelerator: "CmdOrCtrl+F",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalFindRequested, "open"),
        },
        {
          label: "Find &Next",
          accelerator: "F3",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalFindRequested, "next"),
        },
        {
          label: "Find Pre&vious",
          accelerator: "Shift+F3",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalFindRequested, "previous"),
        },
      ],
    },
    {
      label: "&View",
      // Not the built-in "viewMenu" role: it bundles Zoom In/Out/Reset as a
      // CSS page zoom, which breaks the WebGL-rendered scrollback (canvas
      // vs. CSS-scaled mismatch). These items instead resize the terminal's
      // actual font size, handled renderer-side via "terminal:zoom".
      submenu: [
        { role: "reload", label: "&Reload" },
        { role: "forceReload", label: "&Force Reload" },
        { role: "toggleDevTools", label: "Toggle &Developer Tools" },
        { type: "separator" },
        {
          label: "Zoom &In",
          accelerator: "CmdOrCtrl+=",
          click: () => terminal.send(IpcChannels.terminalZoom, 1),
        },
        {
          label: "Zoom &Out",
          accelerator: "CmdOrCtrl+-",
          click: () => terminal.send(IpcChannels.terminalZoom, -1),
        },
        {
          label: "&Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => terminal.send(IpcChannels.terminalZoom, 0),
        },
        { type: "separator" },
        {
          // Rebound from the terminal convention of Ctrl+Y, which is now
          // the input box's redo shortcut (see renderer.ts).
          label: "&Clear Screen",
          accelerator: "CmdOrCtrl+L",
          registerAccelerator: false,
          click: () => terminal.send(IpcChannels.terminalClearScreenRequested),
        },
        {
          label: "Show &Timestamps",
          type: "checkbox",
          checked: terminal.showTimestamps,
          click: () => {
            terminal.showTimestamps = !terminal.showTimestamps;
            terminal.send(IpcChannels.terminalToggleTimestamps, terminal.showTimestamps);
            // The latest choice becomes the default for windows opened later,
            // in this session or the next.
            prefs.showTimestamps = terminal.showTimestamps;
            writePreferences(prefsPath, prefs);
            buildMenu(terminal); // keep the checkbox in sync with the stored state
          },
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle &Full Screen" },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Check for &Updates…", click: () => void checkForUpdates(terminal.window, true) },
        {
          label: "Check for Updates at &Startup",
          type: "checkbox",
          checked: prefs.checkForUpdates,
          click: () => {
            prefs.checkForUpdates = !prefs.checkForUpdates;
            writePreferences(prefsPath, prefs);
            rebuildAllMenus(); // every window's checkbox shows the one setting
          },
        },
      ],
    },
  ];
  terminal.setMenu(Menu.buildFromTemplate(template));
}

// Every IPC handler below acts on the terminal window the message came from.
function terminalFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): TerminalWindow | undefined {
  const terminal = windowManager.terminalFor(event.sender);
  if (!terminal) log("warn", "main", "IPC from an unknown window, ignoring");
  return terminal;
}

ipcMain.handle(IpcChannels.worldsLoad, (): WorldsLoadResult => {
  const { state, error, recovered } = readWorldsFile(worldsPath);
  if (error) log("error", "worlds", error);
  else log("debug", "worlds", "loaded", state.worlds.length, "world(s) from", worldsPath);
  const warning = recovered
    ? `${recovered.error}. Showing the worlds from its backup, ${path.basename(backupPathFor(worldsPath))}, ` +
      `instead. The next change is saved as ${path.basename(worldsPath)}, and the unreadable file is kept ` +
      `beside it, renamed to ${path.basename(worldsPath)}.unreadable-<date>.`
    : undefined;
  return { worlds: state.worlds, error, warning };
});

ipcMain.handle(IpcChannels.worldsSave, (event, rawWorlds: unknown[]): { error?: string } => {
  const worlds = rawWorlds.map(parseWorld).filter((w): w is World => w !== null);
  try {
    saveWorlds(worldsPath, worlds);
  } catch (err) {
    const error = `Could not save ${worldsPath}: ${(err as Error).message}`;
    log("error", "worlds", error);
    return { error };
  }
  log("debug", "worlds", "saved", worlds.length, "world(s) to", worldsPath);
  for (const terminal of windowManager.all()) {
    if (terminal.window.webContents.id !== event.sender.id) terminal.send(IpcChannels.worldsChanged);
  }
  rebuildAllMenus(); // names may have changed, which affects MRU labels
  return {};
});

// The Worlds dialog's delete confirmations.
ipcMain.handle(IpcChannels.dialogConfirm, (event, message: string, detail?: string): Promise<boolean> => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return confirmAction(sourceWindow, message, "Delete", detail);
});

// Native popup menu for the Worlds dialog. Resolves with the chosen item's
// id, or null.
ipcMain.handle(IpcChannels.menuPopup, (event, items: Array<{ id: string; label: string }>) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return new Promise<string | null>((resolve) => {
    let chosen: string | null = null;
    const menu = Menu.buildFromTemplate(
      items.map(({ id, label }) => ({
        label,
        click: () => {
          chosen = id;
        },
      })),
    );
    // The click handler runs before the close callback.
    menu.popup({ window, callback: () => setImmediate(() => resolve(chosen)) });
  });
});

// The dialog sends its in-memory copy of the world, so edits not yet saved
// still apply; it's validated like a record read from disk.
ipcMain.on(IpcChannels.connectRequest, (event, request: { world: unknown; characterId: string | null }) => {
  const terminal = terminalFor(event);
  const world = parseWorld(request.world);
  if (!terminal || !world) return;
  const character = world.characters.find((c) => c.id === request.characterId) ?? null;
  connectOrNewWindow(terminal, { world, character });
});

ipcMain.on(IpcChannels.telnetInput, (event, text: string) => {
  const terminal = terminalFor(event);
  if (!terminal) return;
  if (!terminal.connection.isConnected()) {
    log("debug", "main", "input while not connected, ignoring:", JSON.stringify(text));
    terminal.writeStatus("\x1b[90m[not connected]\x1b[0m\r\n");
    return;
  }
  // Echoed in cyan to tell typed commands apart from the world's output;
  // not at all while the server has taken over echoing (password prompts), nor
  // for a world set to not echo commands (one that echoes input itself).
  const { echoed } = terminal.connection.sendLine(text);
  const echoCommands = terminal.connection.getConnected()?.world.echoCommands ?? true;
  if (echoed && echoCommands) {
    terminal.writeStatus(`\x1b[36m${text.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
  }
});

ipcMain.on(IpcChannels.telnetResize, (event, { cols, rows }: { cols: number; rows: number }) => {
  log("debug", "main", "terminal resized to", `${cols}x${rows}`);
  terminalFor(event)?.connection.resize(cols, rows);
});

// Keeps the Edit menu's Undo/Redo items' enabled state in sync with the
// renderer's input-undo stack.
ipcMain.on(IpcChannels.terminalUndoStateChanged, (event, canUndo: boolean, canRedo: boolean) => {
  const terminal = terminalFor(event);
  if (!terminal) return;
  if (terminal.setUndoState(canUndo, canRedo)) buildMenu(terminal);
});

ipcMain.handle(
  IpcChannels.terminalGetScrollback,
  (event) => terminalFor(event)?.getScrollback() ?? { chunks: [], times: [], seq: 0 },
);

// A freshly opened (non-cascaded) window's one-shot report of how big its
// content needs to be to show an 80x25 terminal at its starting font.
ipcMain.on(IpcChannels.terminalInitialSize, (event, size: { width: number; height: number }) => {
  windowManager.applyInitialSize(event.sender, size);
});

// The Preferences dialog's changes save and apply immediately: showTimestamps
// is this window's own per-window state (same as the View menu's checkbox),
// while checkForUpdates and the font/size also become the default for new
// windows; the font change additionally re-renders this window's terminal.
ipcMain.handle(IpcChannels.preferencesSave, (event, partial: Partial<Preferences>) => {
  const merged = sanitizePreferences(partial, prefs);
  prefs.showTimestamps = merged.showTimestamps;
  prefs.checkForUpdates = merged.checkForUpdates;
  prefs.fontId = merged.fontId;
  prefs.fontSize = merged.fontSize;
  writePreferences(prefsPath, prefs);
  const terminal = terminalFor(event);
  if (terminal) {
    if (partial.showTimestamps !== undefined) {
      terminal.showTimestamps = prefs.showTimestamps;
      terminal.send(IpcChannels.terminalToggleTimestamps, terminal.showTimestamps);
      buildMenu(terminal); // keep the View menu's checkbox in sync
    }
    if (partial.fontId !== undefined || partial.fontSize !== undefined) {
      terminal.send(IpcChannels.terminalSetFont, { fontFamily: fontFamilyFor(prefs.fontId), fontSize: prefs.fontSize });
    }
  }
});

ipcMain.handle(
  IpcChannels.connectionGetState,
  (event): WindowState =>
    terminalFor(event)?.getState() ?? { status: "disconnected", label: null, address: null, tls: null, logging: false },
);

// The clipboard module is unavailable to the sandboxed preload/renderer
// contexts, so writes/reads are proxied through the main process instead.
ipcMain.on(IpcChannels.clipboardWriteText, (_event, text: string) => clipboard.writeText(text));
ipcMain.handle(IpcChannels.clipboardReadText, (): Promise<string> => clipboard.readText());

// Restricted to http(s) so a malicious server can't trick a click into
// opening e.g. a file:// or custom-protocol URI on the user's machine.
ipcMain.on(IpcChannels.shellOpenExternal, (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.on(IpcChannels.terminalContextMenu, (event, options: { hasSelection: boolean }) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "Cut", enabled: options.hasSelection, click: () => event.sender.send(IpcChannels.terminalCutRequested) },
    { label: "Copy", enabled: options.hasSelection, click: () => event.sender.send(IpcChannels.terminalCopyRequested) },
    { label: "Paste", click: () => event.sender.send(IpcChannels.terminalPasteRequested) },
    { type: "separator" },
    { label: "Select All", click: () => event.sender.send(IpcChannels.terminalSelectAllRequested) },
  ];
  Menu.buildFromTemplate(template).popup({ window });
});

ipcMain.on(IpcChannels.logEmit, (_event, level: Exclude<LogLevel, "none">, scope: string, args: unknown[]) => {
  log(level, scope, ...args);
});

if (isPrimaryInstance) {
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    const otherWorldsPath = (additionalData as { worldsPath?: string } | null)?.worldsPath;
    if (otherWorldsPath && otherWorldsPath !== worldsPath) {
      log("warn", "main", "second launch asked for worlds file", otherWorldsPath, "but this instance uses", worldsPath);
    }
    newTerminalWindow();
  });

  app.whenReady().then(() => {
    log("debug", "main", "app ready");
    newTerminalWindow();

    // Only in packaged builds: running from source shouldn't prompt about
    // releases. Help > Check for Updates works in both.
    if (app.isPackaged && prefs.checkForUpdates) {
      setTimeout(
        () => void checkForUpdates(BrowserWindow.getFocusedWindow() ?? undefined, false),
        UPDATE_CHECK_DELAY_MS,
      );
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) newTerminalWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
