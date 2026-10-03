export type TerminalChunk = string | Uint8Array;

function byteLength(data: TerminalChunk): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
}

// In-memory replay buffer so a window's scrollback survives a renderer
// reload/crash. Keeps the most recent chunks up to `maxBytes`, dropping whole
// chunks from the front. Not persisted itself; the persistent record is the
// session log (see session-log.ts), whose tail is loaded in here on connect.
export class ScrollbackBuffer {
  private chunks: TerminalChunk[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(data: TerminalChunk): void {
    this.chunks.push(data);
    this.bytes += byteLength(data);
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      this.bytes -= byteLength(this.chunks.shift() as TerminalChunk);
    }
  }

  // Replaces the contents, e.g. with a log's history when a window connects.
  reset(chunks: TerminalChunk[]): void {
    this.chunks = [];
    this.bytes = 0;
    for (const chunk of chunks) this.append(chunk);
  }

  snapshot(): TerminalChunk[] {
    return this.chunks.slice();
  }
}
