// What the window and the main process agree on for paging a character's older
// history into the scrollback. No Node or Electron imports: the window uses it.

// The lines kept in the window's scrollback, and so the most a replay holds.
export const SCROLLBACK_LINES = 20000;

// How much older history one request returns: whichever limit comes first.
export const PAGE_LINES = 5000;
export const PAGE_BYTES = 1024 * 1024;

// Where a page of history ends: just before byte `skip` of the data in the
// record whose line starts `offset` bytes into the log file. Everything earlier
// in the log is older than the cursor, so a page that starts at one can be
// followed by the page before it.
export interface LogCursor {
  offset: number;
  skip: number;
}

// Asks for the page of history that ends at `before`.
export interface HistoryRequest {
  before: LogCursor;
}

// A page of history: bytes cut at a line boundary, the arrival time of each line
// feed in them (null where unknown), and the cursor for the page before it, or
// null when there is nothing older.
export interface HistoryPage {
  bytes: Uint8Array;
  times: Array<number | null>;
  before: LogCursor | null;
}

export const NO_HISTORY: HistoryPage = { bytes: new Uint8Array(), times: [], before: null };
