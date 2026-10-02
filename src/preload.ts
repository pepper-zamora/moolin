import { contextBridge, ipcRenderer } from "electron";
import type { World } from "./worlds-types";
import { getCliLogLevel, isEnabled, type LogLevel } from "./logger";
import { IpcChannels } from "./ipc-channels";

// Preload runs in its own JS context (separate from main.ts's), but shares
// the same process.argv, so it can gate log calls locally without an IPC
// round-trip just to find out logging is off.
const currentLogLevel = getCliLogLevel(process.argv);

contextBridge.exposeInMainWorld("moolin", {
  worlds: {
    load: (): Promise<World[]> => ipcRenderer.invoke(IpcChannels.worldsLoad),
    save: (worlds: World[]): Promise<void> => ipcRenderer.invoke(IpcChannels.worldsSave, worlds),
  },
  confirm: (message: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.dialogConfirm, message),
  connect: (world: World): Promise<void> => ipcRenderer.invoke(IpcChannels.connectRequest, world),
  sendInput: (text: string): void => ipcRenderer.send(IpcChannels.telnetInput, text),
  sendResize: (cols: number, rows: number): void => ipcRenderer.send(IpcChannels.telnetResize, { cols, rows }),
  getScrollback: (): Promise<Array<string | Uint8Array>> => ipcRenderer.invoke(IpcChannels.terminalGetScrollback),
  getConnectionState: (): Promise<{ secure: boolean }> => ipcRenderer.invoke(IpcChannels.connectionGetState),
  onTelnetData: (callback: (data: string | Uint8Array) => void): void => {
    ipcRenderer.on(IpcChannels.telnetData, (_event, data: string | Uint8Array) => callback(data));
  },
  onConnectionState: (callback: (state: { secure: boolean }) => void): void => {
    ipcRenderer.on(IpcChannels.connectionState, (_event, state: { secure: boolean }) => callback(state));
  },
  onZoom: (callback: (direction: number) => void): void => {
    ipcRenderer.on(IpcChannels.terminalZoom, (_event, direction: number) => callback(direction));
  },
  onCreateNewWorld: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.worldsCreateNew, () => callback());
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
  onPasteRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalPasteRequested, () => callback());
  },
  onSelectAllRequested: (callback: () => void): void => {
    ipcRenderer.on(IpcChannels.terminalSelectAllRequested, () => callback());
  },
  log: (level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void => {
    if (!isEnabled(currentLogLevel, level)) return;
    ipcRenderer.send(IpcChannels.logEmit, level, scope, args);
  },
});
