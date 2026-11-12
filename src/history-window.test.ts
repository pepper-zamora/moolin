import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HELD_LINES,
  PAGE_LINES,
  SCROLLBACK_LINES,
  type HistoryPage,
  type HistoryRequest,
  type LogCursor,
} from "./history-paging";
import { HistoryWindow, type HistorySource, type HistoryView } from "./history-window";
import { LiveReplay } from "./live-replay";
import type { ScrollbackReplay } from "./scrollback-buffer";

const SCREEN = 40;
const decoder = new TextDecoder();
const linesOf = (chunks: ReadonlyArray<Uint8Array | string>): string[] =>
  chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk)))
    .join("")
    .split("\n")
    .slice(0, -1);
const bytes = (lines: string[]): Uint8Array => new TextEncoder().encode(lines.map((line) => `${line}\n`).join(""));

// A scrollback of whole lines, a screen of SCREEN lines tall, scrolled to `top`.
class FakeView implements HistoryView {
  lines: string[] = [];
  top = 0;
  trimming = true;
  hasTrimmed = false;
  // Told whenever lines change, as ScrollbackView's change listeners are.
  onChange: () => void = () => {};

  get lineCount(): number {
    return this.lines.length;
  }
  setTrimming(trimming: boolean): void {
    this.trimming = trimming;
  }
  nearTop(): boolean {
    return this.top < SCREEN;
  }
  nearBottom(): boolean {
    return this.lines.length - this.top - SCREEN < SCREEN;
  }
  settledAtBottom(): boolean {
    return this.top + SCREEN >= this.lines.length && this.lines.length >= 2 * SCREEN;
  }
  linesNearView(): { first: number; last: number } {
    return { first: Math.max(0, this.top - SCREEN), last: Math.min(this.lines.length - 1, this.top + 2 * SCREEN) };
  }
  prepend(chunks: ReadonlyArray<Uint8Array>): number {
    const lines = linesOf(chunks);
    this.lines.unshift(...lines);
    this.top += lines.length;
    this.onChange();
    return lines.length;
  }
  append(chunks: ReadonlyArray<Uint8Array>): number {
    const lines = linesOf(chunks);
    this.lines.push(...lines);
    this.onChange();
    return lines.length;
  }
  catchUp(chunks: ReadonlyArray<Uint8Array>): void {
    this.lines.push(...linesOf(chunks));
    this.onChange();
  }
  dropFront(count: number): void {
    this.lines.splice(0, count);
    this.top = Math.max(0, this.top - count);
    this.onChange();
  }
  dropBack(count: number): void {
    this.lines.splice(this.lines.length - count, count);
    this.onChange();
  }
  distanceFromBottom(): number {
    return this.lines.length - this.top;
  }
  scrollToDistanceFromBottom(distance: number): void {
    this.top = Math.max(0, this.lines.length - distance);
  }
  scrollToBottom(): void {
    this.top = Math.max(0, this.lines.length - SCREEN);
  }
  isAtBottom(): boolean {
    return this.top + SCREEN >= this.lines.length;
  }
  scrollTop(): number {
    return this.top;
  }
  showHistory(chunks: ReadonlyArray<Uint8Array>): number {
    this.lines = linesOf(chunks);
    this.top = 0;
    this.hasTrimmed = false;
    this.onChange();
    return this.lines.length;
  }
  scrollTo(top: number): void {
    this.top = Math.max(0, Math.min(top, this.lines.length - SCREEN));
  }
  // What ScrollbackView does with a replay and live output.
  reset(): void {
    this.lines = [];
    this.top = 0;
    this.trimming = true;
    this.hasTrimmed = false;
  }
  write(lines: string[]): void {
    const atBottom = this.top + SCREEN >= this.lines.length;
    this.lines.push(...lines);
    // Trimmed only once a tenth over the cap, as ScrollbackView is, so it can
    // hold more lines than a replay does.
    if (this.trimming && this.lines.length > SCROLLBACK_LINES * 1.1) {
      this.hasTrimmed = true;
      this.dropFront(this.lines.length - SCROLLBACK_LINES);
    }
    if (atBottom) this.scrollToBottom();
    this.onChange();
  }
}

// A log of numbered lines and a window on it, wired up as the renderer does.
function setup(logLines: number) {
  const log = Array.from({ length: logLines }, (_, i) => `line ${i}`);
  let seq = 0;
  let stale = false;
  const cursor = (index: number): LogCursor | null => (index <= 0 ? null : { offset: index, skip: 0 });
  const source: HistorySource = {
    getScrollback: async (): Promise<ScrollbackReplay> => {
      const start = Math.max(0, log.length - SCROLLBACK_LINES);
      return {
        chunks: [bytes(log.slice(start))],
        times: [],
        seq,
        pueblo: false,
        greetingOpen: false,
        fromLog: true,
        before: cursor(start),
      };
    },
    getHistoryPage: async (request: HistoryRequest): Promise<HistoryPage> => {
      if (stale) return { chunks: [], times: [], before: null, after: null, end: null, seq: 0, stale: true };
      if ("before" in request) {
        const end = request.before.offset;
        const start = Math.max(0, end - PAGE_LINES);
        const chunks = [bytes(log.slice(start, end))];
        return {
          chunks,
          times: [],
          before: cursor(start),
          after: request.before,
          end: request.before,
          seq,
          stale: false,
        };
      }
      const start = request.after?.offset ?? 0;
      const end = Math.min(log.length, start + PAGE_LINES);
      const atEnd = end === log.length;
      const chunks = [bytes(log.slice(start, end))];
      const after = atEnd ? null : cursor(end);
      return { chunks, times: [], before: cursor(start), after, end: cursor(end), seq, stale: false };
    },
  };
  const view = new FakeView();
  const warnings: string[] = [];
  // As the renderer does with a replay, and with live output and resets.
  const replay = (replay: ScrollbackReplay): void => {
    view.reset();
    view.write(linesOf(replay.chunks));
    paging.replayed(replay);
  };
  const live: LiveReplay = new LiveReplay(replay, (event) => {
    if (event.kind === "data" && paging.showsLive) view.write(linesOf([event.data]));
    else if (event.kind === "reset") replay(event.replay);
  });
  const paging: HistoryWindow = new HistoryWindow(view, source, live, (message) => warnings.push(message));
  view.onChange = () => paging.linesAdded();
  // Output from the server: logged, then sent to the window live.
  const output = (line: string): void => {
    log.push(line);
    live.receive({ kind: "data", data: `${line}\n`, time: null, seq: ++seq });
  };
  const start = async (): Promise<void> => {
    live.replay(await source.getScrollback());
    await settle();
  };
  const scrollTo = async (top: number): Promise<void> => {
    view.scrollTo(top);
    paging.scrolled();
    await settle();
  };
  return { log, view, paging, source, live, output, start, scrollTo, warnings, makeStale: () => (stale = true) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
}

// The lines are a run of the log, in order, with none missing or repeated.
function assertRun(lines: string[], log: string[], where = ""): void {
  const first = log.indexOf(lines[0]);
  assert.ok(first !== -1, `${lines[0]} is in the log ${where}`);
  const broken = lines.findIndex((line, i) => line !== log[first + i]);
  if (broken !== -1) {
    assert.fail(`line ${broken} of ${lines.length} is ${lines[broken]}, not ${log[first + broken]} ${where}`);
  }
}

test("scrolling to the top pages older history in, and the bottom lets go of it", async () => {
  const { log, view, start, scrollTo } = setup(30000);
  await start();
  assert.equal(view.lineCount, SCROLLBACK_LINES);
  const onScreen = view.lines[0];
  await scrollTo(0);
  assert.equal(view.lineCount, SCROLLBACK_LINES + PAGE_LINES);
  assertRun(view.lines, log);
  assert.equal(view.lines[view.top], onScreen, "what was on screen stays there");
  assert.equal(view.trimming, false, "the scrollback's own cap is off while history is held");
  await scrollTo(view.lineCount);
  assert.equal(view.lineCount, SCROLLBACK_LINES);
  assert.equal(view.lines.at(-1), log.at(-1));
  assert.equal(view.trimming, true);
});

test("far back, the view holds a bounded window, lets go of live output, and pages forward to it again", async () => {
  const { log, view, paging, output, start, scrollTo } = setup(80000);
  await start();
  for (let i = 0; i < 6; i++) {
    await scrollTo(0);
    assert.ok(view.lineCount <= MAX_HELD_LINES + PAGE_LINES, `${view.lineCount} lines held`);
    assertRun(view.lines, log);
  }
  assert.equal(paging.showsLive, false, "the live lines were let go of");
  assert.equal(view.lines[0], `line ${80000 - SCROLLBACK_LINES - 6 * PAGE_LINES}`, "six pages back");
  output("said while far back");
  assert.ok(!view.lines.includes("said while far back"), "live output isn't shown while far back");
  for (let i = 0; i < 20 && !paging.showsLive; i++) {
    await scrollTo(view.lineCount);
    assert.ok(view.lineCount <= MAX_HELD_LINES + PAGE_LINES, `${view.lineCount} lines held`);
    assertRun(view.lines, log);
  }
  assert.equal(paging.showsLive, true, "paging forward reached live output");
  output("said once back");
  assertRun(view.lines, log);
  assert.equal(view.lines.at(-1), "said once back");
  assert.ok(view.lines.includes("said while far back"));
  // At the bottom, the scrollback goes back to its usual size, and can be paged
  // back from again.
  await scrollTo(view.lineCount);
  assert.ok(view.lineCount >= SCROLLBACK_LINES && view.lineCount <= SCROLLBACK_LINES + PAGE_LINES, `${view.lineCount}`);
  assert.equal(view.trimming, true);
  assertRun(view.lines, log);
  const oldest = view.lines[0];
  await scrollTo(0);
  assertRun(view.lines, log);
  assert.equal(view.lines[PAGE_LINES], oldest, "the page before the oldest line went in front of it");
});

test("live output while history is held drops it from the end away from the view", async () => {
  const { log, view, paging, output, start, scrollTo } = setup(40000);
  await start();
  await scrollTo(0);
  await scrollTo(0);
  // Reading the oldest page while a flood arrives: the live lines go, not the page.
  for (let i = 0; i < MAX_HELD_LINES; i++) output(`flood ${i}`);
  assert.equal(paging.showsLive, false);
  assert.ok(view.lineCount <= MAX_HELD_LINES);
  assertRun(view.lines, log);
});

test("a page that no longer fits the log starts over from a fresh replay, at the bottom", async () => {
  const { log, view, paging, start, scrollTo, makeStale } = setup(30000);
  await start();
  makeStale();
  await scrollTo(0);
  assert.equal(view.lineCount, SCROLLBACK_LINES);
  assert.equal(view.lines.at(-1), log.at(-1));
  assert.equal(view.top, view.lineCount - SCREEN);
  assert.equal(paging.showsLive, true);
});

test("going back to live output from far back starts over at the bottom", async () => {
  const { log, view, paging, start, scrollTo } = setup(80000);
  await start();
  for (let i = 0; i < 4; i++) await scrollTo(0);
  assert.equal(paging.showsLive, false);
  await paging.toNewest();
  await settle();
  assert.equal(paging.showsLive, true);
  assert.equal(view.lineCount, SCROLLBACK_LINES);
  assert.equal(view.lines.at(-1), log.at(-1));
});

test("after lines are trimmed off the top, paging back starts from an exact replay first", async () => {
  const { log, view, output, start, scrollTo } = setup(25000);
  await start();
  for (let i = 0; i < 3000; i++) output(`more ${i}`);
  assert.equal(view.hasTrimmed, true);
  assert.ok(view.lineCount > SCROLLBACK_LINES, "the view holds more lines than a replay does");
  const onScreen = view.lines[0];
  await scrollTo(0);
  assertRun(view.lines, log);
  assert.equal(view.lines.at(-1), "more 2999");
  assert.ok(view.lineCount > SCROLLBACK_LINES);
  assert.equal(view.lines[view.top], onScreen, "what was on screen stays there");
});

test("going to the newest line from pages held in front scrolls to the bottom and lets them go", async () => {
  const { log, view, paging, start, scrollTo } = setup(30000);
  await start();
  await scrollTo(0);
  assert.equal(paging.atNewest(), false);
  await paging.toNewest();
  await settle();
  assert.equal(paging.atNewest(), true);
  assert.equal(view.lineCount, SCROLLBACK_LINES);
  assert.equal(view.lines.at(-1), log.at(-1));
});

test("searching: the cursors either side of what is held, and showing a page found far away", async () => {
  const { log, view, paging, source, start, scrollTo } = setup(80000);
  await start();
  assert.equal(paging.searchable, true);
  assert.equal(paging.holdsAll, false);
  assert.deepEqual(await paging.olderCursor(), { offset: 80000 - SCROLLBACK_LINES, skip: 0 });
  assert.equal(paging.newerCursor(), null, "nothing is newer than live output");
  const far = await source.getHistoryPage({ before: { offset: 10000, skip: 0 } });
  await paging.show(far);
  await settle();
  assert.equal(paging.showsLive, false);
  assertRun(view.lines, log);
  assert.ok(view.lines.includes("line 5000") && view.lines.includes("line 9999"));
  assert.deepEqual(paging.newerCursor(), { offset: 10000, skip: 0 });
  // Paging on from it works as from any other page.
  await scrollTo(view.lineCount);
  assertRun(view.lines, log);
  assert.ok(view.lines.includes("line 10000"));
  // A page that reaches the end is shown as the replay.
  await paging.show(await source.getHistoryPage({ after: { offset: 79000, skip: 0 } }));
  await settle();
  assert.equal(paging.showsLive, true);
  assert.equal(view.lines.at(-1), log.at(-1));
});

test("a view that holds all the history there is has nothing more to search", async () => {
  const { paging, start } = setup(500);
  await start();
  assert.equal(paging.holdsAll, true);
  assert.equal(await paging.olderCursor(), null);
});

test("a reset while paging forward replaces everything, and the page fetched for before it isn't added", async () => {
  const { log, view, paging, source, live, output, start, scrollTo } = setup(80000);
  await start();
  for (let i = 0; i < 4; i++) await scrollTo(0);
  assert.equal(paging.showsLive, false);
  output("said while far back");
  // The reconnect's reset arrives while the next page is being fetched.
  const getPage = source.getHistoryPage;
  let reset = false;
  source.getHistoryPage = async (request) => {
    const page = await getPage(request);
    if ("after" in request && !reset) {
      reset = true;
      live.receive({ kind: "reset", replay: await source.getScrollback() });
    }
    return page;
  };
  await scrollTo(view.lineCount);
  assert.ok(reset, "a page was fetched forward");
  assert.equal(paging.showsLive, true);
  assert.equal(view.lines.at(-1), "said while far back");
  assertRun(view.lines, log);
});

test("output that arrives while the page reaching live output is fetched is shown after it", async () => {
  const { log, view, paging, source, output, start, scrollTo } = setup(80000);
  await start();
  for (let i = 0; i < 4; i++) await scrollTo(0);
  assert.equal(paging.showsLive, false);
  const getPage = source.getHistoryPage;
  source.getHistoryPage = async (request) => {
    const page = await getPage(request);
    if ("after" in request && page.after === null) output("said during the fetch");
    return page;
  };
  for (let i = 0; i < 20 && !paging.showsLive; i++) await scrollTo(view.lineCount);
  assert.equal(paging.showsLive, true);
  assert.equal(view.lines.at(-1), "said during the fetch");
  assertRun(view.lines, log);
});

// A small seeded generator, so a failing sequence can be run again.
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

test("any mix of scrolling, output, resets and End keeps the view a run of the log, and loses no output", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { log, view, paging, source, live, output, scrollTo } = setup(60000);
    const rand = random(seed);
    let said = 0;
    const say = (): void => output(`said ${seed}.${said++}`);
    // Output sometimes arrives while a page or the replay is being fetched.
    const getPage = source.getHistoryPage;
    source.getHistoryPage = async (request) => {
      const page = await getPage(request);
      if (rand() < 0.3) say();
      return page;
    };
    const getScrollback = source.getScrollback;
    source.getScrollback = async () => {
      const replay = await getScrollback();
      if (rand() < 0.3) say();
      return replay;
    };
    live.replay(await source.getScrollback());
    await settle();
    const steps: string[] = [];
    for (let step = 0; step < 60; step++) {
      const r = rand();
      if (r < 0.3) {
        steps.push("top");
        const onScreen = view.lines[0];
        await scrollTo(0);
        assert.equal(view.lines[view.top], onScreen, `what was on screen stays there, seed ${seed}, after ${steps}`);
      } else if (r < 0.5) {
        steps.push("bottom");
        await scrollTo(view.lineCount);
      } else if (r < 0.6) {
        steps.push("middle");
        await scrollTo(Math.floor(rand() * view.lineCount));
      } else if (r < 0.8) {
        const count = rand() < 0.2 ? 3000 : 1 + Math.floor(rand() * 20);
        steps.push(`say ${count}`);
        for (let i = 0; i < count; i++) say();
        await settle();
      } else if (r < 0.84) {
        // Find showing the page a match is on, anywhere in the log.
        const at = Math.floor(rand() * log.length);
        const request =
          rand() < 0.5 ? { before: { offset: Math.max(1, at), skip: 0 } } : { after: { offset: at, skip: 0 } };
        steps.push(`show ${JSON.stringify(request)}`);
        await paging.show(await getPage(request));
        await settle();
      } else if (r < 0.86) {
        steps.push("older cursor");
        await paging.olderCursor();
        await settle();
      } else if (r < 0.88) {
        steps.push("rewritten");
        await paging.rewritten();
        await settle();
      } else if (r < 0.9) {
        steps.push("end");
        await paging.toNewest();
        await settle();
      } else {
        steps.push("reset");
        live.receive({ kind: "reset", replay: await getScrollback() });
        await settle();
      }
      const where = `seed ${seed}, after ${steps.join(", ")}`;
      assertRun(view.lines, log, where);
      assert.ok(view.lineCount <= MAX_HELD_LINES + PAGE_LINES, `${view.lineCount} lines held, ${where}`);
      if (paging.showsLive) assert.equal(view.lines.at(-1), log.at(-1), `newest line, ${where}`);
    }
    await paging.toNewest();
    await settle();
    assert.equal(paging.showsLive, true, `seed ${seed}`);
    assert.equal(view.lines.at(-1), log.at(-1), `seed ${seed}`);
    assertRun(view.lines, log);
  }
});
