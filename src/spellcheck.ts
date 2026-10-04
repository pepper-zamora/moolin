import * as fs from "node:fs";
import * as path from "node:path";

// Spell checking in the input area. On macOS Chromium uses the system's own
// spell checker. Elsewhere it uses Hunspell dictionaries, which it normally
// downloads, once per language, from Google's servers. The English ones
// ship with Moolin instead (dictionaries/, from Electron's
// hunspell_dictionaries.zip), copied to where Chromium looks for downloaded
// ones; other languages are still downloaded (see the README's "Not
// telemetry" section).

// The most dictionaries to check against at once; each one slows checking.
const MAX_LANGUAGES = 3;

// The languages to spell check in: the user's preferred system languages
// (most preferred first), each matched to one Chromium has a dictionary for,
// exactly ("en-GB") or else by base language ("fr-CA" -> "fr", or failing
// that "fr-FR"). One dictionary per base language, since preferences often
// list both "en-US" and "en".
export function pickSpellCheckerLanguages(preferred: string[], available: string[]): string[] {
  const byLower = new Map(available.map((code) => [code.toLowerCase(), code]));
  const picked: string[] = [];
  const bases = new Set<string>();
  for (const wanted of preferred) {
    const lower = wanted.toLowerCase().replace(/_/g, "-");
    const base = lower.split("-")[0];
    if (!base || bases.has(base)) continue;
    const match =
      byLower.get(lower) ?? byLower.get(base) ?? available.find((code) => code.toLowerCase().startsWith(`${base}-`));
    if (!match) continue;
    picked.push(match);
    bases.add(base);
    if (picked.length === MAX_LANGUAGES) break;
  }
  return picked;
}

// Copies the bundled dictionaries (*.bdic in `fromDir`) into `toDir`, the
// folder Chromium keeps downloaded dictionaries in, skipping any already
// there. Chromium only looks when its session starts, so this has to run
// before the app is ready. Returns the files copied; failures are reported
// to `onError` and otherwise ignored, since Chromium then just downloads.
export function installBundledDictionaries(
  fromDir: string,
  toDir: string,
  onError: (file: string, error: Error) => void,
): string[] {
  const copied: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(fromDir).filter((name) => name.endsWith(".bdic"));
    fs.mkdirSync(toDir, { recursive: true });
  } catch (err) {
    onError(fromDir, err as Error);
    return copied;
  }
  for (const name of files) {
    const target = path.join(toDir, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(path.join(fromDir, name), target);
      copied.push(name);
    } catch (err) {
      onError(target, err as Error);
    }
  }
  return copied;
}

export type SpellingMenuItem =
  | { kind: "replace"; word: string }
  | { kind: "add"; word: string }
  | { kind: "no-suggestions" };

// The spelling part of the input area's context menu, for the word under the
// pointer: its suggestions (or a note that there are none), then a way to
// stop flagging it. Empty when the word isn't misspelled.
export function spellingMenuItems(misspelledWord: string, suggestions: string[]): SpellingMenuItem[] {
  if (misspelledWord === "") return [];
  const items: SpellingMenuItem[] =
    suggestions.length > 0 ? suggestions.map((word) => ({ kind: "replace", word })) : [{ kind: "no-suggestions" }];
  items.push({ kind: "add", word: misspelledWord });
  return items;
}
