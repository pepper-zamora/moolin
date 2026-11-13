import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_LINES, type HistoryPage, type HistoryRequest, type LogCursor } from "./history-paging";
import { LogChain } from "./log-pane";
import { LogScan } from "./log-scan";

const decoder = new TextDecoder();
const linesOf = (chunks: ReadonlyArray<Uint8Array>): string[] =>
  chunks
    .map((chunk) => decoder.decode(chunk))
    .join("")
    .split("\n")
    .slice(0, -1);
const read = (chunks: ReadonlyArray<Uint8Array>) => linesOf(chunks).map((text) => ({ text }));
const query = (text: string) => ({ text, caseSensitive: false, wholeWord: false, regex: false });

// A log served in pages of PAGE_LINES, as main serves them.
function source(log: string[]) {
  const cursor = (index: number): LogCursor | null => (index <= 0 ? null : { offset: index, skip: 0 });
  return async (request: HistoryRequest): Promise<HistoryPage> => {
    if (!("before" in request)) throw new Error("only pages before a cursor are asked for");
    const end = request.before?.offset ?? log.length;
    const start = Math.max(0, end - PAGE_LINES);
    const chunks = [
      new TextEncoder().encode(
        log
          .slice(start, end)
          .map((line) => `${line}\n`)
          .join(""),
      ),
    ];
    const endCursor = { offset: end, skip: 0 };
    return { chunks, times: [], before: cursor(start), after: request.before, end: endCursor, seq: 0, stale: false };
  };
}

test("a scan finds every match from the end of the log back, and says where each is", async () => {
  // A wyvern every 1,000 lines, and two on line 25,500.
  const log = Array.from({ length: 30000 }, (_, i) =>
    i === 25500 ? "a wyvern and another wyvern" : i % 1000 === 7 ? `wyvern ${i}` : `line ${i}`,
  );
  const chain = await LogChain.start(source(log));
  assert.ok(chain);
  let updates = 0;
  const scan = new LogScan(chain, query("WYVERN"), read, () => updates++);
  const running = scan.run();
  await scan.reach(0);
  assert.ok(scan.hits.length > 0 && !scan.done, "the first hits come before the scan is done");
  await running;
  assert.equal(scan.done, true);
  assert.equal(scan.progress, 1);
  assert.equal(scan.count, 32);
  assert.ok(updates >= 6, "told after each page");
  // Newest first; the two on one line, the later one first.
  assert.deepEqual(scan.hits[0], { k: 0, line: 29007 - 25000, start: 0, end: 6 });
  const twoOnALine = scan.hits.filter((hit) => hit.k === 0 && hit.line === 500);
  assert.deepEqual(
    twoOnALine.map((hit) => hit.start),
    [21, 2],
  );
  assert.deepEqual(scan.hits.at(-1), { k: 5, line: 7, start: 0, end: 6 });
  // Each hit names its line by page and line within it.
  for (const hit of scan.hits) {
    const page: HistoryPage | null = await chain.page(hit.k);
    const text: string = linesOf(page?.chunks ?? [])[hit.line];
    assert.equal(text.slice(hit.start, hit.end).toLowerCase(), "wyvern");
  }
});

test("a cancelled scan stops, and anything waiting on it goes on", async () => {
  const log = Array.from({ length: 30000 }, (_, i) => `line ${i}`);
  const chain = await LogChain.start(source(log));
  assert.ok(chain);
  const scan = new LogScan(chain, query("wyvern"), read, () => {});
  const running = scan.run();
  const waiting = scan.reach(0);
  scan.cancel();
  await waiting;
  await running;
  assert.equal(scan.count, 0);
});
