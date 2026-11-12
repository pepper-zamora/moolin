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

  // Holds live events again, for a replay that is about to be fetched to start
  // over from (see replay).
  hold(): void {
    this.held ??= [];
  }

  // Lets held events through without a replay, when fetching one failed.
  resume(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const event of held) this.apply(event);
  }

  // A replay: the initial one, or one that starts over. Writes it, then
  // whatever held events it doesn't cover.
  replay(replay: ScrollbackReplay): void {
    this.onReplay(replay);
    this.replayedThrough = replay.seq;
    const held = this.held ?? [];
    this.held = null;
    for (const event of held) this.apply(event);
  }

  // Goes on from history that leads up to live output and covers the live events
  // up to `seq`: writes it, then whatever held events it doesn't cover. Unless a
  // reset was held, which replaces everything anyway: then the history isn't
  // written, the held events are let through, and this returns false.
  catchUp(seq: number, write: () => void): boolean {
    const held = this.held ?? [];
    this.held = null;
    const reset = held.some((event) => event.kind === "reset");
    if (!reset) {
      write();
      this.replayedThrough = Math.max(this.replayedThrough, seq);
    }
    for (const event of held) this.apply(event);
    return !reset;
  }

  private apply(event: LiveEvent): void {
    if (seqOf(event) <= this.replayedThrough) return;
    this.onEvent(event);
  }
}
