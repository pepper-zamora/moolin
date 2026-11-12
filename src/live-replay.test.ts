import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveReplay, type LiveEvent } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";

function recorder(): { live: LiveReplay; shown: string[] } {
  const shown: string[] = [];
  const live = new LiveReplay(
    (replay) => shown.push(`replay:${replay.chunks.join("")}`),
    (event) =>
      shown.push(
        event.kind === "data"
          ? `data:${event.data}`
          : event.kind === "reset"
            ? `reset:${event.replay.chunks.join("")}`
            : "greeting-closed",
      ),
  );
  return { live, shown };
}

const data = (text: string, seq: number): LiveEvent => ({ kind: "data", data: text, time: null, seq });
const replay = (chunks: string[], seq: number): ScrollbackReplay => ({
  fromLog: false,
  before: null,
  chunks,
  times: [],
  seq,
  pueblo: false,
  greetingOpen: true,
});

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

test("a greeting closing is ordered with the data like any other live event", () => {
  const { live, shown } = recorder();
  live.receive({ kind: "greetingClosed", seq: 2 });
  live.receive({ kind: "greetingClosed", seq: 4 });
  live.replay(replay(["a", "b"], 3));
  assert.deepEqual(shown, ["replay:ab", "greeting-closed"]);
});

test("holding live events again lets a replay start over without losing or repeating any", () => {
  const { live, shown } = recorder();
  live.replay(replay(["old"], 1));
  live.receive(data("a", 2));
  live.hold();
  live.receive(data("b", 3)); // in the replay fetched next
  live.receive(data("c", 4)); // not in it
  live.replay(replay(["old a b"], 3));
  assert.deepEqual(shown, ["replay:old", "data:a", "replay:old a b", "data:c"]);
});

test("held events are let through when the replay could not be fetched", () => {
  const { live, shown } = recorder();
  live.replay(replay(["old"], 1));
  live.hold();
  live.receive(data("a", 2));
  assert.deepEqual(shown, ["replay:old"]);
  live.resume();
  live.receive(data("b", 3));
  assert.deepEqual(shown, ["replay:old", "data:a", "data:b"]);
});

test("catching up writes the history, then only the held events it doesn't cover", () => {
  const { live, shown } = recorder();
  live.replay(replay(["old"], 1));
  live.hold();
  live.receive(data("a", 2)); // in the history caught up with
  live.receive(data("b", 3)); // not in it
  assert.equal(
    live.catchUp(2, () => shown.push("caught-up")),
    true,
  );
  live.receive(data("c", 4));
  assert.deepEqual(shown, ["replay:old", "caught-up", "data:b", "data:c"]);
});

test("a reset held while catching up wins, and the history is not written", () => {
  const { live, shown } = recorder();
  live.replay(replay(["old"], 1));
  live.hold();
  live.receive({ kind: "reset", replay: replay(["new"], 2) });
  live.receive(data("after", 3));
  assert.equal(
    live.catchUp(3, () => shown.push("caught-up")),
    false,
  );
  assert.deepEqual(shown, ["replay:old", "reset:new", "data:after"]);
});
