import { AnsiParser } from "./ansi-parser";
import { type BuilderToken, type Line, LineBuilder } from "./line-builder";
import { splitAtLineFeeds } from "./line-feeds";
import { type PuebloLink, PuebloParser, type PuebloToken, hasGreeting } from "./pueblo";

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
//
// Text goes through two parsers in turn: Pueblo's tags (once the connection is
// in that mode), then ANSI sequences. Moolin's own lines (echoed commands,
// status messages) are told apart from the server's by having no arrival
// time, and are never read as Pueblo, so a command echoed with a "<" in it is
// shown as typed. (Old history with no recorded time is treated the same way.)
export class LineStream {
  private readonly parser = new AnsiParser();
  private readonly pueblo: PuebloParser;
  private readonly builder = new LineBuilder();
  private readonly decoder = new TextDecoder();
  // The Pueblo link the text being added is inside, if any.
  private link: PuebloLink | null = null;
  // Clear Screen's blank filler is the last thing added.
  private cleared = false;
  // How many blank lines clear the screen; the view keeps this current.
  screenRows = 24;
  // The server asked to clear the screen, which waits for something to show on
  // the clean screen, so a clear with nothing after it doesn't blank the
  // screen for no reason. (Penultimate Destination sends one at the end of its
  // login output, so what was shown scrolls away when the next output
  // arrives; see TODO.md.)
  private clearPending = false;

  // `log` is told what the stream decides that could explain odd output (Pueblo
  // turning on, a server's clear, tags it doesn't act on).
  constructor(private readonly log: (message: string) => void = () => {}) {
    this.pueblo = new PuebloParser((message) => this.log(`pueblo: ${message}`));
  }

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
  // (null where unknown; fewer than there are line feeds is fine). `pueblo` is
  // whether the connection is in Pueblo mode once the history ends.
  replay(chunks: ReadonlyArray<string | Uint8Array>, times: ReadonlyArray<number | null>, pueblo = false): void {
    // The mode at the start: already on, unless the greeting that turns it on
    // is in the history itself.
    const decoder = new TextDecoder();
    const greeted =
      pueblo && chunks.some((chunk) => hasGreeting(typeof chunk === "string" ? chunk : decoder.decode(chunk)));
    this.pueblo.setEnabled(pueblo && !greeted);
    this.link = null;
    const source = listedTimes(times);
    for (const chunk of chunks) this.ingest(chunk, source);
    this.pueblo.setEnabled(pueblo);
    this.link = null;
  }

  private ingest(data: string | Uint8Array, source: TimeSource): void {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    if (text === "") return;
    if (!this.pueblo.enabled && !this.pueblo.wouldEnable(text)) {
      // The common case: not Pueblo, and nothing to switch it on.
      if (source.peek() !== null) this.pueblo.noteText(text);
      this.addText(text, source, null);
      return;
    }
    // Pueblo mode: a line at a time, since whether a line is the server's or
    // Moolin's is known per line feed.
    for (const line of splitAtLineFeeds(text)) {
      if (source.peek() === null) {
        this.addText(line, source, null);
        continue;
      }
      for (const token of this.pueblo.parse(line)) this.addPueblo(token, source);
    }
  }

  private addPueblo(token: PuebloToken, source: TimeSource): void {
    switch (token.kind) {
      case "text":
        this.addText(token.text, source, this.link, true);
        break;
      case "break":
        this.addTokens([{ kind: "break" }], source);
        this.link = null;
        break;
      case "skip":
        this.addTokens([{ kind: "skip", afterBreak: token.afterBreak }], source);
        break;
      case "link":
        this.link = token.link;
        break;
      case "clear":
        this.clearPending = true;
        this.log("pueblo: the server asked to clear the screen; it will when more output follows");
        break;
    }
  }

  private addText(text: string, source: TimeSource, link: PuebloLink | null, fromServer = false): void {
    const tokens = this.parser.parse(text);
    // Blank lines and line feeds don't count as something to show.
    if (fromServer && this.clearPending && tokens.some((t) => t.kind === "text" && /\S/.test(t.text))) {
      this.clearPending = false;
      this.log(
        this.blankScreen()
          ? `pueblo: cleared the screen for the server (${this.screenRows} blank lines added)`
          : "pueblo: the server's clear found the screen already clear",
      );
    }
    this.addTokens(link ? tokens.map((t) => (t.kind === "text" ? { ...t, link } : t)) : tokens, source);
    // A link ends with its line.
    if (this.link && /[\n\v\f]$/.test(text)) this.link = null;
  }

  private addTokens(tokens: ReadonlyArray<BuilderToken>, source: TimeSource): void {
    if (this.builder.feed(tokens, () => source.next())) this.cleared = false;
  }

  // Starts over: no lines, no half-received escape sequence or style, and no
  // Pueblo mode.
  reset(): void {
    this.parser.reset();
    this.pueblo.reset();
    this.link = null;
    this.clearPending = false;
    this.builder.clear();
    this.cleared = false;
  }

  // Clear Screen, and a Pueblo server's own clear: adds `rows` blank lines,
  // which scroll everything before them out of view without removing it. The
  // blanks are ordinary lines (without a time), so once cleared another call
  // does nothing rather than stacking more on top; any new output un-clears.
  // Returns whether it added them.
  blankScreen(rows = this.screenRows): boolean {
    if (this.cleared) return false;
    this.builder.blankLines(Math.max(1, rows));
    this.cleared = true;
    return true;
  }
}
