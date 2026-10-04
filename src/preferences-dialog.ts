// Preferences dialog: app-wide settings, shown inside the terminal window's
// renderer like the Worlds dialog. There's no Save/Cancel — each control
// saves (and, for showTimestamps and the font, applies to this window) as
// soon as it's committed, the same as the Worlds dialog's fields.
import type { Preferences } from "./preferences";
import { MONOSPACE_FONTS, FONT_SAMPLE_LINES, MIN_FONT_SIZE, clampFontSize } from "./fonts";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const dialog = element<HTMLDialogElement>("preferences-dialog");
const timestampsInput = element<HTMLInputElement>("pref-show-timestamps");
const updatesInput = element<HTMLInputElement>("pref-check-updates");
const fontSizeInput = element<HTMLInputElement>("pref-font-size");
const fontList = element<HTMLUListElement>("pref-font-list");

// One radio + live sample per curated font, built once up front; a later
// size change just restyles these rather than rebuilding the list.
const sampleEls: HTMLElement[] = [];
for (const font of MONOSPACE_FONTS) {
  const label = document.createElement("label");
  label.className = "font-option";

  const row = document.createElement("span");
  row.className = "font-option-row";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "font";
  radio.value = font.id;
  row.append(radio);
  const name = document.createElement("span");
  name.className = "font-option-label";
  name.textContent = font.label;
  row.append(name);
  label.append(row);

  const sample = document.createElement("div");
  sample.className = "font-sample";
  sample.style.fontFamily = font.cssFamily;
  for (const line of FONT_SAMPLE_LINES) {
    const sampleLine = document.createElement("div");
    sampleLine.textContent = line;
    sample.append(sampleLine);
  }
  sampleEls.push(sample);
  label.append(sample);

  const li = document.createElement("li");
  li.append(label);
  fontList.append(li);
}

function selectedFontId(): string {
  const checked = fontList.querySelector<HTMLInputElement>("input[name=font]:checked");
  return checked?.value ?? MONOSPACE_FONTS[0].id;
}

function applySampleSize(size: number): void {
  for (const sample of sampleEls) sample.style.fontSize = `${size}px`;
}

function populate(prefs: Preferences): void {
  timestampsInput.checked = prefs.showTimestamps;
  updatesInput.checked = prefs.checkForUpdates;
  fontSizeInput.value = String(prefs.fontSize);
  applySampleSize(prefs.fontSize);
  const radio = fontList.querySelector<HTMLInputElement>(`input[value="${prefs.fontId}"]`);
  if (radio) radio.checked = true;
}

function save(partial: Partial<Preferences>): void {
  void window.moolin.preferences.save(partial);
}

timestampsInput.addEventListener("change", () => save({ showTimestamps: timestampsInput.checked }));
updatesInput.addEventListener("change", () => save({ checkForUpdates: updatesInput.checked }));

// Live-updates every sample as the number input changes, but only saves (and
// so only applies to this window's terminal) once the value is committed.
fontSizeInput.addEventListener("input", () => {
  const size = Number(fontSizeInput.value);
  if (Number.isFinite(size)) applySampleSize(size);
});
fontSizeInput.addEventListener("change", () => {
  const size = clampFontSize(Number(fontSizeInput.value) || MIN_FONT_SIZE);
  fontSizeInput.value = String(size);
  applySampleSize(size);
  save({ fontSize: size });
});

fontList.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).matches("input[name=font]")) save({ fontId: selectedFontId() });
});

// Escape (built into <dialog>) or a click on the backdrop closes the dialog;
// edits are already saved. See worlds-dialog.ts for why the press has to
// start on the backdrop too.
let pressedOnBackdrop = false;
dialog.addEventListener("mousedown", (event) => {
  pressedOnBackdrop = event.target === dialog;
});
dialog.addEventListener("click", (event) => {
  if (pressedOnBackdrop && event.target === dialog) dialog.close();
});

export const preferencesDialog = {
  dialog,

  isOpen(): boolean {
    return dialog.open;
  },

  open(prefs: Preferences): void {
    populate(prefs);
    if (!dialog.open) dialog.showModal();
  },
};
