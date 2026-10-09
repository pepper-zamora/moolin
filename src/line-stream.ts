import { AnsiParser } from "./ansi-parser";
import { type Line, LineBuilder } from "./line-builder";

// Where arrival times come from as line feeds are met: one per line feed.
export interface TimeSource {
  // The time the next line feed will take, without taking it.
  peek(): number | null;
  next(): number | null;
}

export function constantTime(time: number | null): TimeSource {
  return { peek: () => time, next: () => time };
}

export function listedTimes(times: ReadonlyArray<number | null>): TimeSource {
  let at = 0;
  return { peek: () => times[at] ?? null, next: () => times[at++] ?? null };
}

// What the scrollback shows, as lines, from what the server (and Moolin)
// wrote: bytes or text in, lines with their arrival times out. Pure, with no
// DOM, so the whole pipeline can be tested; ScrollbackView only draws it.
export class LineStream {
  private readonly parser = new AnsiParser();
  private readonly builder = new LineBuilder();
  private readonly decoder = new TextDecoder();
  // Clear Screen's blank filler is the last thing added.
  private cleared = false;

  get lines(): ReadonlyArray<Line> {
    return this.builder.lines;
  }

  // The unfinished last line, if any.
  get openLine(): Line | null {
    return this.builder.openLine;
  }

  get dirtyCount(): number {
    return this.builder.dirtyCount;
  }

  // The lines changed since the last call, oldest first.
  takeDirty(): Line[] {
    return this.builder.takeDirty();
  }

  dropFront(count: number): Line[] {
    return this.builder.dropFront(count);
  }

  // Adds output. `time` is when it arrived, and becomes the time of each line
  // the data ends; null means Moolin's own output (status and echoed
  // commands), which carries no time.
  write(data: string | Uint8Array, time: number | null): void {
    this.ingest(data, constantTime(time));
  }

  // Adds history: chunks in order, with one time per line feed across them all
  // (null where unknown; fewer than there are line feeds is fine).
  replay(chunks: ReadonlyArray<string | Uint8Array>, times: ReadonlyArray<number | null>): void {
    const source = listedTimes(times);
    for (const chunk of chunks) this.ingest(chunk, source);
  }

  private ingest(data: string | Uint8Array, source: TimeSource): void {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    if (text === "") return;
    if (this.builder.feed(this.parser.parse(text), () => source.next())) this.cleared = false;
  }

  // Starts over: no lines, and no half-received escape sequence or style.
  reset(): void {
    this.parser.reset();
    this.builder.clear();
    this.cleared = false;
  }

  // Clear Screen: adds `rows` blank lines, which scroll everything before them
  // out of view without removing it. The blanks are ordinary lines (without a
  // time), so once cleared another call does nothing rather than stacking more
  // on top; any new output un-clears. Returns whether it added them.
  blankScreen(rows: number): boolean {
    if (this.cleared) return false;
    this.builder.blankLines(Math.max(1, rows));
    this.cleared = true;
    return true;
  }
}
