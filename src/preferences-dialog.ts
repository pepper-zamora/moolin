// Preferences dialog: app-wide settings, shown inside the terminal window's
// renderer like the Worlds dialog. There's no Save/Cancel — each control
// saves (and, for showTimestamps and the font, applies to this window) as
// soon as it's committed, the same as the Worlds dialog's fields.
import type { Preferences } from "./preferences";
import {
  MONOSPACE_FONTS,
  FONT_SAMPLE_LINES,
  FONT_SIZE_STEP,
  FONT_WEIGHTS,
  FONT_WIDTHS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type FontStyle,
  type FontWidth,
  applyFontStyle,
} from "./fonts";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const dialog = element<HTMLDialogElement>("preferences-dialog");
const timestampsInput = element<HTMLInputElement>("pref-show-timestamps");
const updatesInput = element<HTMLInputElement>("pref-check-updates");
const fontSizeInput = element<HTMLInputElement>("pref-font-size");
const fontSizeValue = element<HTMLOutputElement>("pref-font-size-value");
// The slider moves in the steps Ctrl+= and Ctrl+- do, over the same range.
fontSizeInput.min = String(MIN_FONT_SIZE);
fontSizeInput.max = String(MAX_FONT_SIZE);
fontSizeInput.step = String(FONT_SIZE_STEP);
const weightSelect = element<HTMLSelectElement>("pref-font-weight");
const widthSelect = element<HTMLSelectElement>("pref-font-width");
const italicInput = element<HTMLInputElement>("pref-font-italic");
const styleNote = element<HTMLElement>("pref-font-style-note");
const fontList = element<HTMLUListElement>("pref-font-list");
for (const { value, label } of FONT_WEIGHTS) weightSelect.add(new Option(label, String(value)));
for (const { value, label } of FONT_WIDTHS) widthSelect.add(new Option(label, value));

// Only the bundled font has width faces; any other font ignores the width.
const WIDTH_FONT_ID = "iosevka-moolin";

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

function currentStyle(): FontStyle {
  return { weight: Number(weightSelect.value), italic: italicInput.checked, width: widthSelect.value as FontWidth };
}

// Restyles every sample, and explains what the choices mean for the font picked.
function applySampleStyle(): void {
  const style = currentStyle();
  for (const sample of sampleEls) applyFontStyle(sample, style);
  const bundled = selectedFontId() === WIDTH_FONT_ID;
  widthSelect.disabled = !bundled;
  styleNote.hidden = bundled;
  styleNote.textContent =
    "Only Iosevka Moolin has every weight and a Condensed and Expanded width. Another font uses the closest " +
    "weight it has installed, and keeps its normal width.";
}

function applySampleSize(size: number): void {
  for (const sample of sampleEls) sample.style.fontSize = `${size}px`;
  fontSizeValue.value = `${size} px`;
}

function populate(prefs: Preferences): void {
  timestampsInput.checked = prefs.showTimestamps;
  updatesInput.checked = prefs.checkForUpdates;
  fontSizeInput.value = String(prefs.fontSize);
  applySampleSize(Number(fontSizeInput.value)); // as the slider snapped it to a step
  const radio = fontList.querySelector<HTMLInputElement>(`input[value="${prefs.fontId}"]`);
  if (radio) radio.checked = true;
  weightSelect.value = String(prefs.fontWeight);
  widthSelect.value = prefs.fontWidth;
  italicInput.checked = prefs.fontItalic;
  applySampleStyle();
}

function save(partial: Partial<Preferences>): void {
  void window.moolin.preferences.save(partial);
}

timestampsInput.addEventListener("change", () => save({ showTimestamps: timestampsInput.checked }));
updatesInput.addEventListener("change", () => save({ checkForUpdates: updatesInput.checked }));

// Live-updates every sample as the slider moves, but only saves (and so only
// applies to this window's terminal, and to later windows) once it is let go
// (or, from the keyboard, after each step).
fontSizeInput.addEventListener("input", () => applySampleSize(Number(fontSizeInput.value)));
fontSizeInput.addEventListener("change", () => {
  const size = Number(fontSizeInput.value);
  applySampleSize(size);
  save({ fontSize: size });
});

weightSelect.addEventListener("change", () => {
  applySampleStyle();
  save({ fontWeight: Number(weightSelect.value) });
});
widthSelect.addEventListener("change", () => {
  applySampleStyle();
  save({ fontWidth: widthSelect.value as FontWidth });
});
italicInput.addEventListener("change", () => {
  applySampleStyle();
  save({ fontItalic: italicInput.checked });
});

fontList.addEventListener("change", (event) => {
  if (!(event.target as HTMLElement).matches("input[name=font]")) return;
  applySampleStyle();
  save({ fontId: selectedFontId() });
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
