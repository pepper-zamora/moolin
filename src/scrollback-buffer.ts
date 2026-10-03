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
// reload/crash. Keeps the most recent chunks up to `maxBytes`, dropping whole
// chunks from the front. Not persisted itself; the persistent record is the
// session log (see session-log.ts), whose tail is loaded in here on connect.
export class ScrollbackBuffer {
  private chunks: TerminalChunk[] = [];
  private bytes = 0;
  // One entry per line feed currently in the buffer, in order: the time that
  // line arrived, or null if unknown. Adding an entry per line feed on append
  // and dropping a dropped chunk's worth off the front keeps it aligned with
  // exactly the line feeds a replay will feed to xterm — whose onLineFeed
  // fires once for each (see line-feeds.ts) and never on wrap, so the
  // renderer can consume these in lockstep to re-stamp each line.
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

  // Drops whole chunks from the front, with their line times, until the
  // buffer is back within maxBytes.
  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift() as TerminalChunk;
      this.bytes -= byteLength(dropped);
      this.lineTimes.splice(0, countLineFeeds(dropped));
    }
  }
}
