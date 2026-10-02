import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell } from "electron";
import * as path from "path";
import { resolveWorldsPath, loadWorlds, saveWorlds, loadWorldsState, updateMru as updateMruState } from "./worlds";
import { WindowManager } from "./window-manager";
import type { TerminalWindow } from "./terminal-window";
import { configureLogger, getCliLogLevel, log, type LogLevel } from "./logger";
import { IpcChannels } from "./ipc-channels";
import type { World } from "./worlds-types";

function cliArgs(): string[] {
  return app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
}

function getCliWorldsArg(): string | undefined {
  return cliArgs().find((arg) => !arg.startsWith("-"));
}

const logLevel = getCliLogLevel(process.argv);
configureLogger(logLevel);
// Renderer/preload processes are separate OS processes with their own argv
// (Chromium's internal --type=renderer flags, not ours) — hand the level
// down explicitly so preload.ts can compute the same value.
const rendererArgs = [`--log-level=${logLevel}`];

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

const APP_ICON = path.join(__dirname, "..", "icons", "icon-512.png");
const INDEX_HTML = path.join(__dirname, "..", "src", "index.html");
const WORLDS_HTML = path.join(__dirname, "..", "src", "worlds.html");
const PRELOAD_PATH = path.join(__dirname, "preload.js");

const windowManager = new WindowManager(
  { appIcon: APP_ICON, preloadPath: PRELOAD_PATH, rendererArgs, indexHtmlPath: INDEX_HTML },
  {
    onStateChange: (terminal) => buildMenu(terminal),
    onConnected: (worldId) => updateMru(worldId),
  },
);

function newTerminalWindow(near?: TerminalWindow): TerminalWindow {
  const terminal = windowManager.createTerminalWindow(near);
  buildMenu(terminal);
  return terminal;
}

function rebuildAllMenus(): void {
  for (const terminal of windowManager.all()) buildMenu(terminal);
}

function updateMru(id: string): void {
  const updated = updateMruState(worldsPath, (mru) =>
    [id, ...mru.filter((existingId) => existingId !== id)].slice(0, MAX_MRU),
  );
  log("debug", "worlds", "mru updated:", updated);
  rebuildAllMenus();
}

// A window holds at most one connection. Connecting from a window that
// already has one opens the new connection in a window of its own.
function connectOrNewWindow(terminal: TerminalWindow, world: World): void {
  if (terminal.connection.isActive()) {
    newTerminalWindow(terminal).connection.connect(world);
  } else {
    terminal.connection.connect(world);
  }
}

async function confirmAction(
  parentWindow: BrowserWindow | undefined,
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Cancel", confirmLabel],
    defaultId: 0,
    cancelId: 0,
    message,
  };
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);
  const confirmed = result.response === 1;
  log("debug", "main", "confirm dialog:", JSON.stringify(message), "->", confirmed);
  return confirmed;
}

async function confirmDisconnect(terminal: TerminalWindow): Promise<void> {
  const world = terminal.connection.getConnectedWorld();
  if (!world) return;
  const confirmed = await confirmAction(terminal.window, `Disconnect from "${world.name}"?`, "Disconnect");
  if (confirmed) terminal.connection.disconnect();
}

function newWorld(terminal: TerminalWindow): void {
  log("debug", "main", "new world requested");
  // Reuses the dialog's own "Add" logic (create/select/persist/focus) via
  // IPC rather than main owning a duplicate worlds list — the renderer
  // queues this behind its own load if it hasn't finished yet (see
  // worlds-renderer.ts), so this is safe whether the dialog is fresh or
  // already open.
  windowManager.openWorldsWindow(terminal, WORLDS_HTML, () => {
    windowManager.sendToWorlds(terminal, IpcChannels.worldsCreateNew);
  });
}

function openPreferences(terminal: TerminalWindow): void {
  void dialog.showMessageBox(terminal.window, {
    type: "info",
    message: "Preferences",
    detail: "Not yet implemented.",
  });
}

// Each window has its own menu, since Disconnect and the MRU entries act on
// that window's connection.
function buildMenu(terminal: TerminalWindow): void {
  const connected = terminal.connection.getConnectedWorld() !== null;
  log("debug", "main", "rebuilding menu for window", terminal.window.id, "connected =", connected);
  const state = loadWorldsState(worldsPath);
  const mruItems: Electron.MenuItemConstructorOptions[] = state.mru
    .map((id) => state.worlds.find((w) => w.id === id))
    .filter((w): w is World => w !== undefined)
    .slice(0, MAX_MRU)
    .map((world, index) => ({
      label: world.name,
      accelerator: `Ctrl+${index + 1}`,
      click: () => connectOrNewWindow(terminal, world),
    }));

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "&Worlds",
      submenu: [
        { label: "&New World…", accelerator: "Ctrl+N", click: () => newWorld(terminal) },
        {
          label: "&Open World…",
          accelerator: "Ctrl+O",
          click: () => windowManager.openWorldsWindow(terminal, WORLDS_HTML),
        },
        {
          label: "&Disconnect",
          accelerator: "Ctrl+K",
          enabled: connected,
          click: () => void confirmDisconnect(terminal),
        },
        {
          label: "Close &Window",
          accelerator: "Ctrl+W",
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
      // Not the built-in "editMenu" role: its Copy/Paste/Select All rely on
      // Chromium's native edit commands against the focused DOM selection,
      // which don't reliably reach into xterm.js's canvas/WebGL-rendered
      // selection. These items carry no accelerator so Ctrl+C/V stay owned
      // by the renderer's own keydown handling (see renderer.ts), and just
      // forward here for menu-bar/discoverability use.
      label: "&Edit",
      submenu: [
        { label: "&Copy", click: () => terminal.send(IpcChannels.terminalCopyRequested) },
        { label: "&Paste", click: () => terminal.send(IpcChannels.terminalPasteRequested) },
        { type: "separator" },
        { label: "Select &All", click: () => terminal.send(IpcChannels.terminalSelectAllRequested) },
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
        { role: "togglefullscreen", label: "Toggle &Full Screen" },
      ],
    },
  ];
  terminal.setMenu(Menu.buildFromTemplate(template));
}

// Every IPC handler below acts on the terminal window the message came from
// (or whose Worlds dialog it came from).
function terminalFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): TerminalWindow | undefined {
  const terminal = windowManager.terminalFor(event.sender);
  if (!terminal) log("warn", "main", "IPC from an unknown window, ignoring");
  return terminal;
}

ipcMain.handle(IpcChannels.worldsLoad, (): World[] => {
  const worlds = loadWorlds(worldsPath);
  log("debug", "worlds", "loaded", worlds.length, "world(s) from", worldsPath);
  return worlds;
});

ipcMain.handle(IpcChannels.worldsSave, (_event, worlds: World[]): void => {
  saveWorlds(worldsPath, worlds);
  log("debug", "worlds", "saved", worlds.length, "world(s) to", worldsPath);
  rebuildAllMenus(); // world names may have changed, which affects MRU labels
});

ipcMain.handle(IpcChannels.dialogConfirm, (event, message: string): Promise<boolean> => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return confirmAction(sourceWindow, message, "Delete");
});

ipcMain.handle(IpcChannels.connectRequest, (event, world: World): void => {
  const terminal = terminalFor(event);
  if (!terminal) return;
  BrowserWindow.fromWebContents(event.sender)?.close();
  terminal.window.focus();
  connectOrNewWindow(terminal, world);
});

ipcMain.on(IpcChannels.telnetInput, (event, text: string) => {
  const terminal = terminalFor(event);
  if (!terminal) return;
  if (!terminal.connection.isConnected()) {
    log("debug", "main", "input while not connected, ignoring:", JSON.stringify(text));
    terminal.write("\x1b[90m[not connected]\x1b[0m\r\n");
    return;
  }
  const { echoed } = terminal.connection.sendLine(text);
  if (echoed) {
    terminal.write(text.replace(/\n/g, "\r\n") + "\r\n");
  }
});

ipcMain.on(IpcChannels.telnetResize, (event, { cols, rows }: { cols: number; rows: number }) => {
  log("debug", "main", "terminal resized to", `${cols}x${rows}`);
  terminalFor(event)?.connection.resize(cols, rows);
});

ipcMain.handle(IpcChannels.terminalGetScrollback, (event) => terminalFor(event)?.getScrollback() ?? []);

ipcMain.handle(IpcChannels.connectionGetState, (event): { secure: boolean } => ({
  secure: terminalFor(event)?.connection.isSecure() ?? false,
}));

// The clipboard module is unavailable to the sandboxed preload/renderer
// contexts, so writes/reads are proxied through the main process instead.
ipcMain.on(IpcChannels.clipboardWriteText, (_event, text: string) => clipboard.writeText(text));
ipcMain.handle(IpcChannels.clipboardReadText, (): string => clipboard.readText());

// Restricted to http(s) so a malicious server can't trick a click into
// opening e.g. a file:// or custom-protocol URI on the user's machine.
ipcMain.on(IpcChannels.shellOpenExternal, (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.on(IpcChannels.terminalContextMenu, (event, options: { hasSelection: boolean }) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const template: Electron.MenuItemConstructorOptions[] = [
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

function greet(terminal: TerminalWindow): void {
  terminal.write("\x1b[36mmoolin — press Ctrl+O to open Worlds and connect.\x1b[0m\r\n");
}

if (isPrimaryInstance) {
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    const otherWorldsPath = (additionalData as { worldsPath?: string } | null)?.worldsPath;
    if (otherWorldsPath && otherWorldsPath !== worldsPath) {
      log("warn", "main", "second launch asked for worlds file", otherWorldsPath, "but this instance uses", worldsPath);
    }
    greet(newTerminalWindow());
  });

  app.whenReady().then(() => {
    log("debug", "main", "app ready");
    greet(newTerminalWindow());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) greet(newTerminalWindow());
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
