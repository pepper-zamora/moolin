import type { Style } from "./ansi-parser";
import type { PuebloLink } from "./pueblo";

export interface Run {
  text: string;
  style: Style;
  // The Pueblo link the text belongs to, if any.
  link: PuebloLink | null;
}

// What the builder is fed: the parsers' output, in order.
export type BuilderToken =
  | { kind: "text"; text: string; style: Style; link?: PuebloLink | null }
  // A line feed byte: ends the line, taking the next arrival time.
  | { kind: "newline" }
  // A break with no line feed byte behind it (Pueblo's <br>): ends the line
  // without a time, which a swallowed line feed after it may supply.
  | { kind: "break" }
  // A line feed byte that makes no break (swallowed after a <br>, say). It
  // still takes its arrival time, which goes to the line the <br> ended when
  // `afterBreak`.
  | { kind: "skip"; afterBreak: boolean };

// A line of scrollback: what the DOM view draws, and what search reads.
export interface Line {
  // Unique and increasing along the lines (history added in front takes ids
  // below the rest), so a line can be told apart from any other even after the
  // ones before it are trimmed.
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
  // Set when trimmed away, so a line dropped before it was drawn never is.
  dropped?: boolean;
  // A blank line of Clear Screen's, which only the window has: the log doesn't.
  filler?: boolean;
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
  // The line the last "break" ended, while it still has no time.
  private lastBreak: Line | null = null;
  private nextId = 1;
  // The id before the oldest line's, for lines added in front (see prepend).
  private oldestId = 0;

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
  feed(tokens: ReadonlyArray<BuilderToken>, nextTime: () => number | null): boolean {
    for (const token of tokens) {
      if (token.kind === "newline") this.lineFeed(nextTime());
      else if (token.kind === "break") this.lineBreak();
      else if (token.kind === "skip") this.skip(nextTime(), token.afterBreak);
      else this.text(token.text, token.style, token.link ?? null);
    }
    return tokens.length > 0;
  }

  // `count` line feeds that carry no time (Clear Screen's filler).
  blankLines(count: number): void {
    for (let i = 0; i < count; i++) {
      const created = this.open === null;
      this.lineFeed(null);
      if (created) (this.lines[this.lines.length - 1] as Line).filler = true;
    }
  }

  private newLine(): Line {
    const line: Line = { id: this.nextId++, time: null, text: "", runs: [] };
    this.lines.push(line);
    return line;
  }

  private touch(line: Line): void {
    if (this.dirty[this.dirty.length - 1] !== line) this.dirty.push(line);
  }

  private text(text: string, style: Style, link: PuebloLink | null): void {
    let rest = text;
    while (rest.length > 0) {
      if (!this.open) this.open = this.newLine();
      const line = this.open;
      const room = MAX_LINE_LENGTH - line.text.length;
      const part = rest.length > room ? rest.slice(0, room) : rest;
      rest = rest.slice(part.length);
      const runs = line.runs as Run[];
      const last = runs[runs.length - 1];
      if (last && last.style.key === style.key && last.link === link) last.text += part;
      else runs.push({ text: part, style, link });
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
    this.lastBreak = null;
  }

  private lineBreak(): void {
    const line = this.open ?? this.newLine();
    this.touch(line);
    this.open = null;
    this.lastBreak = line;
  }

  private skip(time: number | null, afterBreak: boolean): void {
    if (!afterBreak || !this.lastBreak || this.lastBreak.time !== null) return;
    this.lastBreak.time = time;
    this.touch(this.lastBreak);
    this.lastBreak = null;
  }

  // The lines to redraw, in order; the next call returns only newer changes.
  takeDirty(): Line[] {
    const dirty = this.dirty;
    this.dirty = [];
    return dirty;
  }

  // Puts older lines, made by another builder, in front of the ones held. They
  // get ids below every other line's, still increasing along the lines, and
  // stay as they are: not open, and not due to be redrawn.
  prepend(older: ReadonlyArray<Line>): void {
    for (let i = older.length - 1; i >= 0; i--) (older[i] as { id: number }).id = --this.oldestId;
    this.lines = [...older, ...this.lines];
  }

  // Puts newer lines, made by another builder, after the ones held, which must
  // end with a finished line (see dropBack). They get ids above every other
  // line's, and stay as they are: not open, and not due to be redrawn.
  append(newer: ReadonlyArray<Line>): void {
    for (const line of newer) (line as { id: number }).id = this.nextId++;
    for (const line of newer) this.lines.push(line);
  }

  // Drops the newest `count` lines, returning them, and with them the open line:
  // what is added next starts a line of its own.
  dropBack(count: number): Line[] {
    const dropped = this.lines.splice(Math.max(0, this.lines.length - count), count);
    for (const line of dropped) line.dropped = true;
    this.open = null;
    this.lastBreak = null;
    return dropped;
  }

  // Drops the oldest `count` lines, returning them.
  dropFront(count: number): Line[] {
    const dropped = this.lines.splice(0, count);
    for (const line of dropped) line.dropped = true;
    if (this.open && dropped.includes(this.open)) this.open = null;
    return dropped;
  }

  // Starts over (a reconnect or a world switch): no lines and no open line.
  clear(): void {
    this.lines = [];
    this.dirty = [];
    this.open = null;
    this.lastBreak = null;
  }
}
