import type { Style, Token } from "./ansi-parser";

export interface Run {
  text: string;
  style: Style;
}

// A line of scrollback: what the DOM view draws, and what search reads.
export interface Line {
  // Unique and increasing for the life of the builder, so a line can be told
  // apart from any other even after the ones before it are trimmed.
  readonly id: number;
  // When the line arrived (epoch ms), or null for Moolin's own lines and
  // history with no recorded time. Set when the line is closed, as the
  // timestamp gutter has always done: an unfinished prompt carries none yet.
  time: number | null;
  // The line's text without styling.
  text: string;
  // The styled runs, dropped once the line is closed and drawn.
  runs: Run[] | null;
  // Set by the view once drawn.
  el?: HTMLElement;
}

// A line that grows without a line feed (a stuck server, a binary dump) is cut
// here so redrawing the open line stays cheap.
export const MAX_LINE_LENGTH = 16384;

// Turns parser tokens into lines, one per line feed. Pure: no DOM.
export class LineBuilder {
  lines: Line[] = [];
  // Lines that changed since the last takeDirty(), oldest first.
  private dirty: Line[] = [];
  private open: Line | null = null;
  private nextId = 1;

  // How many lines have changed since the last takeDirty().
  get dirtyCount(): number {
    return this.dirty.length;
  }

  // The unfinished last line, if any.
  get openLine(): Line | null {
    return this.open;
  }

  // Adds tokens, taking each line feed's time from `nextTime`. Returns whether
  // anything was added (the view un-clears the screen on new output).
  feed(tokens: Token[], nextTime: () => number | null): boolean {
    for (const token of tokens) {
      if (token.kind === "newline") this.lineFeed(nextTime());
      else this.text(token.text, token.style);
    }
    return tokens.length > 0;
  }

  // `count` line feeds that carry no time (Clear Screen's filler).
  blankLines(count: number): void {
    for (let i = 0; i < count; i++) this.lineFeed(null);
  }

  private newLine(): Line {
    const line: Line = { id: this.nextId++, time: null, text: "", runs: [] };
    this.lines.push(line);
    return line;
  }

  private touch(line: Line): void {
    if (this.dirty[this.dirty.length - 1] !== line) this.dirty.push(line);
  }

  private text(text: string, style: Style): void {
    let rest = text;
    while (rest.length > 0) {
      if (!this.open) this.open = this.newLine();
      const line = this.open;
      const room = MAX_LINE_LENGTH - line.text.length;
      const part = rest.length > room ? rest.slice(0, room) : rest;
      rest = rest.slice(part.length);
      const runs = line.runs as Run[];
      const last = runs[runs.length - 1];
      if (last && last.style.key === style.key) last.text += part;
      else runs.push({ text: part, style });
      line.text += part;
      this.touch(line);
      if (line.text.length >= MAX_LINE_LENGTH) this.open = null;
    }
  }

  private lineFeed(time: number | null): void {
    const line = this.open ?? this.newLine();
    line.time = time;
    this.touch(line);
    this.open = null;
  }

  // The lines to redraw, in order; the next call returns only newer changes.
  takeDirty(): Line[] {
    const dirty = this.dirty;
    this.dirty = [];
    return dirty;
  }

  // Drops the oldest `count` lines, returning them.
  dropFront(count: number): Line[] {
    const dropped = this.lines.splice(0, count);
    if (this.open && dropped.includes(this.open)) this.open = null;
    return dropped;
  }

  // Starts over (a reconnect or a world switch): no lines and no open line.
  clear(): void {
    this.lines = [];
    this.dirty = [];
    this.open = null;
  }
}
