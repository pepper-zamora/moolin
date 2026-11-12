// Drops the copies of a line that several connections to the same character
// each receive. On the servers where a character can be connected more than
// once, every connection is sent all of the character's output, so a log
// written by all of them would hold each line once per connection. A character's
// history is one stream, so only the first copy of a line is kept.
//
// Copies are matched by content, not by position: the connections join at
// different times and TCP cuts their streams at different places, so there is
// no offset to line them up by. A line from a connection matches the oldest
// line another connection wrote, within `windowMs`, that this connection hasn't
// matched yet. Matching each written line once per connection, rather than
// looking only at the last line, keeps real repeats: two identical lines in a
// row arrive twice on every connection, and each connection claims one of the
// two written lines per arrival.
//
// Only complete lines are compared. The unfinished end of a connection's output
// (a prompt, say) waits here for its line feed, or for `flush`.

export const DEDUPE_WINDOW_MS = 5000;

// A connection that never sends a line feed doesn't make this hold its output
// without end: past this many bytes the unfinished line is let through as it is.
const MAX_HELD_BYTES = 64 * 1024;

const LF = 0x0a;

interface Entry {
  key: string;
  time: number;
  // The connections that have written or matched this line.
  seenBy: Set<unknown>;
}

export class LineDeduper {
  // Lines written in the last `windowMs`, oldest first; and the same entries by line.
  private readonly recent: Entry[] = [];
  private readonly byLine = new Map<string, Entry[]>();
  // Each connection's output that hasn't reached a line feed yet.
  private readonly held = new Map<unknown, Buffer>();

  constructor(private readonly windowMs = DEDUPE_WINDOW_MS) {}

  // Takes what `source` (any value that tells connections apart) received at
  // `now`, and returns what to write: its complete lines that no other
  // connection has already written.
  push(source: unknown, data: Uint8Array, now: number): Uint8Array {
    this.forgetOlderThan(now - this.windowMs);
    const pending = this.held.get(source);
    let rest = pending ? Buffer.concat([pending, data]) : Buffer.from(data.buffer, data.byteOffset, data.length);
    const out: Buffer[] = [];
    for (;;) {
      const end = rest.indexOf(LF);
      if (end < 0) break;
      const line = rest.subarray(0, end + 1);
      rest = rest.subarray(end + 1);
      if (this.isNew(source, line, now)) out.push(line);
    }
    if (rest.length > MAX_HELD_BYTES) {
      out.push(rest);
      this.held.delete(source);
    } else if (rest.length > 0) {
      this.held.set(source, Buffer.from(rest));
    } else {
      this.held.delete(source);
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  // The unfinished line `source` is holding, to write as it is (when
  // something else is to be written after it).
  flush(source: unknown): Uint8Array {
    const pending = this.held.get(source);
    this.held.delete(source);
    return pending ?? new Uint8Array();
  }

  // What `source` is holding, left where it is.
  peek(source: unknown): Uint8Array {
    return this.held.get(source) ?? new Uint8Array();
  }

  // Like `flush`, for a connection that is ending: nothing if another
  // connection is holding the same unfinished line (or more of it), since that
  // one will write it.
  leave(source: unknown): Uint8Array {
    const pending = this.flush(source);
    for (const other of this.held.values())
      if (other.subarray(0, pending.length).equals(pending)) return new Uint8Array();
    return pending;
  }

  // What every connection is holding, for when the last but one is leaving
  // and there is nothing left to match against.
  flushAll(): Uint8Array {
    const all = Buffer.concat([...this.held.values()]);
    this.held.clear();
    return all;
  }

  private isNew(source: unknown, line: Buffer, now: number): boolean {
    const key = line.toString("latin1");
    const candidates = this.byLine.get(key);
    const match = candidates?.find((entry) => !entry.seenBy.has(source));
    if (match) {
      match.seenBy.add(source);
      return false;
    }
    const entry: Entry = { key, time: now, seenBy: new Set([source]) };
    this.recent.push(entry);
    if (candidates) candidates.push(entry);
    else this.byLine.set(key, [entry]);
    return true;
  }

  private forgetOlderThan(cutoff: number): void {
    let n = 0;
    while (n < this.recent.length && this.recent[n].time < cutoff) {
      const { key } = this.recent[n++];
      const entries = this.byLine.get(key);
      if (!entries) continue;
      entries.shift(); // entries of one line are in the order they were written
      if (entries.length === 0) this.byLine.delete(key);
    }
    if (n > 0) this.recent.splice(0, n);
  }
}
