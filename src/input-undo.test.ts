import { test } from "node:test";
import assert from "node:assert/strict";
import { InputUndoStack, type InputSnapshot } from "./input-undo";

function snap(value: string, pos = value.length): InputSnapshot {
  return { value, selectionStart: pos, selectionEnd: pos };
}

test("undo restores the previous snapshot and redo brings back the one undone", () => {
  const stack = new InputUndoStack();
  stack.pushDiscrete(snap("a"));
  const undone = stack.undo(snap("ab"));
  assert.deepEqual(undone, snap("a"));
  const redone = stack.redo(snap("a"));
  assert.deepEqual(redone, snap("ab"));
});

test("undo after redo goes back to the pre-redo state, not in a loop", () => {
  const stack = new InputUndoStack();
  stack.pushDiscrete(snap("a"));
  stack.undo(snap("ab"));
  stack.redo(snap("a"));
  const undoneAgain = stack.undo(snap("ab"));
  assert.deepEqual(undoneAgain, snap("a"));
});

test("consecutive typing within the coalescing window is one undo step", () => {
  const stack = new InputUndoStack();
  stack.pushTyping(snap(""), 0);
  stack.pushTyping(snap("a"), 100);
  stack.pushTyping(snap("ab"), 200);
  const undone = stack.undo(snap("abc"));
  assert.deepEqual(undone, snap(""), "all three keystrokes collapse into the pre-typing snapshot");
  assert.equal(stack.canUndo(), false);
});

test("a pause longer than the coalescing window starts a new undo step", () => {
  const stack = new InputUndoStack();
  stack.pushTyping(snap(""), 0);
  stack.pushTyping(snap("a"), 1000);
  const firstUndo = stack.undo(snap("ab"));
  assert.deepEqual(firstUndo, snap("a"));
  const secondUndo = stack.undo(snap("a"));
  assert.deepEqual(secondUndo, snap(""));
});

test("cut/paste are always their own step, never coalesced with typing", () => {
  const stack = new InputUndoStack();
  stack.pushTyping(snap(""), 0);
  stack.pushDiscrete(snap("a"));
  const undone = stack.undo(snap("apasted"));
  assert.deepEqual(undone, snap("a"));
  const undoneAgain = stack.undo(snap("a"));
  assert.deepEqual(undoneAgain, snap(""));
});

test("a new edit after undo clears the redo stack", () => {
  const stack = new InputUndoStack();
  stack.pushDiscrete(snap("a"));
  stack.undo(snap("ab"));
  stack.pushDiscrete(snap("x"));
  assert.equal(stack.canRedo(), false);
});

test("breakGroup ends typing coalescing and clears redo without pushing a step", () => {
  const stack = new InputUndoStack();
  stack.pushDiscrete(snap("a"));
  stack.pushDiscrete(snap("ab"));
  stack.undo(snap("abc"));
  assert.equal(stack.canRedo(), true);
  assert.equal(stack.canUndo(), true, "one discrete step still remains below the undone one");
  stack.breakGroup();
  assert.equal(stack.canRedo(), false);
  assert.equal(stack.canUndo(), true, "breakGroup doesn't touch the undo stack itself");
});

test("undo/redo on empty stacks are no-ops", () => {
  const stack = new InputUndoStack();
  assert.equal(stack.undo(snap("x")), null);
  assert.equal(stack.redo(snap("x")), null);
  assert.equal(stack.canUndo(), false);
  assert.equal(stack.canRedo(), false);
});
