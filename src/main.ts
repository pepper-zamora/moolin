import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, net, powerMonitor, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  backupPathFor,
  parseGlobalSettings,
  parseWorld,
  readWorldsFile,
  resolveWorldsPath,
  saveWorlds,
  seedDefaultWorlds,
  updateMru as updateMruState,
} from "./worlds";
import { WindowManager } from "./window-manager";
import type { TerminalWindow } from "./terminal-window";
import { configureLogger, getCliLogLevel, log } from "./logger";
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
import { DEFAULT_GLOBAL_SETTINGS, resolveTriState, targetLabel } from "./world-utils";
import type { ResolvedSettings, WindowState } from "./connection-manager";
import { checkForUpdate } from "./update-check";
import { fontFamilyFor } from "./fonts";
import {
  parseBooleanPair,
  parseClipboardText,
  parseConfirmText,
  parseConnectRequest,
  parseContextMenuOptions,
  parseExternalUrl,
  parseInitialSize,
  parseInputText,
  parseLogCall,
  parseMenuItems,
  parseSize,
} from "./ipc-validate";

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
  // A first-ever launch gets LambdaMOO and its Guest character already set
  // up, rather than an empty Worlds dialog with nothing to click. Written
  // once, immediately, rather than left to a read-time fallback, so the ids
  // it hands out are stable from the very first read (the Worlds dialog's
  // load, an early connect's MRU update, ...).
  if (!fs.existsSync(worldsPath)) {
    try {
      saveWorlds(worldsPath, seedDefaultWorlds());
      log("info", "main", "seeded the default world (LambdaMOO) at", worldsPath);
    } catch (err) {
      log("warn", "main", "could not seed the default world:", (err as Error).message);
    }
  }
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

// Resolves Global/World/Character into what this connection actually uses,
// snapshotted once at connect time (see ConnectionManager.connect).
function resolveConnectionSettings(target: ConnectTarget): ResolvedSettings {
  const { state } = readWorldsFile(worldsPath);
  return {
    wordWrap: resolveTriState(
      state.globalSettings.wordWrap,
      target.character?.wordWrap ?? "inherit",
      target.world.wordWrap,
    ),
    echoCommands: resolveTriState(
      state.globalSettings.echoCommands,
      target.character?.echoCommands ?? "inherit",
      target.world.echoCommands,
    ),
  };
}

// A window holds at most one connection. Connecting from a window that
// already has one opens the new connection in a window of its own.
function connectOrNewWindow(terminal: TerminalWindow, target: ConnectTarget): void {
  const resolved = resolveConnectionSettings(target);
  if (terminal.connection.isActive()) {
    newTerminalWindow(terminal).connection.connect(target, resolved);
  } else {
    terminal.connection.connect(target, resolved);
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
        { label: "&Preferences…", accelerator: "CmdOrCtrl+,", click: () => openPreferences(terminal) },
        { type: "separator" },
        { role: "quit", label: "&Quit" },
      ],
    },
    {
      // Not the built-in "editMenu" role: its items rely on Chromium's
      // native edit commands against the focused DOM selection, which is
      // usually in the input area rather than the scrollback (so Cut/Copy/Paste
      // would miss a scrollback selection), and whose native undo stack is
      // unusable here anyway (see input-undo.ts). Every item below carries a display-only
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
      // CSS page zoom, which would scale the scrollbar and leave the columns
      // and rows the server was told out of step with what is shown. These
      // items instead resize the terminal's actual font size, handled
      // renderer-side via "terminal:zoom".
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
        // Shows twice on macOS Tahoe — one row with fn+F, one with
        // Ctrl+Cmd+F. That's an open Electron bug, not ours: AppKit injects
        // its own hidden duplicate for this role, carrying the system
        // shortcut, and Electron then makes every item visible, exposing it
        // (electron/electron#52821, fix PR #53137 still unmerged). Leave it
        // as-is until that lands — every app-side workaround tried costs the
        // working fn+F shortcut; see TODO.md for the full matrix.
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

// Every IPC handler below acts on the terminal window the message came from,
// and only for a message from that window's own page: not from a frame inside
// it, nor from a window that isn't one of ours. What the page sends is checked
// before it is used (see ipc-validate.ts), since the page displays whatever
// servers send.
function terminalFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): TerminalWindow | undefined {
  const terminal = windowManager.terminalFor(event.sender);
  if (!terminal || event.senderFrame !== event.sender.mainFrame) {
    log("warn", "main", "IPC from an unknown window or frame, ignoring");
    return undefined;
  }
  return terminal;
}

function ignoreBad(channel: string, value: unknown): void {
  log("warn", "main", `ignoring a malformed ${channel} message:`, JSON.stringify(value)?.slice(0, 200));
}

ipcMain.handle(IpcChannels.worldsLoad, (event): WorldsLoadResult => {
  if (!terminalFor(event)) {
    return { worlds: [], globalSettings: DEFAULT_GLOBAL_SETTINGS, error: "Not a Moolin window" };
  }
  const { state, error, recovered } = readWorldsFile(worldsPath);
  if (error) log("error", "worlds", error);
  else log("debug", "worlds", "loaded", state.worlds.length, "world(s) from", worldsPath);
  const warning = recovered
    ? `${recovered.error}. Showing the worlds from its backup, ${path.basename(backupPathFor(worldsPath))}, ` +
      `instead. The next change is saved as ${path.basename(worldsPath)}, and the unreadable file is kept ` +
      `beside it, renamed to ${path.basename(worldsPath)}.unreadable-<date>.`
    : undefined;
  return { worlds: state.worlds, globalSettings: state.globalSettings, error, warning };
});

ipcMain.handle(IpcChannels.worldsSave, (event, rawWorlds: unknown, rawGlobalSettings: unknown): { error?: string } => {
  if (!terminalFor(event)) return { error: "Not a Moolin window" };
  if (!Array.isArray(rawWorlds)) {
    ignoreBad(IpcChannels.worldsSave, rawWorlds);
    return { error: "Could not save: the worlds list was malformed" };
  }
  const worlds = rawWorlds.map(parseWorld).filter((w): w is World => w !== null);
  if (worlds.length !== rawWorlds.length) {
    log("warn", "worlds", `dropping ${rawWorlds.length - worlds.length} malformed world(s) from a save request`);
  }
  const globalSettings = parseGlobalSettings(rawGlobalSettings);
  try {
    saveWorlds(worldsPath, worlds, globalSettings);
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
ipcMain.handle(IpcChannels.dialogConfirm, (event, message: unknown, detail?: unknown): Promise<boolean> => {
  const text = parseConfirmText(message, detail);
  if (!terminalFor(event) || !text) return Promise.resolve(false);
  const sourceWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return confirmAction(sourceWindow, text.message, "Delete", text.detail);
});

// Native popup menu for the Worlds dialog. Resolves with the chosen item's
// id, or null.
ipcMain.handle(IpcChannels.menuPopup, (event, rawItems: unknown) => {
  const items = parseMenuItems(rawItems);
  if (!terminalFor(event) || !items) return Promise.resolve(null);
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
ipcMain.on(IpcChannels.connectRequest, (event, rawRequest: unknown) => {
  const terminal = terminalFor(event);
  const request = parseConnectRequest(rawRequest);
  if (!request) return ignoreBad(IpcChannels.connectRequest, rawRequest);
  const world = parseWorld(request.world);
  if (!terminal || !world) return;
  const character = world.characters.find((c) => c.id === request.characterId) ?? null;
  connectOrNewWindow(terminal, { world, character });
});

ipcMain.on(IpcChannels.telnetInput, (event, rawText: unknown) => {
  const terminal = terminalFor(event);
  const text = parseInputText(rawText);
  if (!terminal) return;
  if (text === null) return ignoreBad(IpcChannels.telnetInput, typeof rawText);
  if (!terminal.connection.isConnected()) {
    log("debug", "main", "input while not connected, ignoring:", JSON.stringify(text));
    terminal.writeStatus("\x1b[90m[not connected]\x1b[0m\r\n");
    return;
  }
  // Echoed in cyan to tell typed commands apart from the world's output;
  // not at all while the server has taken over echoing (password prompts), nor
  // for a world set to not echo commands (one that echoes input itself).
  const { echoed } = terminal.connection.sendLine(text);
  if (echoed && terminal.connection.echoCommandsEnabled()) {
    terminal.writeStatus(`\x1b[36m${text.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
  }
});

ipcMain.on(IpcChannels.telnetResize, (event, rawSize: unknown) => {
  const size = parseSize(rawSize);
  if (!size) return ignoreBad(IpcChannels.telnetResize, rawSize);
  log("debug", "main", "terminal resized to", `${size.cols}x${size.rows}`);
  terminalFor(event)?.connection.resize(size.cols, size.rows);
});

// Keeps the Edit menu's Undo/Redo items' enabled state in sync with the
// renderer's input-undo stack.
ipcMain.on(IpcChannels.terminalUndoStateChanged, (event, rawCanUndo: unknown, rawCanRedo: unknown) => {
  const terminal = terminalFor(event);
  const state = parseBooleanPair(rawCanUndo, rawCanRedo);
  if (!terminal || !state) return;
  if (terminal.setUndoState(state[0], state[1])) buildMenu(terminal);
});

ipcMain.handle(
  IpcChannels.terminalGetScrollback,
  (event) =>
    terminalFor(event)?.getScrollback() ?? { chunks: [], times: [], seq: 0, pueblo: false, greetingOpen: false },
);

// A freshly opened (non-cascaded) window's one-shot report of how big its
// content needs to be to show an 80x25 terminal at its starting font.
ipcMain.on(IpcChannels.terminalInitialSize, (event, rawSize: unknown) => {
  const size = parseInitialSize(rawSize);
  if (!terminalFor(event) || !size) return;
  windowManager.applyInitialSize(event.sender, size);
});

// The Preferences dialog's changes save and apply immediately: showTimestamps
// is this window's own per-window state (same as the View menu's checkbox),
// while checkForUpdates and the font/size also become the default for new
// windows; the font change additionally re-renders this window's terminal.
ipcMain.handle(IpcChannels.preferencesSave, (event, rawPartial: unknown) => {
  if (!terminalFor(event)) return;
  if (typeof rawPartial !== "object" || rawPartial === null) return ignoreBad(IpcChannels.preferencesSave, rawPartial);
  const partial = rawPartial as Partial<Preferences>;
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
    terminalFor(event)?.getState() ?? {
      status: "disconnected",
      label: null,
      address: null,
      tls: null,
      wordWrap: false,
      logging: false,
    },
);

// The clipboard module is unavailable to the sandboxed preload/renderer
// contexts, so writes/reads are proxied through the main process instead.
ipcMain.on(IpcChannels.clipboardWriteText, (event, rawText: unknown) => {
  const text = parseClipboardText(rawText);
  if (terminalFor(event) && text !== null) clipboard.writeText(text);
});
ipcMain.handle(
  IpcChannels.clipboardReadText,
  async (event): Promise<string> => (terminalFor(event) ? await clipboard.readText() : ""),
);

// Restricted to http(s) so a malicious server can't trick a click into
// opening e.g. a file:// or custom-protocol URI on the user's machine.
ipcMain.on(IpcChannels.shellOpenExternal, (event, rawUrl: unknown) => {
  const url = parseExternalUrl(rawUrl);
  if (terminalFor(event) && url) void shell.openExternal(url);
});

ipcMain.on(IpcChannels.terminalContextMenu, (event, rawOptions: unknown) => {
  const options = parseContextMenuOptions(rawOptions);
  if (!terminalFor(event) || !options) return;
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "Cut", enabled: options.hasSelection, click: () => event.sender.send(IpcChannels.terminalCutRequested) },
    {
      label: "Copy",
      enabled: options.hasSelection,
      click: () => event.sender.send(IpcChannels.terminalCopyRequested),
    },
    { label: "Paste", click: () => event.sender.send(IpcChannels.terminalPasteRequested) },
    { type: "separator" },
    {
      label: "Select All",
      click: () => event.sender.send(IpcChannels.terminalSelectAllRequested, options.selectAllTarget),
    },
  ];
  Menu.buildFromTemplate(template).popup({ window });
});

ipcMain.on(IpcChannels.logEmit, (event, level: unknown, scope: unknown, args: unknown) => {
  const call = parseLogCall(level, scope, args);
  if (terminalFor(event) && call) log(call.level, call.scope, ...call.args);
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

    // A sleeping computer cuts every connection off without telling anyone;
    // on waking, a window would still look connected and only fail on the next
    // line sent. Closing them properly as it goes to sleep, with a message,
    // leaves the windows saying what happened.
    powerMonitor.on("suspend", () => {
      log("info", "main", "the computer is going to sleep; disconnecting every window");
      for (const terminal of windowManager.all()) terminal.connection.disconnectForSleep();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
