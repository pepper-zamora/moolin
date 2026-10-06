// Shared low-level byte classification for scanning raw server output,
// used by both word-wrap.ts (which must preserve escape sequences verbatim
// while tracking visible column width) and raw-line-tracker.ts (which must
// strip them to recover plain text). Kept minimal: only the pieces both
// callers need live here; column-width-specific helpers (isContinuationByte,
// the SPACE constant) stay local to word-wrap.ts.

export const TAB = 0x09;
export const CR = 0x0d;
export const LF = 0x0a;
export const VT = 0x0b;
export const FF = 0x0c;
export const ESC = 0x1b;

// Safety bound on how long an escape sequence is allowed to run before we
// give up on it and treat the ESC byte as a lone, harmless control byte —
// guards against unbounded buffering if a corrupted/non-standard sequence
// never finds its terminator.
export const MAX_ESCAPE_LENGTH = 64;

// Scans an escape sequence starting at `start` (input[start] === ESC).
// Returns the exclusive end index once complete, "incomplete" if more bytes
// are needed, or "abandon" if it's run past MAX_ESCAPE_LENGTH without
// terminating (the caller then treats just the ESC byte as inert).
export function scanEscape(input: Uint8Array, start: number): number | "incomplete" | "abandon" {
  if (start + 1 >= input.length) return "incomplete";
  const kind = input[start + 1];
  let i = start + 2;
  if (kind === 0x5b /* [ */) {
    // CSI: parameter/intermediate bytes 0x20-0x3f, final byte 0x40-0x7e.
    while (i < input.length) {
      const b = input[i];
      if (b >= 0x40 && b <= 0x7e) return i + 1;
      if (i - start > MAX_ESCAPE_LENGTH) return "abandon";
      i++;
    }
    return "incomplete";
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    // OSC/DCS/SOS/PM/APC: runs until BEL (0x07) or ST (ESC \).
    while (i < input.length) {
      const b = input[i];
      if (b === 0x07) return i + 1;
      if (b === ESC && i + 1 < input.length && input[i + 1] === 0x5c) return i + 2;
      if (b === ESC && i + 1 >= input.length) return "incomplete";
      if (i - start > MAX_ESCAPE_LENGTH) return "abandon";
      i++;
    }
    return "incomplete";
  }
  // A generic two-byte escape (ESC c, ESC 7/8, ESC M, ...). A handful of
  // real sequences are actually three bytes (e.g. ESC ( B charset
  // selection); under-consuming those miscounts a column or two at worst,
  // never breaking copy-paste (see word-wrap.ts's module comment), so it's
  // left as a known, low-stakes approximation rather than enumerated
  // exhaustively.
  return start + 2;
}
