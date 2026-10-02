import { app, BrowserWindow, Menu, ipcMain, dialog, screen, clipboard, shell } from "electron";
import * as path from "path";
import { spawn } from "child_process";
import { resolveWorldsPath, loadWorlds, saveWorlds, loadWorldsState, loadMru, saveMru } from "./worlds";
import { TelnetSession, type TlsInfo } from "./telnet";
import { configureLogger, getCliLogLevel, log, type LogLevel } from "./logger";
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
  if (connectedWorld) {
    spawnInstanceForWorld(world);
  } else {
    startConnection(world);
  }
}

const MAX_MRU = 5;

let mainWindow: BrowserWindow | null = null;
let worldsWindow: BrowserWindow | null = null;
let connectedWorld: World | null = null;
let connectedSecure = false;

function broadcastConnectionState(): void {
  mainWindow?.webContents.send("connection:state", { secure: connectedSecure });
}
let session: TelnetSession | null = null;

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

const APP_ICON = path.join(__dirname, "..", "icons", "icon-512.png");

function createWindow(): void {
  log("debug", "main", "creating main window");
  const width = 1000;
  const height = 700;
  const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  mainWindow = new BrowserWindow({
    width,
    height,
    ...centeredOn(targetDisplay, width, height),
    icon: APP_ICON,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: rendererArgs,
    },
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    log("debug", "main-console", `level=${level} ${sourceId}:${line} ${message}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    log("error", "main", "did-fail-load", code, desc, url);
  });
  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
}

function openWorldsWindow(onReady?: () => void): void {
  if (worldsWindow) {
    log("debug", "main", "worlds window already open, focusing");
    worldsWindow.focus();
    onReady?.();
    return;
  }

  log("debug", "main", "opening worlds window");
  const width = 640;
  const height = 420;
  const targetDisplay = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  worldsWindow = new BrowserWindow({
    width,
    height,
    ...centeredOn(targetDisplay, width, height),
    icon: APP_ICON,
    parent: mainWindow ?? undefined,
    modal: true,
    frame: false, // Linux WMs don't reliably honor minimizable/maximizable hints; drop the frame instead
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: rendererArgs,
    },
  });
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
  worldsWindow.loadFile(path.join(__dirname, "..", "src", "worlds.html"));
  worldsWindow.on("closed", () => {
    log("debug", "main", "worlds window closed");
    worldsWindow = null;
  });
}

function newWorld(): void {
  log("debug", "main", "new world requested");
  // Reuses the dialog's own "Add" logic (create/select/persist/focus) via
  // IPC rather than main owning a duplicate worlds list — the renderer
  // queues this behind its own load if it hasn't finished yet (see
  // worlds-renderer.ts), so this is safe whether the dialog is fresh or
  // already open.
  openWorldsWindow(() => {
    worldsWindow?.webContents.send("worlds:createNew");
  });
}

function openPreferences(): void {
  const options: Electron.MessageBoxOptions = {
    type: "info",
    message: "Preferences",
    detail: "Not yet implemented.",
  };
  void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
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
  mainWindow?.webContents.send("telnet:data", data);
}

function updateMru(id: string): void {
  const mru = loadMru(worldsPath);
  const updated = [id, ...mru.filter((existingId) => existingId !== id)].slice(0, MAX_MRU);
  saveMru(worldsPath, updated);
  log("debug", "worlds", "mru updated:", updated);
}

function startConnection(world: World): void {
  session?.disconnect();
  log("info", "telnet", "connecting to", `${world.host}:${world.port}`, `(${world.name})`);
  sendToTerminal(`\x1b[33m[connecting to ${world.name} (${world.host}:${world.port})...]\x1b[0m\r\n`);

  session = new TelnetSession(
    {
      onConnect: (secure) => {
        log("info", "telnet", "connected to", world.name, secure ? "(TLS)" : "(plaintext)");
        connectedWorld = world;
        connectedSecure = secure;
        updateMru(world.id);
        buildMenu();
        broadcastConnectionState();
        sendToTerminal(`\x1b[32m[connected to ${world.name}${secure ? ", securely (TLS)" : ""}]\x1b[0m\r\n`);
      },
      onData: (data) => {
        sendToTerminal(data);
      },
      onDisconnect: (reason) => {
        log(reason ? "error" : "info", "telnet", reason ? `connection error: ${reason}` : "disconnected");
        session = null;
        connectedWorld = null;
        connectedSecure = false;
        buildMenu();
        broadcastConnectionState();
        sendToTerminal(
          reason ? `\x1b[31m[connection error: ${reason}]\x1b[0m\r\n` : "\x1b[33m[disconnected]\x1b[0m\r\n",
        );
      },
      onTlsProbeResult: (secure, info?: TlsInfo) => {
        if (!secure || !info) {
          sendToTerminal("\x1b[33m[TLS not available, falling back to plaintext]\x1b[0m\r\n");
          return;
        }
        sendToTerminal(`\x1b[32m[TLS available, connecting securely: ${info.protocol}, ${info.cipherName}]\x1b[0m\r\n`);
        sendToTerminal(
          `\x1b[32m[cert: ${info.certSubject} issued by ${info.certIssuer}, valid ${info.certValidFrom} to ${info.certValidTo}]\x1b[0m\r\n`,
        );
        if (!info.certValid) {
          sendToTerminal(`\x1b[31m[warning: certificate is not valid: ${info.certValidationError}]\x1b[0m\r\n`);
        }
      },
    },
    (level, ...args) => log(level, "telnet", ...args),
  );
  session.connect(world);
}

async function confirmDisconnect(): Promise<void> {
  if (!connectedWorld) return;
  const confirmed = await confirmAction(
    mainWindow ?? undefined,
    `Disconnect from "${connectedWorld.name}"?`,
    "Disconnect",
  );
  if (confirmed) session?.disconnect();
}

function buildMenu(): void {
  log("debug", "main", "rebuilding menu, connected =", connectedWorld !== null);
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
        { label: "&Open World…", accelerator: "Ctrl+O", click: () => openWorldsWindow() },
        {
          label: "&Disconnect",
          accelerator: "Ctrl+K",
          enabled: connectedWorld !== null,
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
        { label: "&Copy", click: () => mainWindow?.webContents.send("terminal:copyRequested") },
        { label: "&Paste", click: () => mainWindow?.webContents.send("terminal:pasteRequested") },
        { type: "separator" },
        { label: "Select &All", click: () => mainWindow?.webContents.send("terminal:selectAllRequested") },
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
          click: () => mainWindow?.webContents.send("terminal:zoom", 1),
        },
        {
          label: "Zoom &Out",
          accelerator: "CmdOrCtrl+-",
          click: () => mainWindow?.webContents.send("terminal:zoom", -1),
        },
        {
          label: "&Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => mainWindow?.webContents.send("terminal:zoom", 0),
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle &Full Screen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("worlds:load", (): World[] => {
  const worlds = loadWorlds(worldsPath);
  log("debug", "worlds", "loaded", worlds.length, "world(s) from", worldsPath);
  return worlds;
});

ipcMain.handle("worlds:save", (_event, worlds: World[]): void => {
  saveWorlds(worldsPath, worlds);
  log("debug", "worlds", "saved", worlds.length, "world(s) to", worldsPath);
  buildMenu(); // world names may have changed, which affects MRU labels
});

ipcMain.handle("dialog:confirm", (event, message: string): Promise<boolean> => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return confirmAction(sourceWindow, message, "Delete");
});

ipcMain.handle("connect:request", (event, world: World): void => {
  BrowserWindow.fromWebContents(event.sender)?.close();
  mainWindow?.focus();
  connectOrSpawn(world);
});

ipcMain.on("telnet:input", (_event, text: string) => {
  if (!session?.isConnected()) {
    log("debug", "main", "input while not connected, ignoring:", JSON.stringify(text));
    sendToTerminal("\x1b[90m[not connected]\x1b[0m\r\n");
    return;
  }
  const { echoed } = session.sendLine(text);
  if (echoed) {
    sendToTerminal(text.replace(/\n/g, "\r\n") + "\r\n");
  }
});

ipcMain.on("telnet:resize", (_event, { cols, rows }: { cols: number; rows: number }) => {
  log("debug", "main", "terminal resized to", `${cols}x${rows}`);
  session?.resize(cols, rows);
});

ipcMain.handle("terminal:getScrollback", (): Array<string | Uint8Array> => scrollbackBuffer.slice());

ipcMain.handle("connection:getState", (): { secure: boolean } => ({ secure: connectedSecure }));

// The clipboard module is unavailable to the sandboxed preload/renderer
// contexts, so writes/reads are proxied through the main process instead.
ipcMain.on("clipboard:writeText", (_event, text: string) => clipboard.writeText(text));
ipcMain.handle("clipboard:readText", (): string => clipboard.readText());

// Restricted to http(s) so a malicious server can't trick a click into
// opening e.g. a file:// or custom-protocol URI on the user's machine.
ipcMain.on("shell:openExternal", (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.on("terminal:contextMenu", (event, options: { hasSelection: boolean }) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "Copy", enabled: options.hasSelection, click: () => event.sender.send("terminal:copyRequested") },
    { label: "Paste", click: () => event.sender.send("terminal:pasteRequested") },
    { type: "separator" },
    { label: "Select All", click: () => event.sender.send("terminal:selectAllRequested") },
  ];
  Menu.buildFromTemplate(template).popup({ window });
});

ipcMain.on("log:emit", (_event, level: Exclude<LogLevel, "none">, scope: string, args: unknown[]) => {
  log(level, scope, ...args);
});

app.whenReady().then(() => {
  log("debug", "main", "app ready");
  buildMenu();
  createWindow();

  // Spawned instances (see spawnInstanceForWorld) connect straight to their
  // assigned world instead of showing the idle prompt.
  const targetWorld = connectWorldId ? loadWorlds(worldsPath).find((w) => w.id === connectWorldId) : undefined;
  if (connectWorldId && !targetWorld) {
    log("error", "main", "spawned with unknown world id", connectWorldId);
  }
  if (targetWorld) {
    startConnection(targetWorld);
  } else {
    sendToTerminal("\x1b[36mmoolin — press Ctrl+O to open Worlds and connect.\x1b[0m\r\n");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
