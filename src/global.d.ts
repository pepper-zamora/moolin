import type { World, WorldsLoadResult } from "./worlds-types";
import type { ConnectionState } from "./connection-manager";
import type { LogLevel } from "./logger";

declare global {
  interface Window {
    moolin: {
      worlds: {
        load(): Promise<WorldsLoadResult>;
        save(worlds: World[]): Promise<{ error?: string }>;
        onOpen(callback: (options: { createNew: boolean }) => void): void;
        onChanged(callback: () => void): void;
      };
      confirm(message: string): Promise<boolean>;
      connect(world: World, characterId: string | null): void;
      popupMenu(items: Array<{ id: string; label: string }>): Promise<string | null>;
      sendInput(text: string): void;
      sendResize(cols: number, rows: number): void;
      getScrollback(): Promise<Array<string | Uint8Array>>;
      onTerminalReset(callback: (chunks: Array<string | Uint8Array>) => void): void;
      getConnectionState(): Promise<ConnectionState>;
      onTelnetData(callback: (data: string | Uint8Array) => void): void;
      onConnectionState(callback: (state: ConnectionState) => void): void;
      onZoom(callback: (direction: number) => void): void;
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
      };
      openExternal(url: string): void;
      showContextMenu(options: { hasSelection: boolean }): void;
      onCopyRequested(callback: () => void): void;
      onPasteRequested(callback: () => void): void;
      onSelectAllRequested(callback: () => void): void;
      log(level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void;
    };
  }
}

export {};
