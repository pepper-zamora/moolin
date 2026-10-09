import type { GlobalSettings, World, WorldsLoadResult } from "./worlds-types";
import type { WindowState } from "./connection-manager";
import type { ScrollbackReplay } from "./scrollback-buffer";
import type { SelectAllTarget } from "./select-all";
import type { LogLevel } from "./logger";
import type { Preferences } from "./preferences";

declare global {
  interface Window {
    moolin: {
      worlds: {
        load(): Promise<WorldsLoadResult>;
        save(worlds: World[], globalSettings: GlobalSettings): Promise<{ error?: string }>;
        onOpen(callback: (options: { createNew: boolean }) => void): void;
        onChanged(callback: () => void): void;
      };
      confirm(message: string, detail?: string): Promise<boolean>;
      connect(world: World, characterId: string | null): void;
      popupMenu(items: Array<{ id: string; label: string }>): Promise<string | null>;
      sendInput(text: string): void;
      sendResize(cols: number, rows: number): void;
      getScrollback(): Promise<ScrollbackReplay>;
      onTerminalReset(callback: (replay: ScrollbackReplay) => void): void;
      onGreetingClosed(callback: (seq: number) => void): void;
      getConnectionState(): Promise<WindowState>;
      onTelnetData(callback: (data: string | Uint8Array, time: number | null, seq: number) => void): void;
      onConnectionState(callback: (state: WindowState) => void): void;
      onZoom(callback: (direction: number) => void): void;
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
      };
      openExternal(url: string): void;
      showContextMenu(options: { hasSelection: boolean; selectAllTarget: SelectAllTarget }): void;
      onCopyRequested(callback: () => void): void;
      onCutRequested(callback: () => void): void;
      onPasteRequested(callback: () => void): void;
      // `target` is set when the request names where it goes (the context menu);
      // from the Edit menu and the keyboard it isn't (see select-all.ts).
      onSelectAllRequested(callback: (target?: SelectAllTarget) => void): void;
      onUndoRequested(callback: () => void): void;
      onRedoRequested(callback: () => void): void;
      onFindRequested(callback: (action: "open" | "next" | "previous") => void): void;
      onClearScreenRequested(callback: () => void): void;
      onToggleTimestamps(callback: (show: boolean) => void): void;
      onSetFont(callback: (font: { fontFamily: string; fontSize: number }) => void): void;
      initialFont: { fontId: string; fontSize: number };
      fitToContentOnLoad: boolean;
      reportInitialSize(size: { width: number; height: number }): void;
      preferences: {
        onOpen(callback: (prefs: Preferences) => void): void;
        save(partial: Partial<Preferences>): Promise<void>;
      };
      reportUndoState(canUndo: boolean, canRedo: boolean): void;
      log(level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void;
    };
  }
}
