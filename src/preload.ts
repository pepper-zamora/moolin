import { contextBridge, ipcRenderer } from "electron";
import type { World } from "./worlds-types";
import { getCliLogLevel, isEnabled, type LogLevel } from "./logger";

// Preload runs in its own JS context (separate from main.ts's), but shares
// the same process.argv, so it can gate log calls locally without an IPC
// round-trip just to find out logging is off.
const currentLogLevel = getCliLogLevel(process.argv);

contextBridge.exposeInMainWorld("moolin", {
  worlds: {
    load: (): Promise<World[]> => ipcRenderer.invoke("worlds:load"),
    save: (worlds: World[]): Promise<void> => ipcRenderer.invoke("worlds:save", worlds),
  },
  confirm: (message: string): Promise<boolean> => ipcRenderer.invoke("dialog:confirm", message),
  connect: (world: World): Promise<void> => ipcRenderer.invoke("connect:request", world),
  sendInput: (text: string): void => ipcRenderer.send("telnet:input", text),
  sendResize: (cols: number, rows: number): void => ipcRenderer.send("telnet:resize", { cols, rows }),
  getScrollback: (): Promise<Array<string | Uint8Array>> => ipcRenderer.invoke("terminal:getScrollback"),
  onTelnetData: (callback: (data: string | Uint8Array) => void): void => {
    ipcRenderer.on("telnet:data", (_event, data: string | Uint8Array) => callback(data));
  },
  onZoom: (callback: (direction: number) => void): void => {
    ipcRenderer.on("terminal:zoom", (_event, direction: number) => callback(direction));
  },
  onCreateNewWorld: (callback: () => void): void => {
    ipcRenderer.on("worlds:createNew", () => callback());
  },
  clipboard: {
    // The `clipboard` module isn't available to sandboxed preload/renderer
    // contexts, so this proxies to main.ts instead of calling it directly.
    writeText: (text: string): void => ipcRenderer.send("clipboard:writeText", text),
    readText: (): Promise<string> => ipcRenderer.invoke("clipboard:readText"),
  },
  showContextMenu: (options: { hasSelection: boolean }): void => {
    ipcRenderer.send("terminal:contextMenu", options);
  },
  onCopyRequested: (callback: () => void): void => {
    ipcRenderer.on("terminal:copyRequested", () => callback());
  },
  onPasteRequested: (callback: () => void): void => {
    ipcRenderer.on("terminal:pasteRequested", () => callback());
  },
  onSelectAllRequested: (callback: () => void): void => {
    ipcRenderer.on("terminal:selectAllRequested", () => callback());
  },
  log: (level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void => {
    if (!isEnabled(currentLogLevel, level)) return;
    ipcRenderer.send("log:emit", level, scope, args);
  },
});
