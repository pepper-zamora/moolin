// What the window and the main process agree on for paging a character's
// history through the scrollback. No Node or Electron imports: the window uses it.

// The lines kept in the window's scrollback, and so the most a replay holds.
export const SCROLLBACK_LINES = 20000;

// How much history one request returns: whichever limit comes first.
export const PAGE_LINES = 5000;
export const PAGE_BYTES = 1024 * 1024;

// The most lines the window holds while history is paged in (it drops pages from
// the end away from the view past this), so a page or two more than the
// scrollback.
export const MAX_HELD_LINES = SCROLLBACK_LINES + 2 * PAGE_LINES;

// A place in the log, between two bytes of what it holds: just before byte
// `skip` of the data in the record whose line starts `offset` bytes into the
// log file. Everything earlier in the log is older than the cursor, and
// everything after it newer, so pages that meet at one fit together.
export interface LogCursor {
  offset: number;
  skip: number;
}

// Asks for the page of history that ends at `before` (at the end of the log if
// null: its tail), or the one that starts at `after` (at the start of the log if
// null).
export type HistoryRequest = { before: LogCursor | null } | { after: LogCursor | null };

// A page of history: bytes cut at a line boundary, the arrival time of each line
// feed in them (null where unknown), and the cursors where the page starts and
// ends. `before` is null when nothing older exists. `after` is null when the
// page reaches the end of the log: then it also holds the unfinished line the
// window is still to log, and covers the window's live output up to `seq` (as a
// replay does). `end` is where the page ends in the log all the same, so asking
// for the page before it gets this page again: the log only grows at its end
// (null for an empty log). `stale` says the cursor no longer fits the log (it was
// rewritten, or can't be read), so the window should start over.
export interface HistoryPage {
  chunks: Uint8Array[];
  times: Array<number | null>;
  before: LogCursor | null;
  after: LogCursor | null;
  end: LogCursor | null;
  seq: number;
  stale: boolean;
}

export const STALE_PAGE: HistoryPage = {
  chunks: [],
  times: [],
  before: null,
  after: null,
  end: null,
  seq: 0,
  stale: true,
};
