// Wraps long lines at word boundaries for display, by padding a row with
// spaces until xterm's own column-overflow auto-wrap triggers exactly where
// we want it to. xterm has no word-aware wrap mode of its own (it only wraps
// by column count), but it DOES correctly mark a row it wrapped itself as
// `isWrapped`, which is what makes copy/paste reconstruct a wrapped line as
// one line (xterm's selection code joins `isWrapped` rows with no
// separator). Triggering xterm's own wrap via padding — rather than
// inserting a line break ourselves — means copy/paste behaves exactly as it
// already does for today's default mid-word wrapping. See the word-wrap
// plan for the full reasoning.
//
// Byte-oriented throughout, so a non-UTF-8 or malformed byte stream renders
// the same whether word-wrap is on or off — we never decode server bytes to
// a JS string and back. Only the lead byte of a multi-byte UTF-8 sequence
// counts toward visible column width (continuation bytes don't); there's no
// true wcwidth support, so a double-width (CJK) character is still counted
// as one column, a known limitation consistent with the rest of this
// codebase's ASCII/Latin-1-centric assumptions.

const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const ESC = 0x1b;

// Safety bound on how long an escape sequence is allowed to run before we
// give up on it and treat the ESC byte as a lone, harmless control byte —
// guards against unbounded buffering if a corrupted/non-standard sequence
// never finds its terminator.
const MAX_ESCAPE_LENGTH = 64;

function isContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

// Scans an escape sequence starting at `start` (input[start] === ESC).
// Returns the exclusive end index once complete, "incomplete" if more bytes
// are needed, or "abandon" if it's run past MAX_ESCAPE_LENGTH without
// terminating (the caller then treats just the ESC byte as inert).
function scanEscape(input: Uint8Array, start: number): number | "incomplete" | "abandon" {
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
  // never breaking copy-paste (see the module comment), so it's left as a
  // known, low-stakes approximation rather than enumerated exhaustively.
  return start + 2;
}

export class WordWrapper {
  private cols: number;
  private col = 0;
  private pendingBytes: number[] = [];
  private pendingVisibleLen = 0;
  // Raw bytes of an escape sequence still waiting on its terminator, held
  // across transform() calls (see scanEscape's "incomplete").
  private heldEscape: number[] = [];

  constructor(cols: number) {
    this.cols = Math.max(1, cols);
  }

  // Affects subsequent transform() calls only — see the plan's "resize
  // reflow" section for how already-displayed text gets a fresh pass.
  setCols(cols: number): void {
    this.cols = Math.max(1, cols);
  }

  reset(): void {
    this.col = 0;
    this.pendingBytes = [];
    this.pendingVisibleLen = 0;
    this.heldEscape = [];
  }

  transform(chunk: string | Uint8Array): Uint8Array {
    const chunkBytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    let input: Uint8Array;
    if (this.heldEscape.length > 0) {
      input = new Uint8Array(this.heldEscape.length + chunkBytes.length);
      input.set(this.heldEscape, 0);
      input.set(chunkBytes, this.heldEscape.length);
      this.heldEscape = [];
    } else {
      input = chunkBytes;
    }

    const out: number[] = [];
    let i = 0;
    const n = input.length;

    const flushWord = (): void => this.flushWordInto(out);

    const advanceCol = (visibleCount: number): void => {
      this.col = ((this.col + visibleCount - 1) % this.cols) + 1;
    };

    while (i < n) {
      const b = input[i];
      if (b === ESC) {
        const result = scanEscape(input, i);
        if (result === "incomplete") {
          this.heldEscape = Array.from(input.slice(i));
          i = n;
          break;
        }
        if (result === "abandon") {
          this.pendingBytes.push(b);
          i++;
          continue;
        }
        for (let k = i; k < result; k++) this.pendingBytes.push(input[k]);
        i = result;
        continue;
      }
      if (b === CR || b === LF || b === VT || b === FF) {
        flushWord();
        out.push(b);
        this.col = 0;
        i++;
        continue;
      }
      if (b === SPACE) {
        flushWord();
        out.push(b);
        advanceCol(1);
        i++;
        continue;
      }
      if (b === TAB) {
        flushWord();
        out.push(b);
        // 8-column tab stops; clamped to the row width (a tab that would
        // overshoot is a rare, low-stakes case — see the module comment).
        const from = this.col >= this.cols ? 0 : this.col;
        this.col = Math.min(this.cols, (Math.floor(from / 8) + 1) * 8);
        i++;
        continue;
      }
      if (b < 0x20) {
        // Another C0 control (BEL, BS, ...): invisible, rides along with
        // whatever word is forming, same as an escape sequence.
        this.pendingBytes.push(b);
        i++;
        continue;
      }
      this.pendingBytes.push(b);
      if (!isContinuationByte(b)) this.pendingVisibleLen++;
      i++;
    }

    return Uint8Array.from(out);
  }

  // Shared by transform()'s scan loop and flushPending(): emits the
  // in-progress word (padding first if it would overflow the row), updating
  // `col` to match, and clears the pending state.
  private flushWordInto(out: number[]): void {
    if (this.pendingVisibleLen === 0) {
      if (this.pendingBytes.length) out.push(...this.pendingBytes);
    } else {
      if (this.pendingVisibleLen <= this.cols && this.col + this.pendingVisibleLen > this.cols) {
        for (let p = this.col; p < this.cols; p++) out.push(SPACE);
        this.col = 0;
      }
      out.push(...this.pendingBytes);
      this.col = ((this.col + this.pendingVisibleLen - 1) % this.cols) + 1;
    }
    this.pendingBytes = [];
    this.pendingVisibleLen = 0;
  }

  // A trailing word might be the last bytes the server ever sends (a prompt
  // with no trailing newline or space) — nothing will arrive to "complete"
  // it. The caller (renderer.ts) decides when enough quiet time has passed
  // to call this; the algorithm itself stays synchronous either way.
  flushPending(): Uint8Array | null {
    if (this.pendingVisibleLen === 0 && this.pendingBytes.length === 0 && this.heldEscape.length === 0) return null;
    const out: number[] = [];
    this.flushWordInto(out);
    // Best effort: an incomplete escape sequence with nothing more coming is
    // just dumped as-is rather than held forever.
    out.push(...this.heldEscape);
    this.heldEscape = [];
    return Uint8Array.from(out);
  }
}
