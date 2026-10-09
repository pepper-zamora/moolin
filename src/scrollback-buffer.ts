import { countLineFeeds } from "./line-feeds";

export type TerminalChunk = string | Uint8Array;

// A replay of the buffer plus, aligned one-to-one with the line feeds in it, the
// wall-clock time (epoch ms) each line arrived — or null where it isn't known
// (e.g. history loaded from a log). The renderer uses these to rebuild the
// timestamp gutter after a reload, without the times ever entering the byte
// stream itself (see renderer.ts and GAPS.md §8).
export interface ScrollbackReplay {
  chunks: TerminalChunk[];
  times: Array<number | null>;
  // The window's output sequence number as of this replay: every live write
  // or reset numbered at or below it is already reflected here (see
  // TerminalWindow).
  seq: number;
  // Whether the connection is in Pueblo mode at the end of the buffer, so a
  // replay that no longer holds the server's greeting still reads the tags.
  pueblo: boolean;
  // Whether the server's greeting could still switch Pueblo on (no line has
  // been sent to the server yet).
  greetingOpen: boolean;
}

function byteLength(data: TerminalChunk): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
}

// Coerces a provided times list to exactly `total` entries. Normally it
// already matches; if it's short the known times are the most recent, so pad
// the front (older lines) with null; if long, keep the newest `total`.
function normalizeTimes(times: Array<number | null> | null, total: number): Array<number | null> {
  if (!times) return new Array(total).fill(null);
  if (times.length === total) return times.slice();
  if (times.length > total) return times.slice(times.length - total);
  return new Array(total - times.length).fill(null).concat(times);
}

// In-memory replay buffer so a window's scrollback survives a renderer
// reload/crash. Keeps the most recent `maxBytes`, dropping whole lines from
// the front, so a line is kept or dropped the same way whether it arrived
// live or came from the log in one large chunk. Not persisted itself; the persistent record is the
// session log (see session-log.ts), whose tail is loaded in here on connect.
export class ScrollbackBuffer {
  private chunks: TerminalChunk[] = [];
  private bytes = 0;
  // One entry per line feed currently in the buffer, in order: the time that
  // line arrived, or null if unknown. Adding an entry per line feed on append
  // and dropping a dropped chunk's worth off the front keeps it aligned with
  // exactly the line feeds a replay will feed the scrollback, which makes one
  // line break for each (see line-feeds.ts) and none on wrap, so the renderer
  // can consume these in lockstep to re-stamp each line.
  private lineTimes: Array<number | null> = [];

  constructor(private readonly maxBytes: number) {}

  append(data: TerminalChunk, time: number | null = null): void {
    this.chunks.push(data);
    this.bytes += byteLength(data);
    for (let i = 0, n = countLineFeeds(data); i < n; i++) this.lineTimes.push(time);
    this.trim();
  }

  // Replaces the contents, e.g. with a log's history when a window connects.
  // `times` gives the arrival time of each line feed across `chunks`, in order
  // (from the log's sidecar); omit it and the times come back as null (unknown).
  reset(chunks: TerminalChunk[], times: Array<number | null> | null = null): void {
    this.chunks = chunks.slice();
    this.bytes = 0;
    let total = 0;
    for (const chunk of this.chunks) {
      this.bytes += byteLength(chunk);
      total += countLineFeeds(chunk);
    }
    this.lineTimes = normalizeTimes(times, total);
    this.trim();
  }

  snapshot(): TerminalChunk[] {
    return this.chunks.slice();
  }

  snapshotTimes(): Array<number | null> {
    return this.lineTimes.slice();
  }

  // Drops lines from the front, with their times, until the buffer is back
  // within maxBytes. A front chunk that only partly needs to go is cut just
  // after a line feed (LF is never part of a UTF-8 sequence or an escape
  // sequence's parameters, so the rest replays cleanly); one with no line
  // feed late enough to cut at goes whole.
  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const front = this.chunks[0];
      const size = byteLength(front);
      const excess = this.bytes - this.maxBytes;
      const bytes = typeof front === "string" ? Buffer.from(front, "utf8") : front;
      // The first LF that, cut after, drops at least `excess` bytes.
      const cut = size > excess ? bytes.indexOf(0x0a, excess - 1) + 1 : 0;
      if (cut === 0 || cut === size) {
        this.chunks.shift();
        this.bytes -= size;
        this.lineTimes.splice(0, countLineFeeds(front));
      } else {
        this.chunks[0] = bytes.slice(cut); // a copy, so the dropped part can be freed
        this.bytes -= cut;
        this.lineTimes.splice(0, countLineFeeds(bytes.subarray(0, cut)));
      }
    }
  }
}
