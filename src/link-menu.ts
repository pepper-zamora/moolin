// The popup listing a Pueblo link's commands, for a link that offers several
// (a left click sends the first; right-click opens this to pick another).
export class LinkMenu {
  private readonly root = document.createElement("div");

  constructor(private readonly onPick: (command: string) => void) {
    this.root.id = "link-menu";
    this.root.setAttribute("role", "menu");
    this.root.hidden = true;
    // Picking an item shouldn't move keyboard focus off the input area.
    this.root.addEventListener("mousedown", (event) => event.preventDefault());
    document.body.append(this.root);

    document.addEventListener(
      "mousedown",
      (event) => {
        if (!this.root.contains(event.target as Node)) this.hide();
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || this.root.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        this.hide();
      },
      true,
    );
    window.addEventListener("blur", () => this.hide());
    window.addEventListener("resize", () => this.hide());
  }

  show(commands: string[], x: number, y: number): void {
    const items = commands.map((command) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = command;
      item.addEventListener("click", () => {
        this.hide();
        this.onPick(command);
      });
      return item;
    });
    this.root.replaceChildren(...items);
    this.root.hidden = false;
    // Kept inside the window, opening up or left when it would run off.
    const { width, height } = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
    this.root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
