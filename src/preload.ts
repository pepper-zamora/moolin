import { contextBridge, ipcRenderer } from "electron";
import type { World, WorldsLoadResult } from "./worlds-types";
import type { WindowState } from "./connection-manager";
import { getCliLogLevel, isEnabled, type LogLevel } from "./logger";
import type { ScrollbackReplay } from "./scrollback-buffer";
import { IpcChannels } from "./ipc-channels";

// Preload runs in the renderer's process, but main.ts appends
// "--log-level=..." to its argv (additionalArguments), so it can gate log
// calls locally without an IPC round-trip just to find out logging is off.
const currentLogLevel = getCliLogLevel(process.argv);

contextBridge.exposeInMainWorld("moolin", {
  worlds: {
    load: (): Promise<WorldsLoadResult> => ipcRenderer.invoke(IpcChannels.worldsLoad),
    save: (worlds: World[]): Promise<{ error?: string }> => ipcRenderer.invoke(IpcChannels.worldsSave, worlds),
    onOpen: (callback: (options: { createNew: boolean }) => void): void => {
      ipcRenderer.on(IpcChannels.worldsOpen, (_event, options: { createNew: boolean }) => callback(options));
    },
    onChanged: (callback: () => void): void => {
      ipcRenderer.on(IpcChannels.worldsChanged, () => callback());
    },
  },
  confirm: (message: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.dialogConfirm, message),
  connect: (world: World, characterId: string | null): void =>
    ipcRenderer.send(IpcChannels.connectRequest, { world, characterId }),
  // Shows a native popup menu; resolves with the chosen item's id, or null.
  popupMenu: (items: Array<{ id: string; label: string }>): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.menuPopup, items),
  sendInput: (text: string): void => ipcRenderer.send(IpcChannels.telnetInput, text),
  sendResize: (cols: number, rows: number): void => ipcRenderer.send(IpcChannels.telnetResize, { cols, rows }),
  getScrollback: (): Promise<ScrollbackReplay> => ipcRenderer.invoke(IpcChannels.terminalGetScrollback),
  onTerminalReset: (callback: (replay: ScrollbackReplay) => void): void => {
    ipcRenderer.on(IpcChannels.terminalReset, (_event, replay: ScrollbackReplay) => callback(replay));
  },
  getConnectionState: (): Promise<WindowState> => ipcRenderer.invoke(IpcChannels.connectionGetState),
  onTelnetData: (callback: (data: string | Uint8Array, time: number | null, seq: number) => void): void => {
    ipcRenderer.on(IpcChannels.telnetData, (_event, data: string | Uint8Array, time: number | null, seq: number) =>
      callback(data, time, seq),
    );
  },
  onConnectionState: (callback: (state: WindowState) => void): void => {
    ipcRenderer.on(IpcChannels.connectionState, (_event, state: WindowState) => callback(state));
  },
  onZoom: (callback: (direction: number) => void): void => {
    ipcRenderer.on(IpcChannels.terminalZoom, (_event, direction: number) => callback(direction));
  },
  clipboard: {
    // The `clipboard` module isn't available to sandboxed preload/renderer
    // contexts, so this proxies to main.ts instead of calling it directly.
    writeText: (text: string): void => ipcRenderer.send(IpcChannels.clipboardWriteText, text),
    readText: (): Promise<string> => ipcRenderer.invoke(IpcChannels.clipboardReadText),
  },
  openExternal: (url: string): void => ipcRenderer.send(IpcChannels.shellOpenExternal, url),
  showContextMenu: (options: { hasSelection: boolean }): void => {
    ipcRenderer.send(IpcChannels.terminalContextMenu, options);
  },
  onCopyRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalCopyRequested, () => callback());
  },
  onCutRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalCutRequested, () => callback());
  },
  onPasteRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalPasteRequested, () => callback());
  },
  onSelectAllRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalSelectAllRequested, () => callback());
  },
  onUndoRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalUndoRequested, () => callback());
  },
  onRedoRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalRedoRequested, () => callback());
  },
  onFindRequested: (callback: (action: "open" | "next" | "previous") => void): void => {
    ipcRenderer.on(IpcChannels.terminalFindRequested, (_event, action: "open" | "next" | "previous") =>
      callback(action),
    );
  },
  onClearScreenRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalClearScreenRequested, () => callback());
  },
  onToggleTimestamps: (callback: (show: boolean) => void): void => {
    ipcRenderer.on(IpcChannels.terminalToggleTimestamps, (_event, show: boolean) => callback(show));
  },
  reportUndoState: (canUndo: boolean, canRedo: boolean): void => {
    ipcRenderer.send(IpcChannels.terminalUndoStateChanged, canUndo, canRedo);
  },
  log: (level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void => {
    if (!isEnabled(currentLogLevel, level)) return;
    ipcRenderer.send(IpcChannels.logEmit, level, scope, args);
  },
});
