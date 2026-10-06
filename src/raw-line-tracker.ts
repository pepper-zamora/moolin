// Recovers plain, copy-safe text for each line of raw server output, so that
// copying a word-wrapped selection (see word-wrap.ts) can substitute the
// original line instead of xterm's padded display text (see renderer.ts's
// getWrapAwareSelection). Byte-oriented and stateful across push() calls,
// same shape as WordWrapper, but with no column tracking at all: this module
// only ever needs to know where a line ends and what its plain text is, not
// where word-wrap would break it.
//
// Line boundaries use the exact same convention as line-feeds.ts's
// countLineFeeds (LF, VT or FF ends a line, even one that happens to fall
// inside an OSC/DCS escape payload) rather than an escape-aware one — the
// renderer zips this module's output 1:1 against countLineFeeds-based
// queues, so the two must always agree on how many lines a chunk contains.
//
// There is deliberately no flushPending() (unlike WordWrapper): an
// unterminated trailing line (e.g. a prompt with no newline yet) never fires
// xterm's onLineFeed either, so nothing would ever consume a flushed value.

import { CR, ESC, FF, LF, TAB, VT, scanEscape } from "./ansi-scan";

const decoder = new TextDecoder();

export class RawLineAccumulator {
  private current: number[] = [];
  // Raw bytes of an escape sequence still waiting on its terminator, held
  // across push() calls (see scanEscape's "incomplete").
  private heldEscape: number[] = [];

  reset(): void {
    this.current = [];
    this.heldEscape = [];
  }

  // Returns the plain text of every line completed by this chunk, in order.
  push(chunk: string | Uint8Array): string[] {
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

    const lines: string[] = [];
    let i = 0;
    const n = input.length;

    while (i < n) {
      const b = input[i];
      if (b === ESC) {
        const result = scanEscape(input, i);
        if (result === "incomplete") {
          this.heldEscape = Array.from(input.slice(i));
          i = n;
          break;
        }
        // Whether complete or abandoned, the escape bytes (and a lone,
        // inert ESC on abandon) never contribute to the copyable text — a
        // bare ESC was never a copyable glyph, unlike WordWrapper, which
        // re-emits it to keep wrap-on/wrap-off display identical.
        i = result === "abandon" ? i + 1 : result;
        continue;
      }
      if (b === LF || b === VT || b === FF) {
        lines.push(decoder.decode(Uint8Array.from(this.current)));
        this.current = [];
        i++;
        continue;
      }
      if (b === CR) {
        i++;
        continue;
      }
      if (b === TAB) {
        this.current.push(b);
        i++;
        continue;
      }
      if (b < 0x20) {
        // Another C0 control (BEL, BS, ...): invisible, dropped.
        i++;
        continue;
      }
      this.current.push(b);
      i++;
    }

    return lines;
  }
}
