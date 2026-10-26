function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// The text selected in the scrollback, kept (and kept drawn) after focus moves
// elsewhere. Focus lives in the input area, and giving a textarea focus
// replaces the document's selection, so the scrollback's is remembered as it
// is made and drawn with a CSS highlight until something replaces it. Ctrl+C
// can then still copy it, as it could when xterm held the selection itself.
export class HeldSelection {
  private text = "";
  private range: Range | null = null;
  private pointerDown = false;

  constructor(
    private readonly el: HTMLElement,
    // The primary mouse button went down in the scrollback, starting a click or drag...
    onPointerDown: () => void,
    // ...and went up, ending it.
    onPointerUp: () => void,
  ) {
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      this.pointerDown = true;
      this.clear();
      onPointerDown();
    });
    document.addEventListener(
      "mouseup",
      (event) => {
        if (event.button !== 0 || !this.pointerDown) return;
        this.pointerDown = false;
        this.capture();
        onPointerUp();
      },
      true,
    );
    document.addEventListener("selectionchange", () => {
      // The text is only read once the drag ends; reading it on every move of
      // a large selection would be slow.
      if (!this.pointerDown) this.capture();
    });
  }

  // A mouse button is down in the scrollback: a click or a drag selection.
  isSelecting(): boolean {
    return this.pointerDown;
  }

  // The document's selection if it is (at least partly) in the scrollback,
  // cut back to the scrollback: a triple click on the last line, say, selects
  // up to the start of whatever follows it, which is outside.
  private live(): Selection | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const anchorIn = this.el.contains(selection.anchorNode);
    const focusIn = this.el.contains(selection.focusNode);
    if (anchorIn && focusIn) return selection;
    if (!anchorIn && !focusIn) return null;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    const end = this.el.childNodes.length;
    if (anchorIn && anchorNode) selection.setBaseAndExtent(anchorNode, anchorOffset, this.el, end);
    else if (focusNode) selection.setBaseAndExtent(this.el, 0, focusNode, focusOffset);
    return selection;
  }

  private capture(): void {
    const selection = this.live();
    if (selection) {
      this.text = this.pointerDown ? "" : selection.toString();
      this.range = selection.getRangeAt(0).cloneRange();
      if (typeof CSS !== "undefined" && "highlights" in CSS)
        CSS.highlights.set("held-selection", new Highlight(this.range));
      return;
    }
    const current = document.getSelection();
    // A click inside the scrollback ends the held selection; the selection
    // moving elsewhere (into the input area) does not.
    if (current?.isCollapsed && this.el.contains(current.anchorNode)) this.clear();
  }

  clear(): void {
    this.text = "";
    this.range = null;
    if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete("held-selection");
  }

  // The selected text, or "" when nothing is selected. A selection that ends
  // at the start of the next line (a triple click) doesn't include that line
  // break, which would otherwise paste as an extra empty line.
  selectedText(): string {
    const selection = this.live();
    return stripTrailingNewline(selection ? selection.toString() : this.text);
  }

  // Drops the selection, but leaves one in another element alone.
  clearSelection(): void {
    if (this.live()) document.getSelection()?.removeAllRanges();
    this.clear();
  }

  selectAll(container: Node): void {
    document.getSelection()?.selectAllChildren(container);
    this.capture();
  }
}
