// The encryption dialog: the first-run offer, setting it up from the menu,
// unlocking at start, and managing it (changing the phrase or file, stopping).
// One form whose parts are shown for the mode it is opened in. A key phrase is
// sent to the main process once and kept nowhere here; a key file is chosen in
// a picker main shows, so no path passes through the page.
import type { Outcome, SecurityDialogMode, SecurityInfo } from "./security";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const dialog = element<HTMLDialogElement>("encryption-dialog");
const form = element<HTMLFormElement>("enc-form");
const title = element<HTMLElement>("enc-title");
const intro = element<HTMLElement>("enc-intro");
const newSection = element<HTMLElement>("enc-new");
const phraseInput = element<HTMLInputElement>("enc-phrase");
const confirmInput = element<HTMLInputElement>("enc-confirm");
const hint = element<HTMLElement>("enc-hint");
const unlockSection = element<HTMLElement>("enc-unlock");
const unlockPhrase = element<HTMLInputElement>("enc-unlock-phrase");
const fileRow = element<HTMLElement>("enc-file-row");
const fileButton = element<HTMLButtonElement>("enc-file-btn");
const manageSection = element<HTMLElement>("enc-manage");
const changeButton = element<HTMLButtonElement>("enc-change-btn");
const stopButton = element<HTMLButtonElement>("enc-stop-btn");
const neverRow = element<HTMLElement>("enc-never-row");
const neverBox = element<HTMLInputElement>("enc-never");
const errorEl = element<HTMLElement>("enc-error");
const warningsEl = element<HTMLUListElement>("enc-warnings");
const workingEl = element<HTMLElement>("enc-working");
const primary = element<HTMLButtonElement>("enc-primary");
const cancel = element<HTMLButtonElement>("enc-cancel");

// Phrases shorter than this get a nudge (not a refusal).
const SHORT_PHRASE = 12;

const LOSS_WARNING =
  "If you lose the key phrase or file, your passwords and logs cannot be recovered: there is no reset.";

// "change" is the new-secret form reached from the manage view.
type View = SecurityDialogMode | "change";

let view: View = "offer";
let info: SecurityInfo = { state: "off", keySource: null };
let working = false;
// Whether the dialog ended with an answer, so that closing it any other way
// (Escape) still counts as "Not now" on the offer.
let answered = false;
// The call in progress or just finished showed the user warnings; Close then.
let finished = false;

function show(el: HTMLElement, visible: boolean): void {
  el.hidden = !visible;
}

function render(): void {
  const isNew = view === "offer" || view === "setup" || view === "change";
  show(newSection, isNew);
  show(unlockSection, view === "unlock");
  show(fileRow, isNew || view === "unlock");
  show(manageSection, view === "manage");
  show(neverRow, view === "offer");
  show(hint, isNew);
  show(workingEl, working);
  for (const el of [phraseInput, confirmInput, unlockPhrase, fileButton, changeButton, stopButton, cancel]) {
    (el as HTMLInputElement).disabled = working || finished;
  }
  primary.disabled = working;

  switch (view) {
    case "offer":
    case "setup":
      title.textContent = "Encrypt your passwords and logs?";
      intro.textContent =
        "Moolin can encrypt your characters' passwords and your session logs with a key phrase or a key file, " +
        `so that others who can read your files cannot. ${LOSS_WARNING} You can turn it off again later.`;
      primary.textContent = "Encrypt";
      cancel.textContent = view === "offer" ? "Not now" : "Cancel";
      break;
    case "change":
      title.textContent = "Change the key phrase or file";
      intro.textContent = `Your passwords and logs stay as they are; only what unlocks them changes. ${LOSS_WARNING}`;
      primary.textContent = "Change";
      cancel.textContent = "Cancel";
      break;
    case "unlock":
      title.textContent = "Unlock Moolin";
      intro.textContent = `Enter your key phrase or choose your key file to unlock your passwords and logs. ${LOSS_WARNING}`;
      primary.textContent = "Unlock";
      cancel.textContent = "Cancel";
      break;
    case "manage":
      title.textContent = "Encryption is on";
      intro.textContent = `Your passwords and logs are encrypted with a ${info.keySource === "file" ? "key file" : "key phrase"}.`;
      primary.textContent = "Close";
      cancel.textContent = "";
      break;
  }
  cancel.hidden = view === "manage";
  if (finished) {
    primary.textContent = "Close";
    cancel.hidden = true;
  }
}

function showError(message: string | null): void {
  errorEl.textContent = message ?? "";
  show(errorEl, !!message);
}

function showWarnings(warnings: string[]): void {
  warningsEl.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    }),
  );
  show(warningsEl, warnings.length > 0);
}

function clearSecrets(): void {
  for (const input of [phraseInput, confirmInput, unlockPhrase]) input.value = "";
}

// Runs a call to main, with the form held still while it works.
async function run(call: () => Promise<Outcome>): Promise<void> {
  showError(null);
  working = true;
  render();
  let outcome: Outcome;
  try {
    outcome = await call();
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  working = false;
  if (!outcome.ok) {
    render();
    // No error means the user cancelled a picker: nothing to say.
    if (outcome.error) showError(outcome.error);
    return;
  }
  answered = true;
  clearSecrets();
  if (outcome.warnings && outcome.warnings.length > 0) {
    showWarnings(["Done, but some logs could not be converted and were left as they were:", ...outcome.warnings]);
    finished = true;
    render();
    return;
  }
  dialog.close();
}

function newSecretCall(): (() => Promise<Outcome>) | null {
  const phrase = phraseInput.value;
  if (phrase.length === 0) {
    showError("Enter a key phrase, or choose a key file.");
    return null;
  }
  if (phrase !== confirmInput.value) {
    showError("The two phrases don't match.");
    return null;
  }
  const request = { source: "phrase", phrase } as const;
  return () => (view === "change" ? window.moolin.security.change(request) : window.moolin.security.setup(request));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (working) return;
  if (finished || view === "manage") {
    dialog.close();
    return;
  }
  if (view === "unlock") {
    if (unlockPhrase.value.length === 0) {
      showError("Enter your key phrase, or choose your key file.");
      return;
    }
    const request = { source: "phrase", phrase: unlockPhrase.value } as const;
    void run(() => window.moolin.security.unlock(request));
    return;
  }
  const call = newSecretCall();
  if (call) void run(call);
});

fileButton.addEventListener("click", () => {
  const request = { source: "file" } as const;
  if (view === "unlock") void run(() => window.moolin.security.unlock(request));
  else
    void run(() =>
      view === "change" ? window.moolin.security.change(request) : window.moolin.security.setup(request),
    );
});

changeButton.addEventListener("click", () => {
  view = "change";
  showError(null);
  render();
  phraseInput.focus();
});

stopButton.addEventListener("click", () => void run(() => window.moolin.security.disable()));

cancel.addEventListener("click", () => dialog.close());

phraseInput.addEventListener("input", () => {
  hint.textContent =
    phraseInput.value.length > 0 && phraseInput.value.length < SHORT_PHRASE
      ? "That phrase is short, and easy to guess. A longer one protects far better."
      : "Use a long phrase: it is all that stands between your files and anyone who gets them.";
});

dialog.addEventListener("close", () => {
  // Closing the offer without answering it (Not now, Escape) declines it;
  // with the box ticked, for good.
  if (view === "offer" && !answered) window.moolin.security.decline(neverBox.checked);
  clearSecrets();
  neverBox.checked = false;
  working = false;
  finished = false;
});

export const encryptionDialog = {
  dialog,

  isOpen(): boolean {
    return dialog.open;
  },

  // Lets the dialog know the state, which the manage view describes.
  setInfo(next: SecurityInfo): void {
    info = next;
    if (dialog.open) render();
  },

  open(mode: SecurityDialogMode): void {
    if (dialog.open) return;
    view = mode;
    answered = false;
    finished = false;
    working = false;
    showError(null);
    showWarnings([]);
    clearSecrets();
    render();
    dialog.showModal();
    (view === "unlock" ? unlockPhrase : view === "manage" ? primary : phraseInput).focus();
  },
};
