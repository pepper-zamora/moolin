// The curated monospace fonts offered in the Preferences dialog's font
// picker, and the size bounds shared with the terminal-native zoom (see
// renderer.ts). Each entry's cssFamily carries its own fallback so an
// uninstalled font just degrades to the next best guess rather than a bare
// system default; the live sample shown beside each option in the dialog
// reveals that at a glance, so there's no need to detect what's installed.
export interface MonospaceFont {
  id: string;
  label: string;
  cssFamily: string;
}

export const DEFAULT_FONT_ID = "system-default";

export const MONOSPACE_FONTS: MonospaceFont[] = [
  { id: "system-default", label: "System Default", cssFamily: `Menlo, Consolas, "DejaVu Sans Mono", monospace` },
  { id: "menlo", label: "Menlo", cssFamily: `Menlo, monospace` },
  { id: "sf-mono", label: "SF Mono", cssFamily: `"SF Mono", Menlo, monospace` },
  { id: "monaco", label: "Monaco", cssFamily: `Monaco, monospace` },
  { id: "consolas", label: "Consolas", cssFamily: `Consolas, monospace` },
  { id: "cascadia-mono", label: "Cascadia Mono", cssFamily: `"Cascadia Mono", "Cascadia Code", monospace` },
  { id: "lucida-console", label: "Lucida Console", cssFamily: `"Lucida Console", monospace` },
  { id: "dejavu-sans-mono", label: "DejaVu Sans Mono", cssFamily: `"DejaVu Sans Mono", monospace` },
  { id: "ubuntu-mono", label: "Ubuntu Mono", cssFamily: `"Ubuntu Mono", monospace` },
  { id: "courier-new", label: "Courier New", cssFamily: `"Courier New", monospace` },
  { id: "jetbrains-mono", label: "JetBrains Mono", cssFamily: `"JetBrains Mono", monospace` },
  { id: "fira-code", label: "Fira Code", cssFamily: `"Fira Code", monospace` },
  { id: "iosevka", label: "Iosevka", cssFamily: `Iosevka, monospace` },
  { id: "source-code-pro", label: "Source Code Pro", cssFamily: `"Source Code Pro", monospace` },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", cssFamily: `"IBM Plex Mono", monospace` },
  { id: "hack", label: "Hack", cssFamily: `Hack, monospace` },
];

export function isValidFontId(id: string): boolean {
  return MONOSPACE_FONTS.some((f) => f.id === id);
}

export function fontFamilyFor(id: string): string {
  return (MONOSPACE_FONTS.find((f) => f.id === id) ?? MONOSPACE_FONTS[0]).cssFamily;
}

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const FONT_SIZE_STEP = 2;

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

// Lines chosen to surface glyphs that commonly look alike in a monospace
// font (zero/O/o, one/l/I/i, rn vs m...), then the full alphabet and digits
// for overall shape and weight.
export const FONT_SAMPLE_LINES = [
  "0O 1lI il1 5S 8B rn m vv w",
  `\`~!@#$%^&*()_+-={}[]|\\:;"'<>,.?/`,
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz 0123456789",
];

// "--font-id=..." and "--font-size=..." reach the renderer via main.ts's
// additionalArguments (see getCliLogLevel in logger.ts for the same trick),
// so a freshly opened window can construct its Terminal with the right font
// from the start rather than flashing the wrong one and re-rendering.
export function parseFontArgs(argv: string[]): { fontId: string; fontSize: number } {
  const idFlag = argv.find((arg) => arg.startsWith("--font-id="))?.slice("--font-id=".length);
  const sizeFlag = argv.find((arg) => arg.startsWith("--font-size="))?.slice("--font-size=".length);
  const fontId = idFlag !== undefined && isValidFontId(idFlag) ? idFlag : DEFAULT_FONT_ID;
  const parsedSize = sizeFlag !== undefined ? Number(sizeFlag) : Number.NaN;
  const fontSize = Number.isFinite(parsedSize) ? clampFontSize(parsedSize) : DEFAULT_FONT_SIZE;
  return { fontId, fontSize };
}
