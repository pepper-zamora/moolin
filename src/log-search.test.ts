import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryPage, HistoryRequest, LogCursor } from "./history-paging";
import { LogSearch } from "./log-search";

const query = (text: string) => ({ text, caseSensitive: false, wholeWord: false, regex: false });
const always = () => true;

// A log of numbered lines served in pages of 10, read one line per line feed.
function setup(lines: string[]) {
  const requests: HistoryRequest[] = [];
  const cursor = (index: number): LogCursor | null => (index <= 0 ? null : { offset: index, skip: 0 });
  const page = (start: number, end: number): HistoryPage => ({
    chunks: [
      new TextEncoder().encode(
        lines
          .slice(start, end)
          .map((line) => `${line}\n`)
          .join(""),
      ),
    ],
    times: [],
    before: cursor(start),
    after: end >= lines.length ? null : { offset: end, skip: 0 },
    end: { offset: end, skip: 0 },
    seq: 0,
    stale: false,
  });
  const search = new LogSearch(
    async (request) => {
      requests.push(request);
      if ("before" in request) return page(Math.max(0, request.before.offset - 10), request.before.offset);
      const start = request.after?.offset ?? 0;
      return page(start, Math.min(lines.length, start + 10));
    },
    (chunks) =>
      new TextDecoder()
        .decode(chunks[0])
        .split("\n")
        .slice(0, -1)
        .map((text) => ({ text })),
  );
  return { search, requests };
}

const log = Array.from({ length: 100 }, (_, i) => (i === 17 || i === 23 || i === 81 ? `needle ${i}` : `hay ${i}`));

test("searching older finds the nearest match before the place, page by page", async () => {
  const { search, requests } = setup(log);
  const hit = await search.older({ offset: 80, skip: 0 }, query("needle"), always);
  assert.ok(hit);
  assert.equal(hit.page.before?.offset, 20);
  assert.equal(hit.line, 3, "line 23 of the page from 20");
  assert.deepEqual([hit.start, hit.end], [0, 6]);
  assert.equal(requests.length, 6, "only as far back as the match");
  assert.equal(await search.older({ offset: 17, skip: 0 }, query("needle"), always), null, "none before the first");
});

test("searching newer finds the nearest match after the place, and from the start finds the oldest", async () => {
  const { search } = setup(log);
  const hit = await search.newer({ offset: 30, skip: 0 }, query("NEEDLE"), always);
  assert.equal(hit?.page.before?.offset, 80);
  assert.equal(hit?.line, 1);
  const oldest = await search.newer(null, query("needle"), always);
  assert.equal(oldest?.line, 7);
  assert.equal(oldest?.page.before?.offset, 10);
  assert.equal(await search.newer({ offset: 82, skip: 0 }, query("needle"), always), null, "none after the last");
});

test("a search that is no longer wanted stops", async () => {
  const { search, requests } = setup(log);
  let pages = 0;
  const hit = await search.older({ offset: 100, skip: 0 }, query("nowhere"), () => ++pages < 3);
  assert.equal(hit, null);
  assert.equal(requests.length, 3);
});

test("a pattern that isn't a regular expression throws", async () => {
  const { search } = setup(log);
  await assert.rejects(search.older({ offset: 50, skip: 0 }, { ...query("("), regex: true }, always));
});
