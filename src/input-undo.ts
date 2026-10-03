// Chromium's native undo manager gets reset by every programmatic
// `textarea.value =` write (history recall, cut, paste, send), so native
// Ctrl+Z is unusable here. This is a small, DOM-free undo/redo state machine
// (snapshots in, snapshots out) operating the same way CommandHistory does.
const TYPING_COALESCE_MS = 500;

export interface InputSnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export class InputUndoStack {
  private readonly undoStack: InputSnapshot[] = [];
  private readonly redoStack: InputSnapshot[] = [];
  private lastTypingPush: number | null = null;

  // Called before a keystroke/composition mutates the value. Coalesces
  // consecutive edits within TYPING_COALESCE_MS into a single undo step.
  pushTyping(before: InputSnapshot, now: number): void {
    if (this.lastTypingPush !== null && now - this.lastTypingPush < TYPING_COALESCE_MS) {
      this.lastTypingPush = now;
      return;
    }
    this.undoStack.push(before);
    this.redoStack.length = 0;
    this.lastTypingPush = now;
  }

  // Cut/paste are always their own undo step, never coalesced with typing.
  pushDiscrete(before: InputSnapshot): void {
    this.undoStack.push(before);
    this.redoStack.length = 0;
    this.lastTypingPush = null;
  }

  // History recall and send are boundaries: they end the current typing
  // group and invalidate redo, but are not themselves undoable.
  breakGroup(): void {
    this.lastTypingPush = null;
    this.redoStack.length = 0;
  }

  undo(current: InputSnapshot): InputSnapshot | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.redoStack.push(current);
    this.lastTypingPush = null;
    return previous;
  }

  redo(current: InputSnapshot): InputSnapshot | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    this.lastTypingPush = null;
    return next;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
