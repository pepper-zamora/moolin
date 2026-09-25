import type { World } from "./worlds-types";
import type { LogLevel } from "./logger";

declare global {
  interface Window {
    moolin: {
      worlds: {
        load(): Promise<World[]>;
        save(worlds: World[]): Promise<void>;
      };
      confirm(message: string): Promise<boolean>;
      connect(world: World): Promise<void>;
      sendInput(text: string): void;
      sendResize(cols: number, rows: number): void;
      getScrollback(): Promise<Array<string | Uint8Array>>;
      onTelnetData(callback: (data: string | Uint8Array) => void): void;
      onZoom(callback: (direction: number) => void): void;
      onCreateNewWorld(callback: () => void): void;
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
      };
      showContextMenu(options: { hasSelection: boolean }): void;
      onCopyRequested(callback: () => void): void;
      onPasteRequested(callback: () => void): void;
      onSelectAllRequested(callback: () => void): void;
      log(level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void;
    };
  }
}

export {};
