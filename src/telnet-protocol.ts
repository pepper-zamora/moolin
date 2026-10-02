// Byte-level telnet protocol (RFC 854/855): splits the incoming stream into
// display data and telnet commands, and encodes outgoing commands. Pure —
// no sockets — so TelnetSession owns the I/O and this stays unit-testable.

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

export type NegotiationVerb = "do" | "dont" | "will" | "wont";

export type TelnetEvent =
  | { type: "data"; data: Buffer }
  // A two-byte IAC command other than negotiation/subnegotiation (GA, NOP, ...).
  | { type: "command"; command: number }
  | { type: "negotiation"; verb: NegotiationVerb; option: number }
  | { type: "sub"; option: number; data: Buffer };

const VERBS: Record<number, NegotiationVerb> = { [DO]: "do", [DONT]: "dont", [WILL]: "will", [WONT]: "wont" };
const VERB_BYTES: Record<NegotiationVerb, number> = { do: DO, dont: DONT, will: WILL, wont: WONT };

// A subnegotiation longer than this is almost certainly a broken or hostile
// server; its payload is discarded rather than buffered without bound.
export const MAX_SUB_LENGTH = 64 * 1024;

const enum State {
  Data,
  Iac,
  Option,
  SubOption,
  Sub,
  SubIac,
}

export class TelnetParser {
  private state = State.Data;
  private verb: NegotiationVerb = "do";
  private subOption = 0;
  private subBytes: number[] = [];
  private subOverflowed = false;
  // Display bytes not yet emitted as a "data" event.
  private text: number[] = [];

  // State carries over between calls, so a command split across two TCP
  // reads is handled. Events come back in stream order: a command's position
  // relative to the surrounding text is preserved.
  parse(chunk: Uint8Array): TelnetEvent[] {
    const events: TelnetEvent[] = [];

    for (const byte of chunk) {
      switch (this.state) {
        case State.Data:
          if (byte === IAC) this.state = State.Iac;
          else this.text.push(byte);
          break;

        case State.Iac:
          this.handleCommandByte(byte, events);
          break;

        case State.Option:
          this.flushText(events);
          events.push({ type: "negotiation", verb: this.verb, option: byte });
          this.state = State.Data;
          break;

        case State.SubOption:
          this.subOption = byte;
          this.subBytes = [];
          this.subOverflowed = false;
          this.state = State.Sub;
          break;

        case State.Sub:
          if (byte === IAC) this.state = State.SubIac;
          else this.pushSubByte(byte);
          break;

        case State.SubIac:
          if (byte === IAC) {
            this.pushSubByte(IAC);
            this.state = State.Sub;
          } else if (byte === SE) {
            this.flushText(events);
            if (!this.subOverflowed) {
              events.push({ type: "sub", option: this.subOption, data: Buffer.from(this.subBytes) });
            }
            this.subBytes = [];
            this.state = State.Data;
          } else {
            // IAC followed by anything but IAC/SE inside a subnegotiation is a
            // protocol error. Abandon the subnegotiation and treat the byte as
            // an ordinary command, so a server that forgot its IAC SE can't
            // swallow everything after it.
            this.subBytes = [];
            this.handleCommandByte(byte, events);
          }
          break;
      }
    }

    this.flushText(events);
    return events;
  }

  private flushText(events: TelnetEvent[]): void {
    if (this.text.length > 0) {
      events.push({ type: "data", data: Buffer.from(this.text) });
      this.text = [];
    }
  }

  private handleCommandByte(byte: number, events: TelnetEvent[]): void {
    if (byte === IAC) {
      this.text.push(IAC); // IAC IAC is an escaped literal 255 data byte
      this.state = State.Data;
    } else if (byte in VERBS) {
      this.verb = VERBS[byte];
      this.state = State.Option;
    } else if (byte === SB) {
      this.state = State.SubOption;
    } else {
      this.flushText(events);
      events.push({ type: "command", command: byte });
      this.state = State.Data;
    }
  }

  private pushSubByte(byte: number): void {
    if (this.subOverflowed) return;
    if (this.subBytes.length >= MAX_SUB_LENGTH) {
      this.subOverflowed = true;
      this.subBytes = [];
      return;
    }
    this.subBytes.push(byte);
  }
}

// Doubles every IAC byte so outgoing data can't be misread as a command.
export function escapeIac(data: Uint8Array): Buffer {
  const out: number[] = [];
  for (const byte of data) {
    out.push(byte);
    if (byte === IAC) out.push(IAC);
  }
  return Buffer.from(out);
}

export function encodeNegotiation(verb: NegotiationVerb, option: number): Buffer {
  return Buffer.from([IAC, VERB_BYTES[verb], option]);
}

export function encodeSub(option: number, data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([IAC, SB, option]), escapeIac(data), Buffer.from([IAC, SE])]);
}
