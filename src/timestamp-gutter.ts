import type { ScrollbackView } from "./scrollback-view";

// 12-hour, minute resolution, with a single-letter am/pm suffix: "9:05a",
// "12:10p". No seconds; a run of lines in the same minute is collapsed to one
// label in layoutStamps.
export function formatTime(time: Date): string {
  const hour = time.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = time.getMinutes().toString().padStart(2, "0");
  return `${hour12}:${minute}${hour < 12 ? "a" : "p"}`;
}

// "11/20" (local month/day), floated above the time when the day changes.
export function dateLabel(time: Date): string {
  return `${time.getMonth() + 1}/${time.getDate()}`;
}

function dayKey(time: Date): string {
  return `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
}

export interface StampEntry {
  // Pixels from the top of the viewport to the line's first row.
  top: number;
  label: string;
  // The date to float above the time, on a day's first line.
  date: string | null;
  // The dated line is at the very top, with no row above to float the date
  // onto, so the date takes the time's cell.
  dateCell: boolean;
}

// Decides which visible lines get a label. `prevTime` is the time of the
// stamped line before the first one given. A label is shown for the first line
// of each minute (a run within the same minute shows nothing), and the date on
// the first stamped line and wherever the local day changes. Lines without a
// time (Moolin's own lines, Clear Screen's filler) are skipped and leave the
// run unbroken.
export function layoutStamps(
  lines: ReadonlyArray<{ time: number | null; top: number }>,
  prevTime: number | null,
  cell: number,
): StampEntry[] {
  const entries: StampEntry[] = [];
  let prev = prevTime === null ? null : new Date(prevTime);
  for (const { time, top } of lines) {
    if (time === null) continue;
    const when = new Date(time);
    const label = formatTime(when);
    const dayChange = prev !== null && dayKey(prev) !== dayKey(when);
    const showDate = prev === null || dayChange;
    const sameMinute = prev !== null && formatTime(prev) === label && !dayChange;
    prev = when;
    if (sameMinute) continue;
    const dateCell = showDate && top < cell / 2;
    if (showDate && !dateCell) {
      // The date floats onto the row above. Where that row holds the previous
      // entry's own time (a session crossing midnight, or two days meeting in
      // replayed history) the date takes its place rather than drawing over it.
      const above = entries[entries.length - 1];
      if (above && above.top + cell > top - cell + 0.5) entries.pop();
    }
    entries.push({
      top,
      label: dateCell ? dateLabel(when) : label,
      date: showDate && !dateCell ? dateLabel(when) : null,
      dateCell,
    });
  }
  return entries;
}

// A column to the left of the scrollback showing when each line arrived. The
// time is never part of the line text: copy, search and the session log keep
// seeing the untimestamped text, matching MUSHclient's display-only model (see
// GAPS.md §8).
export class TimestampGutter {
  private shown = false;
  private scheduled = false;

  constructor(
    private readonly gutter: HTMLElement,
    private readonly view: ScrollbackView,
  ) {
    view.onScroll(() => this.schedule());
    view.onChange(() => this.schedule());
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    this.gutter.hidden = !shown;
    this.schedule();
  }

  isShown(): boolean {
    return this.shown;
  }

  // Keeps the gutter's font matched to the scrollback's, so its cell height is.
  setFont(fontFamily: string, fontSize: number): void {
    this.gutter.style.fontFamily = fontFamily;
    this.gutter.style.fontSize = `${fontSize}px`;
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled || !this.shown) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.shown) return;
    const cell = this.view.lineHeight();
    const { prevTime, lines } = this.view.visibleLines();
    const nodes: HTMLDivElement[] = [];
    for (const entry of layoutStamps(lines, prevTime, cell)) {
      const node = document.createElement("div");
      node.className = "gutter-stamp";
      node.style.top = `${entry.top}px`;
      node.style.height = `${cell}px`;
      node.style.lineHeight = `${cell}px`;
      if (entry.dateCell) node.classList.add("gutter-datecell");
      if (entry.date !== null) {
        const date = document.createElement("span");
        date.className = "gutter-date";
        date.textContent = entry.date;
        node.appendChild(date);
      }
      node.appendChild(document.createTextNode(entry.label));
      nodes.push(node);
    }
    this.gutter.replaceChildren(...nodes);
  }
}
