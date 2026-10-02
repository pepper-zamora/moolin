// The input area's command history, browsed like a shell's: stepping back
// from the newest entry remembers what was being typed (the draft), and
// stepping forward past the newest entry restores it.
export class CommandHistory {
  private readonly entries: string[] = [];
  // Equals entries.length when not browsing history.
  private index = 0;
  private draft = "";

  // Records a sent line. Blank lines and repeats of the previous line are
  // not added. Either way, browsing restarts from the newest entry.
  push(line: string): void {
    if (line.trim() !== "" && this.entries[this.entries.length - 1] !== line) this.entries.push(line);
    this.index = this.entries.length;
    this.draft = "";
  }

  // The previous entry, or null if already at the oldest. `current` is the
  // input's text, kept as the draft when leaving it.
  previous(current: string): string | null {
    if (this.index === 0) return null;
    if (this.index === this.entries.length) this.draft = current;
    this.index -= 1;
    return this.entries[this.index];
  }

  // The next entry, the draft once past the newest, or null if not browsing.
  next(): string | null {
    if (this.index === this.entries.length) return null;
    this.index += 1;
    return this.index < this.entries.length ? this.entries[this.index] : this.draft;
  }
}

// Whether the caret (or the start of the selection) is on the input's first
// line, where plain Up browses history instead of moving the caret.
export function isOnFirstLine(value: string, selectionStart: number): boolean {
  return !value.slice(0, selectionStart).includes("\n");
}

// Whether the caret (or the end of the selection) is on the input's last
// line, where plain Down browses history instead of moving the caret.
export function isOnLastLine(value: string, selectionEnd: number): boolean {
  return !value.slice(selectionEnd).includes("\n");
}
