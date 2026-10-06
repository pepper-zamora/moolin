import type { GlobalSettings, World, WorldsLoadResult } from "./worlds-types";
import type { WindowState } from "./connection-manager";
import type { ScrollbackReplay } from "./scrollback-buffer";
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
      getConnectionState(): Promise<WindowState>;
      onTelnetData(callback: (data: string | Uint8Array, time: number | null, seq: number) => void): void;
      onConnectionState(callback: (state: WindowState) => void): void;
      onZoom(callback: (direction: number) => void): void;
      clipboard: {
        writeText(text: string): void;
        readText(): Promise<string>;
      };
      openExternal(url: string): void;
      showContextMenu(options: { hasSelection: boolean }): void;
      onCopyRequested(callback: () => void): void;
      onCutRequested(callback: () => void): void;
      onPasteRequested(callback: () => void): void;
      onSelectAllRequested(callback: () => void): void;
      onUndoRequested(callback: () => void): void;
      onRedoRequested(callback: () => void): void;
      onFindRequested(callback: (action: "open" | "next" | "previous") => void): void;
      onClearScreenRequested(callback: () => void): void;
      onToggleTimestamps(callback: (show: boolean) => void): void;
      onSetFont(callback: (font: { fontFamily: string; fontSize: number }) => void): void;
      initialFont: { fontId: string; fontSize: number };
      fitToContentOnLoad: boolean;
      // Internal, undocumented flag (see --fit-to-content above for the same
      // pattern): enables xterm's own accessibility tree (a hidden DOM mirror
      // of rendered rows, for screen readers), which scripts/smoke.mjs reads
      // to verify rendered text/geometry without reaching into xterm
      // internals. Off by default: it costs a DOM node per visible row kept
      // in sync on every render, not worth paying for every user by default.
      screenReaderMode: boolean;
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
