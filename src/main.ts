import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell } from "electron";
import * as path from "path";
import { spawn } from "child_process";
import { resolveWorldsPath, loadWorlds, saveWorlds, loadWorldsState, updateMru as updateMruState } from "./worlds";
import { ConnectionManager } from "./connection-manager";
import { WindowManager } from "./window-manager";
import { configureLogger, getCliLogLevel, log, type LogLevel } from "./logger";
import { IpcChannels } from "./ipc-channels";
import type { World } from "./worlds-types";

function cliArgs(): string[] {
  return app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
}

function getCliWorldsArg(): string | undefined {
  return cliArgs().find((arg) => !arg.startsWith("-"));
}

const CONNECT_FLAG_PREFIX = "--connect=";

function getCliConnectWorldId(): string | undefined {
  const flag = cliArgs().find((arg) => arg.startsWith(CONNECT_FLAG_PREFIX));
  return flag?.slice(CONNECT_FLAG_PREFIX.length);
}

const logLevel = getCliLogLevel(process.argv);
configureLogger(logLevel);
// Renderer/preload processes are separate OS processes with their own argv
// (Chromium's internal --type=renderer flags, not ours) — hand the level
// down explicitly so preload.ts can compute the same value.
const rendererArgs = [`--log-level=${logLevel}`];

const cliWorldsArg = getCliWorldsArg();
const worldsPath = resolveWorldsPath(cliWorldsArg);
const connectWorldId = getCliConnectWorldId();
log("info", "main", "starting, worldsPath =", worldsPath);

// Opening a second world while one is already connected spawns a whole new
// app instance (rather than a second window/session inside this process) —
// simplest way to give each world its own independent connection without a
// multi-window rearchitecture. The child re-resolves the same worlds file
// and connects directly to `world` on startup via --connect=<id>.
function spawnInstanceForWorld(world: World): void {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (cliWorldsArg) args.push(cliWorldsArg);
  args.push(`${CONNECT_FLAG_PREFIX}${world.id}`, `--log-level=${logLevel}`);
  log("debug", "main", "spawning new instance for world", world.id, "argv:", args);
  // `inherit` (rather than `ignore`) so --log-level actually reaches a
  // terminal when debugging a spawned instance; `detached` already keeps it
  // out of this process's group, so it won't die with us either way.
  spawn(process.execPath, args, { detached: true, stdio: "inherit" }).unref();
}

function connectOrSpawn(world: World): void {
  if (connectionManager.getConnectedWorld()) {
    spawnInstanceForWorld(world);
  } else {
    connectionManager.connect(world);
  }
}

const MAX_MRU = 5;

const APP_ICON = path.join(__dirname, "..", "icons", "icon-512.png");
const INDEX_HTML = path.join(__dirname, "..", "src", "index.html");
const WORLDS_HTML = path.join(__dirname, "..", "src", "worlds.html");
const PRELOAD_PATH = path.join(__dirname, "preload.js");

const windowManager = new WindowManager(APP_ICON, PRELOAD_PATH, rendererArgs);

function updateMru(id: string): void {
  const updated = updateMruState(worldsPath, (mru) =>
    [id, ...mru.filter((existingId) => existingId !== id)].slice(0, MAX_MRU),
  );
  log("debug", "worlds", "mru updated:", updated);
}

// In-memory replay buffer so the scrollback survives a renderer reload/crash.
// Disk logging is a separate, opt-in feature — this is not persisted.
const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const scrollbackBuffer: Array<string | Uint8Array> = [];
let scrollbackBytes = 0;

function byteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
}

function sendToTerminal(data: string | Uint8Array): void {
  scrollbackBuffer.push(data);
  scrollbackBytes += byteLength(data);
  while (scrollbackBytes > MAX_SCROLLBACK_BYTES && scrollbackBuffer.length > 0) {
    scrollbackBytes -= byteLength(scrollbackBuffer.shift() as string | Uint8Array);
  }
  windowManager.send(IpcChannels.telnetData, data);
}

function broadcastConnectionState(): void {
  windowManager.send(IpcChannels.connectionState, { secure: connectionManager.isSecure() });
}

const connectionManager = new ConnectionManager(
  {
    onStateChange: () => {
      buildMenu();
      broadcastConnectionState();
    },
    onMessage: (text) => sendToTerminal(text),
    onData: (data) => sendToTerminal(data),
    onConnected: (worldId) => updateMru(worldId),
  },
  (level, ...args) => log(level, "telnet", ...args),
);

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

async function confirmDisconnect(): Promise<void> {
  const world = connectionManager.getConnectedWorld();
  if (!world) return;
  const confirmed = await confirmAction(windowManager.main ?? undefined, `Disconnect from "${world.name}"?`, "Disconnect");
  if (confirmed) connectionManager.disconnect();
}

function newWorld(): void {
  log("debug", "main", "new world requested");
  // Reuses the dialog's own "Add" logic (create/select/persist/focus) via
  // IPC rather than main owning a duplicate worlds list — the renderer
  // queues this behind its own load if it hasn't finished yet (see
  // worlds-renderer.ts), so this is safe whether the dialog is fresh or
  // already open.
  windowManager.openWorldsWindow(WORLDS_HTML, () => {
    windowManager.sendToWorlds(IpcChannels.worldsCreateNew);
  });
}

function openPreferences(): void {
  const options: Electron.MessageBoxOptions = {
    type: "info",
    message: "Preferences",
    detail: "Not yet implemented.",
  };
  void (windowManager.main ? dialog.showMessageBox(windowManager.main, options) : dialog.showMessageBox(options));
}

function buildMenu(): void {
  const connected = connectionManager.getConnectedWorld() !== null;
  log("debug", "main", "rebuilding menu, connected =", connected);
  const state = loadWorldsState(worldsPath);
  const mruItems: Electron.MenuItemConstructorOptions[] = state.mru
    .map((id) => state.worlds.find((w) => w.id === id))
    .filter((w): w is World => w !== undefined)
    .slice(0, MAX_MRU)
    .map((world, index) => ({
      label: world.name,
      accelerator: `Ctrl+${index + 1}`,
      click: () => connectOrSpawn(world),
    }));

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "&Worlds",
      submenu: [
        { label: "&New World…", accelerator: "Ctrl+N", click: () => newWorld() },
        { label: "&Open World…", accelerator: "Ctrl+O", click: () => windowManager.openWorldsWindow(WORLDS_HTML) },
        {
          label: "&Disconnect",
          accelerator: "Ctrl+K",
          enabled: connected,
          click: () => void confirmDisconnect(),
        },
        {
          label: "Close &Window",
          accelerator: "Ctrl+W",
          click: (_item, window) => window?.close(),
        },
        ...(mruItems.length > 0 ? ([{ type: "separator" }, ...mruItems] as Electron.MenuItemConstructorOptions[]) : []),
        { type: "separator" },
        { label: "&Preferences…", click: () => openPreferences() },
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
        { label: "&Copy", click: () => windowManager.send(IpcChannels.terminalCopyRequested) },
        { label: "&Paste", click: () => windowManager.send(IpcChannels.terminalPasteRequested) },
        { type: "separator" },
        { label: "Select &All", click: () => windowManager.send(IpcChannels.terminalSelectAllRequested) },
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
          click: () => windowManager.send(IpcChannels.terminalZoom, 1),
        },
        {
          label: "Zoom &Out",
          accelerator: "CmdOrCtrl+-",
          click: () => windowManager.send(IpcChannels.terminalZoom, -1),
        },
        {
          label: "&Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => windowManager.send(IpcChannels.terminalZoom, 0),
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle &Full Screen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle(IpcChannels.worldsLoad, (): World[] => {
  const worlds = loadWorlds(worldsPath);
  log("debug", "worlds", "loaded", worlds.length, "world(s) from", worldsPath);
  return worlds;
});

ipcMain.handle(IpcChannels.worldsSave, (_event, worlds: World[]): void => {
  saveWorlds(worldsPath, worlds);
  log("debug", "worlds", "saved", worlds.length, "world(s) to", worldsPath);
  buildMenu(); // world names may have changed, which affects MRU labels
});

ipcMain.handle(IpcChannels.dialogConfirm, (event, message: string): Promise<boolean> => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return confirmAction(sourceWindow, message, "Delete");
});

ipcMain.handle(IpcChannels.connectRequest, (event, world: World): void => {
  BrowserWindow.fromWebContents(event.sender)?.close();
  windowManager.main?.focus();
  connectOrSpawn(world);
});

ipcMain.on(IpcChannels.telnetInput, (_event, text: string) => {
  if (!connectionManager.isConnected()) {
    log("debug", "main", "input while not connected, ignoring:", JSON.stringify(text));
    sendToTerminal("\x1b[90m[not connected]\x1b[0m\r\n");
    return;
  }
  const { echoed } = connectionManager.sendLine(text);
  if (echoed) {
    sendToTerminal(text.replace(/\n/g, "\r\n") + "\r\n");
  }
});

ipcMain.on(IpcChannels.telnetResize, (_event, { cols, rows }: { cols: number; rows: number }) => {
  log("debug", "main", "terminal resized to", `${cols}x${rows}`);
  connectionManager.resize(cols, rows);
});

ipcMain.handle(IpcChannels.terminalGetScrollback, (): Array<string | Uint8Array> => scrollbackBuffer.slice());

ipcMain.handle(IpcChannels.connectionGetState, (): { secure: boolean } => ({ secure: connectionManager.isSecure() }));

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

app.whenReady().then(() => {
  log("debug", "main", "app ready");
  buildMenu();
  windowManager.createMainWindow(INDEX_HTML);

  // Spawned instances (see spawnInstanceForWorld) connect straight to their
  // assigned world instead of showing the idle prompt.
  const targetWorld = connectWorldId ? loadWorlds(worldsPath).find((w) => w.id === connectWorldId) : undefined;
  if (connectWorldId && !targetWorld) {
    log("error", "main", "spawned with unknown world id", connectWorldId);
  }
  if (targetWorld) {
    connectionManager.connect(targetWorld);
  } else {
    sendToTerminal("\x1b[36mmoolin — press Ctrl+O to open Worlds and connect.\x1b[0m\r\n");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) windowManager.createMainWindow(INDEX_HTML);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
