// A row of tabs over a set of panels, following the WAI-ARIA tabs pattern:
// the tab list is a single Tab stop (the selected tab), Left/Right move to
// the previous/next tab and select it, Home/End go to the first/last. Each
// tab names its panel with aria-controls; only the selected tab's panel is
// shown.
//
// When the tabs don't all fit on one row, the list scrolls sideways and a
// pair of ‹ › buttons appears after it, at the right end, to scroll it;
// they're hidden whenever every tab fits. They're for the mouse only (not
// Tab stops): the keyboard reaches every tab with the arrow keys, and the
// selected tab is always scrolled into view.
//
// Markup: a root holding a [role="tablist"] of [role="tab"] buttons, and
// optional .tab-scroll-prev / .tab-scroll-next buttons.
export class TabStrip {
  private readonly list: HTMLElement;
  private readonly prev: HTMLButtonElement | null;
  private readonly next: HTMLButtonElement | null;

  constructor(
    root: HTMLElement,
    // Called after the selected tab changes, with its id.
    private readonly onSelect: (id: string) => void = () => {},
  ) {
    const list = root.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) throw new Error("tab strip has no tablist");
    this.list = list;
    this.prev = root.querySelector<HTMLButtonElement>(".tab-scroll-prev");
    this.next = root.querySelector<HTMLButtonElement>(".tab-scroll-next");

    this.list.addEventListener("click", (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
      if (tab) this.select(tab, { focus: true });
    });
    this.list.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const tabs = this.tabs();
      const index = tabs.indexOf(this.selected());
      let target: HTMLButtonElement | undefined;
      if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") target = tabs[0];
      else if (event.key === "End") target = tabs[tabs.length - 1];
      if (!target) return;
      event.preventDefault();
      this.select(target, { focus: true });
    });

    for (const [button, direction] of [
      [this.prev, -1],
      [this.next, 1],
    ] as const) {
      if (!button) continue;
      button.tabIndex = -1;
      // Scrolling the strip shouldn't take focus from wherever it is.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () =>
        this.list.scrollBy({ left: direction * this.list.clientWidth * 0.75, behavior: "smooth" }),
      );
    }
    this.list.addEventListener("scroll", () => this.updateScrollButtons());
    new ResizeObserver(() => this.updateScrollButtons()).observe(this.list);
    // Tabs added, removed, hidden or relabeled change what fits.
    new MutationObserver(() => this.updateScrollButtons()).observe(this.list, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["hidden"],
    });

    this.select(this.selected(), { focus: false });
  }

  // The visible tabs, in order.
  tabs(): HTMLButtonElement[] {
    return Array.from(this.list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter((tab) => !tab.hidden);
  }

  selected(): HTMLButtonElement {
    const tabs = this.tabs();
    return tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  }

  // Selects `tab` and shows its panel. With `focus`, also moves keyboard
  // focus to the tab.
  select(tab: HTMLButtonElement, options: { focus: boolean }): void {
    const changed = tab !== this.selected();
    for (const other of this.tabs()) {
      const isSelected = other === tab;
      other.setAttribute("aria-selected", String(isSelected));
      other.tabIndex = isSelected ? 0 : -1;
      const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !isSelected;
    }
    if (options.focus) tab.focus();
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.updateScrollButtons();
    if (changed) this.onSelect(tab.id);
  }

  // The next (1) or previous (-1) tab, wrapping around, for shortcuts that
  // switch tabs from anywhere in the dialog.
  step(direction: 1 | -1, options: { focus: boolean }): void {
    const tabs = this.tabs();
    const index = tabs.indexOf(this.selected());
    this.select(tabs[(index + direction + tabs.length) % tabs.length], options);
  }

  // Shows the ‹ › buttons only while the tabs overflow, each disabled once
  // the strip is scrolled all the way to its end.
  private updateScrollButtons(): void {
    const overflow = this.list.scrollWidth > this.list.clientWidth + 1;
    const atStart = this.list.scrollLeft <= 0;
    const atEnd = this.list.scrollLeft + this.list.clientWidth >= this.list.scrollWidth - 1;
    for (const [button, disabled] of [
      [this.prev, atStart],
      [this.next, atEnd],
    ] as const) {
      if (!button) continue;
      button.hidden = !overflow;
      button.disabled = disabled;
    }
  }
}
