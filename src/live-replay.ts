import type { ScrollbackReplay } from "./scrollback-buffer";

export type LiveEvent =
  | { kind: "data"; data: string | Uint8Array; time: number | null; seq: number }
  | { kind: "reset"; replay: ScrollbackReplay }
  // The server's Pueblo greeting no longer counts (see PuebloParser.detecting).
  | { kind: "greetingClosed"; seq: number };

function seqOf(event: LiveEvent): number {
  return event.kind === "reset" ? event.replay.seq : event.seq;
}

// Merges a window's initial scrollback replay with its live output. The replay
// is fetched over a different IPC path from the live messages, so it can land
// in the middle of them, already containing some of the live messages still
// to come. Live events are held until the replay arrives; after that, any
// event numbered at or below the replay's sequence number is already in it
// and is dropped. TerminalWindow numbers every write and reset it sends.
export class LiveReplay {
  private held: LiveEvent[] | null = [];
  private replayedThrough = 0;

  constructor(
    private readonly onReplay: (replay: ScrollbackReplay) => void,
    private readonly onEvent: (event: LiveEvent) => void,
  ) {}

  // A live write or reset, in the order it was received.
  receive(event: LiveEvent): void {
    if (this.held) this.held.push(event);
    else this.apply(event);
  }

  // The initial replay. Writes it, then whatever held events it doesn't cover.
  replay(replay: ScrollbackReplay): void {
    this.onReplay(replay);
    this.replayedThrough = replay.seq;
    const held = this.held ?? [];
    this.held = null;
    for (const event of held) this.apply(event);
  }

  private apply(event: LiveEvent): void {
    if (seqOf(event) <= this.replayedThrough) return;
    this.onEvent(event);
  }
}
