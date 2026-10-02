import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelnetParser,
  escapeIac,
  encodeNegotiation,
  encodeSub,
  MAX_SUB_LENGTH,
  IAC,
  DO,
  DONT,
  WILL,
  WONT,
  SB,
  SE,
  type TelnetEvent,
} from "./telnet-protocol";

const GA = 249;

// Events with Buffers turned into strings, so assertions read naturally.
function describe(events: TelnetEvent[]): unknown[] {
  return events.map((event) => {
    if (event.type === "data") return { data: event.data.toString("latin1") };
    if (event.type === "sub") return { sub: event.option, data: [...event.data] };
    return event;
  });
}

function parse(...chunks: number[][]): unknown[] {
  const parser = new TelnetParser();
  return describe(chunks.flatMap((chunk) => parser.parse(Buffer.from(chunk))));
}

const bytes = (text: string): number[] => [...Buffer.from(text, "latin1")];

test("plain data passes through unchanged", () => {
  assert.deepEqual(parse(bytes("hello\r\n")), [{ data: "hello\r\n" }]);
});

test("IAC IAC is an escaped literal 255", () => {
  assert.deepEqual(parse([65, IAC, IAC, 66]), [{ data: "A\xffB" }]);
});

test("each negotiation verb is reported with its option", () => {
  assert.deepEqual(parse([IAC, DO, 31, IAC, DONT, 1, IAC, WILL, 3, IAC, WONT, 24]), [
    { type: "negotiation", verb: "do", option: 31 },
    { type: "negotiation", verb: "dont", option: 1 },
    { type: "negotiation", verb: "will", option: 3 },
    { type: "negotiation", verb: "wont", option: 24 },
  ]);
});

test("commands keep their position relative to the surrounding text", () => {
  assert.deepEqual(parse([...bytes("Password: "), IAC, WILL, 1, ...bytes("x"), IAC, GA]), [
    { data: "Password: " },
    { type: "negotiation", verb: "will", option: 1 },
    { data: "x" },
    { type: "command", command: GA },
  ]);
});

test("subnegotiation payloads are collected, with IAC IAC unescaped", () => {
  assert.deepEqual(parse([IAC, SB, 24, 1, IAC, IAC, 2, IAC, SE, ...bytes("ok")]), [
    { sub: 24, data: [1, IAC, 2] },
    { data: "ok" },
  ]);
});

test("sequences split across chunks at every possible point parse the same", () => {
  const stream = [...bytes("ab"), IAC, IAC, IAC, WILL, 1, IAC, SB, 24, 1, IAC, IAC, IAC, SE, ...bytes("cd"), IAC, GA];
  const whole = parse(stream);
  for (let split = 1; split < stream.length; split++) {
    const parsed = parse(stream.slice(0, split), stream.slice(split));
    // A split can break one data run into two; merge adjacent runs to compare.
    const merged: unknown[] = [];
    const isText = (event: unknown): event is { data: string } =>
      typeof (event as { data?: unknown } | undefined)?.data === "string";
    for (const event of parsed) {
      const last = merged[merged.length - 1];
      if (isText(event) && isText(last)) last.data += event.data;
      else merged.push(isText(event) ? { ...event } : event);
    }
    assert.deepEqual(merged, whole, `split at ${split}`);
  }
});

test("a subnegotiation missing its IAC SE is abandoned at the next command", () => {
  assert.deepEqual(parse([IAC, SB, 24, 1, 2, IAC, WILL, 1, ...bytes("after")]), [
    { type: "negotiation", verb: "will", option: 1 },
    { data: "after" },
  ]);
});

test("an oversized subnegotiation is dropped without affecting what follows", () => {
  const payload = new Array(MAX_SUB_LENGTH + 10).fill(7);
  assert.deepEqual(parse([IAC, SB, 201, ...payload, IAC, SE, ...bytes("ok")]), [{ data: "ok" }]);
});

test("escapeIac doubles IAC bytes and nothing else", () => {
  assert.deepEqual([...escapeIac(Buffer.from([1, IAC, 2]))], [1, IAC, IAC, 2]);
});

test("encodeNegotiation and encodeSub produce wire-format commands", () => {
  assert.deepEqual([...encodeNegotiation("will", 31)], [IAC, WILL, 31]);
  assert.deepEqual([...encodeSub(31, Buffer.from([0, 80, 0, IAC]))], [IAC, SB, 31, 0, 80, 0, IAC, IAC, IAC, SE]);
});

test("encoded output round-trips through the parser", () => {
  const wire = Buffer.concat([encodeSub(24, Buffer.from([0, IAC, 9])), escapeIac(Buffer.from([IAC, 65]))]);
  assert.deepEqual(parse([...wire]), [{ sub: 24, data: [0, IAC, 9] }, { data: "\xffA" }]);
});
