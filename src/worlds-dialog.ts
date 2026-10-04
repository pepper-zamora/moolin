// Worlds and characters dialog, shown inside the terminal window. Keeps the
// loaded copy of the worlds list, edits it in place and saves the whole list
// (via the main process) on each committed change.
import type { Character, World } from "./worlds-types";
import { characterLabel, isConnectable, newCharacter, newWorld, worldLabel } from "./world-utils";

// "global" is the root node, whose settings apply to every world and
// character beneath it.
type Selection = "global" | { worldId: string; characterId?: string };

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const dialog = element<HTMLDialogElement>("worlds-dialog");
const tree = element<HTMLUListElement>("worlds-tree");
const newWorldBtn = element<HTMLButtonElement>("new-world-btn");
const newCharacterBtn = element<HTMLButtonElement>("new-character-btn");
const errorEl = element<HTMLDivElement>("worlds-error");
const emptyPane = element<HTMLDivElement>("empty-pane");
const globalPane = element<HTMLDivElement>("global-pane");
const worldPane = element<HTMLFormElement>("world-pane");
const characterPane = element<HTMLFormElement>("character-pane");
const showPasswordBtn = element<HTMLButtonElement>("show-password-btn");
const connectBtn = element<HTMLButtonElement>("connect-btn");

function field(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

let worlds: World[] = [];
// Set when the worlds file exists but couldn't be read; editing is then
// disabled, and main refuses saves anyway, so the user's file isn't
// overwritten.
let loadError: string | null = null;
let selection: Selection | null = null;
const collapsed = new Set<string>();
// Reset each time the dialog opens, so every world starts out visible.
let globalCollapsed = false;

function findWorld(id: string): World | null {
  return worlds.find((w) => w.id === id) ?? null;
}

function selected(): { world: World | null; character: Character | null } {
  if (!selection || selection === "global") return { world: null, character: null };
  const world = findWorld(selection.worldId);
  const characterId = selection.characterId;
  const character = world && characterId ? (world.characters.find((c) => c.id === characterId) ?? null) : null;
  return { world, character };
}

function showError(message: string | null): void {
  errorEl.textContent = message ?? "";
  errorEl.hidden = !message;
}

// --- Loading and saving ---

async function load(): Promise<void> {
  const result = await window.moolin.worlds.load();
  loadError = result.error ?? null;
  worlds = result.worlds;
  showError(loadError ? `${loadError}. Changes will not be saved.` : null);
  newWorldBtn.disabled = !!loadError;
  // Drop a selection that no longer exists.
  const { world, character } = selected();
  if (selection !== "global" && (!world || (selection?.characterId && !character))) selection = null;
  render();
}

// Saves are chained so writes reach the file in order.
let saving: Promise<void> = Promise.resolve();
function save(): void {
  if (loadError) return;
  const snapshot = structuredClone(worlds);
  saving = saving.then(() => window.moolin.worlds.save(snapshot)).then((result) => showError(result.error ?? null));
}

// --- Tree ---

// Codicon-style 16px glyphs, drawn in currentColor.
const ICONS = {
  chevron:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  globe:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.75" ry="6.5"/><path d="M1.5 8h13M2.6 4.75h10.8M2.6 11.25h10.8"/></svg>',
  person:
    '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="4.75" r="3"/><path d="M2.5 14.5c0-3.2 2.4-5.25 5.5-5.25s5.5 2.05 5.5 5.25z"/></svg>',
};

function icon(svg: string, className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = svg;
  return span;
}

type ItemKind = "global" | "world" | "character";

// One tree item: its li and the row drawn inside it. `expanded` is null for
// an item with nothing to expand, which gets an empty twisty slot instead
// of a chevron so labels at the same depth still line up.
function makeItem(
  text: string,
  options: { kind: ItemKind; depth: number; expanded: boolean | null; isSelected: boolean },
): HTMLLIElement {
  const li = document.createElement("li");
  li.setAttribute("role", "treeitem");
  li.setAttribute("aria-level", String(options.depth + 1));
  li.setAttribute("aria-selected", String(options.isSelected));
  if (options.expanded !== null) li.setAttribute("aria-expanded", String(options.expanded));

  const row = document.createElement("div");
  row.className = `tree-row ${options.kind}${options.isSelected ? " selected" : ""}`;
  row.style.setProperty("--depth", String(options.depth));
  const twisty = icon(options.expanded === null ? "" : ICONS.chevron, "tree-twisty");
  if (options.expanded) twisty.classList.add("expanded");
  row.append(twisty);
  if (options.kind === "world") row.append(icon(ICONS.globe, "tree-icon world-icon"));
  if (options.kind === "character") row.append(icon(ICONS.person, "tree-icon character-icon"));
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = text;
  row.append(label);
  li.append(row);
  return li;
}

// The children of an item at `depth`; its indent guide hangs from that
// item's twisty.
function makeGroup(depth: number): HTMLUListElement {
  const group = document.createElement("ul");
  group.setAttribute("role", "group");
  group.style.setProperty("--depth", String(depth));
  return group;
}

function renderTree(): void {
  const root = makeItem("Global", {
    kind: "global",
    depth: 0,
    expanded: worlds.length ? !globalCollapsed : null,
    isSelected: selection === "global",
  });
  root.dataset.global = "true";

  if (!globalCollapsed && worlds.length) {
    const worldGroup = makeGroup(0);
    for (const world of worlds) {
      const hasCharacters = world.characters.length > 0;
      const expanded = !collapsed.has(world.id);
      const sel = selection === "global" ? null : selection;
      const li = makeItem(worldLabel(world), {
        kind: "world",
        depth: 1,
        expanded: hasCharacters ? expanded : null,
        isSelected: sel?.worldId === world.id && !sel.characterId,
      });
      li.dataset.worldId = world.id;

      if (expanded && hasCharacters) {
        const group = makeGroup(1);
        for (const character of world.characters) {
          const cli = makeItem(characterLabel(character), {
            kind: "character",
            depth: 2,
            expanded: null,
            isSelected: sel?.characterId === character.id,
          });
          cli.dataset.worldId = world.id;
          cli.dataset.characterId = character.id;
          group.append(cli);
        }
        li.append(group);
      }
      worldGroup.append(li);
    }
    root.append(worldGroup);
  }
  tree.replaceChildren(root);
  tree.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
}

// The tree items in display order, as selections.
function visibleItems(): Selection[] {
  const items: Selection[] = ["global"];
  if (globalCollapsed) return items;
  for (const world of worlds) {
    items.push({ worldId: world.id });
    if (!collapsed.has(world.id)) {
      for (const c of world.characters) items.push({ worldId: world.id, characterId: c.id });
    }
  }
  return items;
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === "global" || b === "global") return a === b;
  return !!a && !!b && a.worldId === b.worldId && (a.characterId ?? null) === (b.characterId ?? null);
}

function selectionFromEvent(event: Event): Selection | null {
  // A click in a character row bubbles through its world's li, but
  // closest() finds the innermost item, which is the one we want.
  const li = (event.target as HTMLElement).closest<HTMLElement>('li[role="treeitem"]');
  if (li?.dataset.global) return "global";
  if (!li?.dataset.worldId) return null;
  return { worldId: li.dataset.worldId, characterId: li.dataset.characterId };
}

function toggleWorld(worldId: string): void {
  if (collapsed.has(worldId)) collapsed.delete(worldId);
  else collapsed.add(worldId);
  // Collapsing a world hides a selected character; select the world.
  if (selection !== "global" && selection?.worldId === worldId && selection.characterId && collapsed.has(worldId)) {
    selection = { worldId };
  }
  render();
}

function toggleGlobal(): void {
  globalCollapsed = !globalCollapsed;
  // Collapsing hides every world and character; select the root instead.
  if (globalCollapsed && selection) selection = "global";
  render();
}

tree.addEventListener("click", (event) => {
  const sel = selectionFromEvent(event);
  if (!sel) return;
  if ((event.target as HTMLElement).closest(".tree-twisty svg")) {
    if (sel === "global") toggleGlobal();
    else if (!sel.characterId) toggleWorld(sel.worldId);
    return;
  }
  select(sel);
});

tree.addEventListener("dblclick", (event) => {
  const sel = selectionFromEvent(event);
  if (!sel || (event.target as HTMLElement).closest(".tree-twisty svg")) return;
  select(sel);
  if (!connectBtn.disabled) connect();
});

tree.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation(); // the terminal's own context menu is for the scrollback
  const sel = selectionFromEvent(event);
  if (!sel) return;
  select(sel);
  void showContextMenu();
});

tree.addEventListener("keydown", (event) => {
  const items = visibleItems();
  const index = items.findIndex((item) => sameSelection(item, selection));
  const { world } = selected();
  const characterId = selection !== "global" ? selection?.characterId : undefined;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!items.length) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    select(items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + step))]);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (items.length) select(items[event.key === "Home" ? 0 : items.length - 1]);
  } else if (event.key === "ArrowRight" && selection === "global") {
    event.preventDefault();
    if (globalCollapsed) toggleGlobal();
    else if (worlds.length) select({ worldId: worlds[0].id });
  } else if (event.key === "ArrowLeft" && selection === "global") {
    event.preventDefault();
    if (!globalCollapsed && worlds.length) toggleGlobal();
  } else if (event.key === "ArrowRight" && world && !characterId) {
    event.preventDefault();
    if (collapsed.has(world.id)) toggleWorld(world.id);
    else if (world.characters.length) select({ worldId: world.id, characterId: world.characters[0].id });
  } else if (event.key === "ArrowLeft" && world) {
    // As in VS Code: collapse an expanded world, otherwise go to the parent.
    event.preventDefault();
    if (characterId) select({ worldId: world.id });
    else if (world.characters.length && !collapsed.has(world.id)) toggleWorld(world.id);
    else select("global");
  } else if (event.key === "Enter" && world) {
    event.preventDefault();
    if (!connectBtn.disabled) connect();
  } else if (event.key === "Delete" && world) {
    event.preventDefault();
    void (characterId ? deleteCharacter() : deleteWorld());
  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    if (world) void showContextMenu();
  }
});

async function showContextMenu(): Promise<void> {
  const { world, character } = selected();
  if (!world || loadError) return;
  const items = character
    ? [{ id: "delete-character", label: "Delete Character" }]
    : [
        { id: "add-character", label: "Add Character" },
        { id: "delete-world", label: "Delete World" },
      ];
  const choice = await window.moolin.popupMenu(items);
  if (choice === "add-character") addCharacter();
  else if (choice === "delete-world") await deleteWorld();
  else if (choice === "delete-character") await deleteCharacter();
}

// --- Commands ---

function createWorld(): void {
  if (loadError) return;
  const world = newWorld(crypto.randomUUID());
  worlds.push(world);
  globalCollapsed = false;
  save();
  select({ worldId: world.id });
  focusName(worldPane);
}

// Adds to the selected world, or to the selected character's world.
function addCharacter(): void {
  const { world } = selected();
  if (!world || loadError) return;
  const character = newCharacter(crypto.randomUUID());
  world.characters.push(character);
  collapsed.delete(world.id);
  save();
  select({ worldId: world.id, characterId: character.id });
  focusName(characterPane);
}

async function deleteWorld(): Promise<void> {
  const { world } = selected();
  if (!world) return;
  const count = world.characters.length;
  const extra = count ? ` and its ${count} character${count === 1 ? "" : "s"}` : "";
  // The native confirm dialog takes focus; give it back to the tree after,
  // so Up/Down keeps working for deleting several entries in a row.
  const confirmed = await window.moolin.confirm(`Delete the world "${worldLabel(world)}"${extra}?`);
  tree.focus();
  if (!confirmed) return;
  const index = worlds.indexOf(world);
  worlds.splice(index, 1);
  collapsed.delete(world.id);
  save();
  const next = worlds[Math.min(index, worlds.length - 1)];
  select(next ? { worldId: next.id } : null);
}

async function deleteCharacter(): Promise<void> {
  const { world, character } = selected();
  if (!world || !character) return;
  const confirmed = await window.moolin.confirm(`Delete the character "${characterLabel(character)}"?`);
  tree.focus();
  if (!confirmed) return;
  const index = world.characters.indexOf(character);
  world.characters.splice(index, 1);
  save();
  const next = world.characters[Math.min(index, world.characters.length - 1)];
  select(next ? { worldId: world.id, characterId: next.id } : { worldId: world.id });
}

function connect(): void {
  const { world, character } = selected();
  if (!world) return;
  window.moolin.connect(structuredClone(world), character?.id ?? null);
  dialog.close();
}

// --- Content pane ---

function focusName(form: HTMLFormElement): void {
  const name = field(form, "name");
  name.focus();
  name.select();
}

function fillWorldPane(world: World): void {
  field(worldPane, "name").value = world.name;
  field(worldPane, "host").value = world.host;
  field(worldPane, "port").value = world.port === null ? "" : String(world.port);
  field(worldPane, "tls").checked = world.tls;
  field(worldPane, "tlsAllowUntrusted").checked = world.tlsAllowUntrusted;
  field(worldPane, "autoLogin").checked = world.autoLogin;
  field(worldPane, "loginTemplate").value = world.loginTemplate;
  field(worldPane, "echoCommands").checked = world.echoCommands;
  updateDependentFields(world);
}

// Fields that only apply when another one is checked.
function updateDependentFields(world: World): void {
  field(worldPane, "tlsAllowUntrusted").disabled = !!loadError || !world.tls;
  field(worldPane, "loginTemplate").disabled = !!loadError || !world.autoLogin;
}

function fillCharacterPane(character: Character): void {
  field(characterPane, "name").value = character.name;
  const password = field(characterPane, "password");
  password.value = character.password;
  password.type = "password";
  showPasswordBtn.textContent = "Show";
}

function updateButtons(): void {
  const { world } = selected();
  connectBtn.disabled = !world || !isConnectable(world);
  // Hidden rather than removed, so New World keeps its half of the row.
  newCharacterBtn.style.visibility = world ? "visible" : "hidden";
  newCharacterBtn.disabled = !world || !!loadError;
}

function render(): void {
  renderTree();
  const { world, character } = selected();
  emptyPane.hidden = !!world || selection === "global";
  globalPane.hidden = selection !== "global";
  worldPane.hidden = !world || !!character;
  characterPane.hidden = !character;
  for (const form of [worldPane, characterPane]) {
    for (const el of Array.from(form.elements)) (el as HTMLInputElement).disabled = !!loadError;
  }
  if (character) fillCharacterPane(character);
  else if (world) fillWorldPane(world);
  updateButtons();
}

function select(sel: Selection | null): void {
  if (sameSelection(sel, selection)) return;
  selection = sel;
  render();
}

// Edits update the model as they're typed and are saved when committed.
worldPane.addEventListener("input", (event) => {
  const { world } = selected();
  if (!world) return;
  const el = event.target as HTMLInputElement;
  switch (el.name) {
    case "port":
      world.port = el.value.trim() === "" ? null : Number(el.value);
      break;
    case "tls":
    case "tlsAllowUntrusted":
    case "autoLogin":
    case "echoCommands":
      world[el.name] = el.checked;
      updateDependentFields(world);
      break;
    case "name":
    case "host":
    case "loginTemplate":
      world[el.name] = el.value;
      break;
  }
  if (el.name === "name" || el.name === "host") renderTree();
  updateButtons();
});

characterPane.addEventListener("input", (event) => {
  const { character } = selected();
  if (!character) return;
  const el = event.target as HTMLInputElement;
  if (el.name === "name" || el.name === "password") character[el.name] = el.value;
  if (el.name === "name") renderTree();
});

worldPane.addEventListener("change", save);
characterPane.addEventListener("change", save);
// Enter in a field commits it rather than submitting the form.
for (const form of [worldPane, characterPane]) {
  form.addEventListener("submit", (event) => event.preventDefault());
}

showPasswordBtn.addEventListener("click", () => {
  const password = field(characterPane, "password");
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  showPasswordBtn.textContent = show ? "Hide" : "Show";
});

newWorldBtn.addEventListener("click", createWorld);
newCharacterBtn.addEventListener("click", addCharacter);
connectBtn.addEventListener("click", connect);

// Escape (built into <dialog>) or a click on the backdrop closes the dialog;
// edits are already saved. The dialog's content fills its box, so only the
// backdrop reports the dialog itself as the target. Requiring the press to
// start there too keeps a text selection dragged out of a field from
// closing it.
let pressedOnBackdrop = false;
dialog.addEventListener("mousedown", (event) => {
  pressedOnBackdrop = event.target === dialog;
});
dialog.addEventListener("click", (event) => {
  if (pressedOnBackdrop && event.target === dialog) dialog.close();
});

// Another window saved the worlds file; pick up its changes.
window.moolin.worlds.onChanged(() => {
  if (dialog.open) void load();
});

// Alt+letter presses the button whose label has that letter underlined.
// Alt+W, Alt+E and Alt+V are left alone: they open the menu bar's menus.
const mnemonics: Record<string, HTMLButtonElement> = { n: newWorldBtn, h: newCharacterBtn, c: connectBtn };

dialog.addEventListener("keydown", (event) => {
  if (event.key === "Alt") dialog.classList.add("show-mnemonics");
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const button = mnemonics[event.key.toLowerCase()];
  if (!button) return;
  event.preventDefault();
  if (!button.disabled && button.style.visibility !== "hidden") button.click();
});
// The underlines show only while Alt is held, as in GTK and Windows.
dialog.addEventListener("keyup", (event) => {
  if (event.key === "Alt") dialog.classList.remove("show-mnemonics");
});
window.addEventListener("blur", () => dialog.classList.remove("show-mnemonics"));
dialog.addEventListener("close", () => dialog.classList.remove("show-mnemonics"));

export const worldsDialog = {
  dialog,

  isOpen(): boolean {
    return dialog.open;
  },

  async open(options: { createNew?: boolean } = {}): Promise<void> {
    if (!dialog.open) {
      globalCollapsed = false;
      await load();
      dialog.showModal();
    }
    if (options.createNew) {
      createWorld();
    } else {
      tree.focus();
    }
  },
};
