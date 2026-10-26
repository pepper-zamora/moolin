import { test } from "node:test";
import assert from "node:assert/strict";
import { dateLabel, formatTime, layoutStamps } from "./timestamp-gutter";

const at = (month: number, day: number, hour: number, minute: number) =>
  new Date(2024, month - 1, day, hour, minute).getTime();
const CELL = 20;

test("times are 12-hour with a one-letter suffix", () => {
  assert.equal(formatTime(new Date(2024, 0, 1, 9, 5)), "9:05a");
  assert.equal(formatTime(new Date(2024, 0, 1, 0, 0)), "12:00a");
  assert.equal(formatTime(new Date(2024, 0, 1, 12, 10)), "12:10p");
  assert.equal(formatTime(new Date(2024, 0, 1, 23, 59)), "11:59p");
  assert.equal(dateLabel(new Date(2024, 10, 20)), "11/20");
});

test("a run of lines in the same minute is labelled once", () => {
  const t = at(1, 1, 9, 5);
  const out = layoutStamps(
    [
      { time: t, top: 100 },
      { time: t + 1000, top: 120 },
      { time: t + 90_000, top: 140 },
    ],
    t - 60_000,
    CELL,
  );
  assert.deepEqual(
    out.map((e) => [e.top, e.label]),
    [
      [100, "9:05a"],
      [140, "9:06a"],
    ],
  );
});

test("the first stamped line of the buffer shows the date above its time", () => {
  const [entry] = layoutStamps([{ time: at(11, 20, 9, 5), top: 100 }], null, CELL);
  assert.deepEqual([entry.label, entry.date, entry.dateCell], ["9:05a", "11/20", false]);
});

test("a dated line at the very top shows the date in the time's cell", () => {
  const [entry] = layoutStamps([{ time: at(11, 20, 9, 5), top: 0 }], null, CELL);
  assert.deepEqual([entry.label, entry.date, entry.dateCell], ["11/20", null, true]);
});

test("a day change shows the date even in the same minute of the day", () => {
  const out = layoutStamps(
    [
      { time: at(1, 1, 23, 59), top: 100 },
      { time: at(1, 2, 23, 59), top: 200 },
    ],
    at(1, 1, 23, 58),
    CELL,
  );
  assert.deepEqual(
    out.map((e) => [e.top, e.date]),
    [
      [100, null],
      [200, "1/2"],
    ],
  );
});

test("a floated date replaces a time directly above it", () => {
  const out = layoutStamps(
    [
      { time: at(1, 1, 23, 59), top: 100 },
      { time: at(1, 2, 0, 1), top: 120 },
    ],
    at(1, 1, 23, 58),
    CELL,
  );
  assert.deepEqual(
    out.map((e) => [e.top, e.date]),
    [[120, "1/2"]],
  );
});

test("lines without a time are skipped and don't break a run", () => {
  const t = at(1, 1, 9, 5);
  const out = layoutStamps(
    [
      { time: null, top: 100 },
      { time: t, top: 120 },
      { time: null, top: 140 },
      { time: t + 1000, top: 160 },
    ],
    t - 1000,
    CELL,
  );
  assert.deepEqual(
    out.map((e) => e.top),
    [120],
  );
});
