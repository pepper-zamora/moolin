import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveReplay, type LiveEvent } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";

function recorder(): { live: LiveReplay; shown: string[] } {
  const shown: string[] = [];
  const live = new LiveReplay(
    (replay) => shown.push(`replay:${replay.chunks.join("")}`),
    (event) => shown.push(event.kind === "data" ? `data:${event.data}` : `reset:${event.replay.chunks.join("")}`),
  );
  return { live, shown };
}

const data = (text: string, seq: number): LiveEvent => ({ kind: "data", data: text, time: null, seq });
const replay = (chunks: string[], seq: number): ScrollbackReplay => ({ chunks, times: [], seq, pueblo: false });

test("a replay landing mid-stream doesn't repeat the live messages it already contains", () => {
  // The bug: the replay (taken after all three writes) arrives after the
  // first live message but before the other two.
  const { live, shown } = recorder();
  live.receive(data("TLS", 3));
  live.replay(replay(["warn", "connecting", "TLS", "cert", "connected"], 5));
  live.receive(data("cert", 4));
  live.receive(data("connected", 5));
  live.receive(data("Welcome", 6));
  assert.deepEqual(shown, ["replay:warnconnectingTLScertconnected", "data:Welcome"]);
});

test("live messages held before an older replay are written after it", () => {
  const { live, shown } = recorder();
  live.receive(data("a", 1));
  live.receive(data("b", 2));
  live.replay(replay(["a"], 1));
  assert.deepEqual(shown, ["replay:a", "data:b"]);
});

test("a reset the replay already reflects is dropped; a later one is applied", () => {
  const { live, shown } = recorder();
  live.receive({ kind: "reset", replay: replay(["log"], 1) });
  live.receive(data("x", 2));
  live.replay(replay(["log", "x"], 2));
  live.receive({ kind: "reset", replay: replay(["other"], 3) });
  assert.deepEqual(shown, ["replay:logx", "reset:other"]);
});
