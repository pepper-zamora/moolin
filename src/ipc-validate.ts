// Checks on what the renderer sends the main process. The renderer reads
// whatever servers send, so main treats its messages as input from outside:
// nothing it sends is used without being checked here first. Pure, so it can
// be tested without Electron.
import { LOG_LEVELS, type LogLevel } from "./logger";

// The most text one input line may be (a large paste is still allowed).
export const MAX_INPUT_LENGTH = 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const MAX_MENU_ITEMS = 50;
const MAX_LABEL_LENGTH = 500;
const MAX_LOG_SCOPE_LENGTH = 64;
const MAX_LOG_ARGS = 20;

// A terminal size in character cells, as NAWS can carry it (two bytes each).
export function parseSize(value: unknown): { cols: number; rows: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 0xffff;
  return ok(cols) && ok(rows) ? { cols, rows } : null;
}

// A web address to open in the browser: http or https only, so a server can't
// get a click to open a file or another program's address scheme.
export function parseExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInputText(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_INPUT_LENGTH ? value : null;
}

export function parseMenuItems(value: unknown): Array<{ id: string; label: string }> | null {
  if (!Array.isArray(value) || value.length > MAX_MENU_ITEMS) return null;
  const items: Array<{ id: string; label: string }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, label } = item as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || typeof label !== "string" || label.length > MAX_LABEL_LENGTH) return null;
    items.push({ id, label });
  }
  return items;
}

// The message and detail of a confirmation dialog.
export function parseConfirmText(message: unknown, detail: unknown): { message: string; detail?: string } | null {
  if (typeof message !== "string" || message.length > MAX_LABEL_LENGTH) return null;
  if (detail === undefined) return { message };
  return typeof detail === "string" && detail.length <= MAX_LABEL_LENGTH * 4 ? { message, detail } : null;
}

export function parseLogCall(
  level: unknown,
  scope: unknown,
  args: unknown,
): { level: Exclude<LogLevel, "none">; scope: string; args: unknown[] } | null {
  if (typeof level !== "string" || level === "none" || !(LOG_LEVELS as readonly string[]).includes(level)) return null;
  if (typeof scope !== "string" || scope.length > MAX_LOG_SCOPE_LENGTH) return null;
  if (!Array.isArray(args) || args.length > MAX_LOG_ARGS) return null;
  return { level: level as Exclude<LogLevel, "none">, scope: scope.replace(/[\x00-\x1f\x7f]/g, " "), args };
}

export function parseBooleanPair(a: unknown, b: unknown): [boolean, boolean] | null {
  return typeof a === "boolean" && typeof b === "boolean" ? [a, b] : null;
}

export function parseInitialSize(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n < 100000;
  return ok(width) && ok(height) ? { width, height } : null;
}

export function parseContextMenuOptions(
  value: unknown,
): { hasSelection: boolean; selectAllTarget: "scrollback" | "input" } | null {
  if (typeof value !== "object" || value === null) return null;
  const { hasSelection, selectAllTarget } = value as { hasSelection?: unknown; selectAllTarget?: unknown };
  if (typeof hasSelection !== "boolean") return null;
  if (selectAllTarget !== "scrollback" && selectAllTarget !== "input") return null;
  return { hasSelection, selectAllTarget };
}

export function parseConnectRequest(value: unknown): { world: unknown; characterId: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const { world, characterId } = value as { world?: unknown; characterId?: unknown };
  if (characterId !== null && typeof characterId !== "string") return null;
  return { world, characterId };
}

// Text for the clipboard: at most as much as a window's whole scrollback and then some.
const MAX_CLIPBOARD_LENGTH = 16 * 1024 * 1024;
export function parseClipboardText(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_CLIPBOARD_LENGTH ? value : null;
}
