import type { World } from "./worlds-types";

window.addEventListener("error", (event) => {
  window.moolin.log("error", "worlds-renderer", "uncaught error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  window.moolin.log("error", "worlds-renderer", "unhandled rejection:", event.reason);
});

let worlds: World[] = [];
let selectedId: string | null = null;

const treeList = document.getElementById("tree-list") as HTMLUListElement;
const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("titlebar-close") as HTMLButtonElement;
const emptyMessage = document.getElementById("empty-message") as HTMLDivElement;
const form = document.getElementById("form") as HTMLDivElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const hostInput = document.getElementById("host-input") as HTMLInputElement;
const portInput = document.getElementById("port-input") as HTMLInputElement;

addBtn.title = "Add world (Ctrl+N)";
deleteBtn.title = "Delete selected world (Ctrl+D)";
connectBtn.title = "Connect (Enter)";

function selectedWorld(): World | undefined {
  return worlds.find((w) => w.id === selectedId);
}

function sortedWorlds(): World[] {
  return [...worlds].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function renderTree(): void {
  treeList.innerHTML = "";
  for (const world of sortedWorlds()) {
    const li = document.createElement("li");
    li.textContent = world.name || "(unnamed)";
    const isSelected = world.id === selectedId;
    li.classList.toggle("selected", isSelected);
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(isSelected));
    li.addEventListener("click", () => selectWorld(world.id));
    li.addEventListener("dblclick", () => {
      selectWorld(world.id);
      connectSelected();
    });
    treeList.appendChild(li);
  }
}

function renderForm(): void {
  const world = selectedWorld();
  deleteBtn.disabled = !world;
  connectBtn.disabled = !world;

  if (!world) {
    form.style.display = "none";
    emptyMessage.style.display = "flex";
    return;
  }

  emptyMessage.style.display = "none";
  form.style.display = "block";
  nameInput.value = world.name;
  hostInput.value = world.host;
  portInput.value = world.port ? String(world.port) : "";
}

function selectWorld(id: string): void {
  selectedId = id;
  renderTree();
  renderForm();
}

function persist(): void {
  window.moolin.log("debug", "worlds-renderer", "persisting", worlds.length, "world(s)");
  void window.moolin.worlds.save(worlds);
}

function updateSelected(patch: Partial<World>): void {
  const world = selectedWorld();
  if (!world) return;
  Object.assign(world, patch);
  renderTree();
  persist();
}

nameInput.addEventListener("change", () => {
  updateSelected({ name: nameInput.value.trim() || "(unnamed)" });
});

hostInput.addEventListener("change", () => {
  updateSelected({ host: hostInput.value.trim() });
});

portInput.addEventListener("change", () => {
  const port = parseInt(portInput.value, 10);
  updateSelected({ port: Number.isFinite(port) ? port : 0 });
});

function addWorld(): void {
  const world: World = {
    id: crypto.randomUUID(),
    name: "New World",
    host: "",
    port: 0,
  };
  window.moolin.log("debug", "worlds-renderer", "adding world", world.id);
  worlds.push(world);
  persist();
  selectWorld(world.id);
  nameInput.focus();
  nameInput.select();
}

addBtn.addEventListener("click", addWorld);

async function deleteSelected(): Promise<void> {
  const world = selectedWorld();
  if (!world) return;
  const confirmed = await window.moolin.confirm(`Delete world "${world.name}"? This cannot be undone.`);
  window.moolin.log("debug", "worlds-renderer", "delete", world.id, "confirmed =", confirmed);
  if (!confirmed) return;
  worlds = worlds.filter((w) => w.id !== world.id);
  selectedId = null;
  persist();
  renderTree();
  renderForm();
  // The native confirm dialog above steals focus; reclaim it so Up/Down
  // keeps working for deleting several entries in a row.
  treeList.focus();
}

deleteBtn.addEventListener("click", () => void deleteSelected());

function connectSelected(): void {
  const world = selectedWorld();
  if (!world) return;
  window.moolin.log("debug", "worlds-renderer", "connect requested for", world.id);
  void window.moolin.connect(world);
}

connectBtn.addEventListener("click", connectSelected);

closeBtn.addEventListener("click", () => window.close());

treeList.addEventListener("keydown", (event) => {
  const list = sortedWorlds();
  if (list.length === 0) return;
  const currentIndex = list.findIndex((w) => w.id === selectedId);

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      selectWorld(list[Math.min(currentIndex + 1, list.length - 1)].id);
      break;
    case "ArrowUp":
      event.preventDefault();
      selectWorld(list[Math.max(currentIndex - 1, 0)].id);
      break;
    case "Home":
      event.preventDefault();
      selectWorld(list[0].id);
      break;
    case "End":
      event.preventDefault();
      selectWorld(list[list.length - 1].id);
      break;
    case "Delete":
    case "Backspace":
      event.preventDefault();
      void deleteSelected();
      break;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
    return;
  }

  if (event.ctrlKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    void deleteSelected();
    return;
  }

  if (event.key === "Enter" && !connectBtn.disabled) {
    event.preventDefault();
    // Flush any in-progress field edit (only committed on blur/"change")
    // before reading the world's current data for the connect request.
    (document.activeElement as HTMLElement | null)?.blur?.();
    connectSelected();
  }
});

async function init(): Promise<void> {
  worlds = await window.moolin.worlds.load();
  window.moolin.log("debug", "worlds-renderer", "loaded", worlds.length, "world(s)");
  if (worlds.length > 0) {
    selectedId = sortedWorlds()[0].id;
  }
  renderTree();
  renderForm();
  treeList.focus();
}

// "New World" (Ctrl+N) is a global accelerator, so main can send this before
// this dialog's own async load has resolved — queue behind it so addWorld()
// never runs against a still-empty `worlds` array (which would clobber the
// saved file with just the one new entry).
const initPromise = init();

window.moolin.onCreateNewWorld(() => {
  void initPromise.then(() => addWorld());
});
