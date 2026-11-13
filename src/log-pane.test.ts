import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_HELD_LINES, PAGE_LINES, type HistoryPage, type HistoryRequest, type LogCursor } from "./history-paging";
import { LogChain, LogPane, locateFromEnd, type PaneView } from "./log-pane";

const SCREEN = 40;
const decoder = new TextDecoder();
const linesOf = (chunks: ReadonlyArray<Uint8Array>): string[] =>
  chunks
    .map((chunk) => decoder.decode(chunk))
    .join("")
    .split("\n")
    .slice(0, -1);
const bytes = (lines: string[]): Uint8Array => new TextEncoder().encode(lines.map((line) => `${line}\n`).join(""));

// A scrollback of whole lines, a screen of SCREEN lines tall, scrolled to `top`.
class FakeView implements PaneView {
  lines: string[] = [];
  top = 0;
  get lineCount(): number {
    return this.lines.length;
  }
  nearTop(): boolean {
    return this.top < SCREEN;
  }
  nearBottom(): boolean {
    return this.lines.length - this.top - SCREEN < SCREEN;
  }
  linesNearView(): { first: number; last: number } {
    return { first: Math.max(0, this.top - SCREEN), last: Math.min(this.lines.length - 1, this.top + 2 * SCREEN) };
  }
  prepend(chunks: ReadonlyArray<Uint8Array>): number {
    const lines = linesOf(chunks);
    this.lines.unshift(...lines);
    this.top += lines.length;
    return lines.length;
  }
  append(chunks: ReadonlyArray<Uint8Array>): number {
    const lines = linesOf(chunks);
    this.lines.push(...lines);
    return lines.length;
  }
  dropFront(count: number): void {
    this.lines.splice(0, count);
    this.top = Math.max(0, this.top - count);
  }
  dropBack(count: number): void {
    this.lines.splice(this.lines.length - count, count);
    this.top = Math.min(this.top, Math.max(0, this.lines.length - SCREEN));
  }
  showHistory(chunks: ReadonlyArray<Uint8Array>): number {
    this.lines = linesOf(chunks);
    this.top = 0;
    return this.lines.length;
  }
  revealLineAt(index: number, at: "center" | "top" | "bottom" = "center"): void {
    if (at === "top") this.scrollTo(index);
    else if (at === "bottom") this.scrollTo(index - SCREEN + 1);
    else if (index < this.top || index >= this.top + SCREEN) this.scrollTo(index - SCREEN / 2);
  }
  scrollToBottom(): void {
    this.top = Math.max(0, this.lines.length - SCREEN);
  }
  isAtBottom(): boolean {
    return this.top + SCREEN >= this.lines.length;
  }
  scrollTo(top: number): void {
    this.top = Math.max(0, Math.min(top, this.lines.length - SCREEN));
  }
  onScreen(): string {
    return this.lines[this.top];
  }
}

// A log of numbered lines, served in pages of PAGE_LINES as main serves them.
function setup(logLines: number) {
  const log = Array.from({ length: logLines }, (_, i) => `line ${i}`);
  let stale = false;
  let fetches = 0;
  const cursor = (index: number): LogCursor | null => (index <= 0 ? null : { offset: index, skip: 0 });
  const getPage = async (request: HistoryRequest): Promise<HistoryPage> => {
    fetches++;
    if (stale) return { chunks: [], times: [], before: null, after: null, end: null, seq: 0, stale: true };
    if (!("before" in request)) throw new Error("only pages before a cursor are asked for");
    const end = request.before?.offset ?? log.length;
    const start = Math.max(0, end - PAGE_LINES);
    return {
      chunks: [bytes(log.slice(start, end))],
      times: [],
      before: cursor(start),
      after: request.before,
      end: log.length === 0 ? null : { offset: end, skip: 0 },
      seq: 0,
      stale: false,
    };
  };
  const view = new FakeView();
  let staleSeen = 0;
  const pane = new LogPane(view, () => staleSeen++);
  const scrollTo = async (top: number): Promise<void> => {
    view.scrollTo(top);
    pane.scrolled();
    await settle();
  };
  return {
    log,
    view,
    pane,
    getPage,
    scrollTo,
    fetches: () => fetches,
    makeStale: () => (stale = true),
    staleSeen: () => staleSeen,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
}

// The lines are a run of the log, in order, with none missing or repeated.
function assertRun(lines: string[], log: string[], where = ""): void {
  const first = log.indexOf(lines[0]);
  assert.ok(first !== -1, `${lines[0]} is in the log ${where}`);
  const broken = lines.findIndex((line, i) => line !== log[first + i]);
  if (broken !== -1) assert.fail(`line ${broken} is ${lines[broken]}, not ${log[first + broken]} ${where}`);
}

test("a chain's pages are the same pages however the log grows, and say how far back they reach", async () => {
  const { log, getPage } = setup(12000);
  const chain = await LogChain.start(getPage);
  assert.ok(chain);
  const first = await chain.page(0);
  log.push("said after the chain began");
  const again = await chain.page(0);
  assert.deepEqual(again?.chunks, first?.chunks, "page 0 still ends where the log ended");
  assert.equal(chain.has(1), true);
  assert.equal(chain.has(2), null, "not known until page 1 is read");
  await chain.page(1);
  assert.equal(chain.has(2), true);
  const last = await chain.page(2);
  assert.equal(linesOf(last?.chunks ?? [])[0], "line 0");
  assert.equal(chain.has(3), false, "page 2 reaches the log's start");
  assert.equal(chain.progress(0), 1 - 7000 / 12000);
  assert.equal(chain.progress(2), 1);
  assert.equal(await LogChain.start(setup(0).getPage), null, "an empty log has no chain");
});

test("the pane opens at the bottom of the chain, pages back as it nears the top, and forward again", async () => {
  const { log, view, pane, getPage, scrollTo } = setup(40000);
  const chain = await LogChain.start(getPage);
  assert.ok(chain);
  await pane.show(chain, 0, "bottom");
  await settle();
  assert.equal(view.lines.at(-1), log.at(-1));
  assert.equal(pane.atEnd(), true);
  const before = view.lines[0];
  await scrollTo(0);
  assertRun(view.lines, log);
  assert.equal(view.onScreen(), before, "what was on screen stays there");
  for (let i = 0; i < 10; i++) await scrollTo(0);
  assert.equal(view.lines[0], "line 0", "as far back as the log goes");
  assert.ok(view.lineCount <= MAX_HELD_LINES, `${view.lineCount} lines held`);
  assertRun(view.lines, log);
  assert.equal(pane.atEnd(), false);
  for (let i = 0; i < 10 && !pane.atEnd(); i++) await scrollTo(view.lineCount);
  assert.equal(pane.atEnd(), true, "back down at the newest line");
  assert.equal(view.lines.at(-1), log.at(-1));
  assertRun(view.lines, log);
});

test("showing a line the pane holds only scrolls to it; one it doesn't replaces what it holds", async () => {
  const { log, view, pane, getPage, fetches } = setup(80000);
  const chain = await LogChain.start(getPage);
  assert.ok(chain);
  for (let k = 0; k < 12; k++) await chain.page(k);
  await pane.show(chain, 3, { line: 10 });
  await settle();
  const page3 = log.length - 4 * PAGE_LINES;
  assert.equal(view.lines[pane.indexOf(chain, 3, { line: 10 }) ?? -1], `line ${page3 + 10}`);
  const count = fetches();
  await pane.show(chain, 3, { line: 4000 });
  assert.equal(fetches(), count, "no fetch for a line already held");
  assert.equal(view.lines[view.top + SCREEN / 2], `line ${page3 + 4000}`);
  await pane.show(chain, 11, { line: 0 });
  await settle();
  assert.ok(view.lines.includes(`line ${log.length - 12 * PAGE_LINES}`));
  assertRun(view.lines, log);
  // Another chain's page is never taken for this one's.
  const other = await LogChain.start(getPage);
  assert.ok(other);
  assert.equal(pane.indexOf(other, 11, { line: 0 }), null);
});

test("a show that another overtakes is dropped, and a log that no longer fits closes the pane", async () => {
  const { log, view, pane, getPage, makeStale, staleSeen } = setup(80000);
  const chain = await LogChain.start(getPage);
  assert.ok(chain);
  for (let k = 0; k < 8; k++) await chain.page(k);
  void pane.show(chain, 7, { line: 0 });
  await pane.show(chain, 2, { line: 0 });
  await settle();
  assert.ok(view.lines.includes(`line ${log.length - 3 * PAGE_LINES}`), "the later show won");
  makeStale();
  await pane.show(chain, 6, { line: 0 });
  await settle();
  assert.equal(pane.isOpen, false);
  assert.equal(staleSeen(), 1);
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

test("any mix of scrolling, showing and output keeps the pane a bounded run of the log", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { log, view, pane, getPage, scrollTo } = setup(70000);
    const rand = random(seed);
    let chain = await LogChain.start(getPage);
    assert.ok(chain);
    await pane.show(chain, 0, "bottom");
    await settle();
    const steps: string[] = [];
    for (let step = 0; step < 50; step++) {
      const r = rand();
      if (r < 0.35) {
        steps.push("top");
        const onScreen = view.lines[0];
        await scrollTo(0);
        assert.equal(view.onScreen(), onScreen, `what was on screen stays there, seed ${seed}, after ${steps}`);
      } else if (r < 0.6) {
        steps.push("bottom");
        await scrollTo(view.lineCount);
      } else if (r < 0.7) {
        steps.push("middle");
        await scrollTo(Math.floor(rand() * view.lineCount));
      } else if (r < 0.8) {
        const k = Math.floor(rand() * 12);
        steps.push(`show ${k}`);
        if (chain.has(k)) {
          await pane.show(chain, k, { line: Math.floor(rand() * PAGE_LINES) });
          await settle();
        }
      } else if (r < 0.9) {
        steps.push("output");
        for (let i = 0; i < 200; i++) log.push(`more ${log.length}`);
      } else {
        steps.push("new chain");
        chain = (await LogChain.start(getPage)) ?? chain;
        await pane.show(chain, 0, "bottom");
        await settle();
      }
      const where = `seed ${seed}, after ${steps.join(", ")}`;
      assertRun(view.lines, log, where);
      assert.ok(view.lineCount <= MAX_HELD_LINES + PAGE_LINES, `${view.lineCount} lines, ${where}`);
    }
  }
});

test("the live scrollback's oldest line is found in the log by its distance from the end, then its text", async () => {
  const { log, view, pane, getPage } = setup(30000);
  const chain = await LogChain.start(getPage);
  assert.ok(chain);
  const read = (chunks: ReadonlyArray<Uint8Array>) => linesOf(chunks).map((text) => ({ text }));
  // 12,000 lines from the end is line 18,000: on page 2 (lines 15,000 to 19,999).
  assert.deepEqual(await locateFromEnd(chain, read, 12000, "line 18000"), { k: 2, line: 3000 });
  // A count a few lines out still finds the line by its text.
  assert.deepEqual(await locateFromEnd(chain, read, 12003, "line 18000"), { k: 2, line: 3000 });
  // Text that isn't near is left to the count.
  assert.deepEqual(await locateFromEnd(chain, read, 12000, "not in the log"), { k: 2, line: 3000 });
  // Past the start of the log, its first line.
  assert.deepEqual(await locateFromEnd(chain, read, 99999, "nothing"), { k: 5, line: 0 });
  // The pane shows it at its bottom edge, the history above it in view.
  await pane.show(chain, 2, { line: 3000, at: "bottom" });
  await settle();
  assert.equal(view.lines[view.top + SCREEN - 1], "line 18000");
  assertRun(view.lines, log); // A page's first line, with the page before it brought in to fill the view above.
  await pane.show(chain, 3, { line: 0, at: "bottom" });
  await settle();
  assert.equal(view.lines[view.top + SCREEN - 1], "line 10000");
  assertRun(view.lines, log);
});
