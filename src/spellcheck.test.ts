import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installBundledDictionaries, pickSpellCheckerLanguages, spellingMenuItems } from "./spellcheck";

const AVAILABLE = ["de-DE", "en", "en-AU", "en-CA", "en-GB", "en-US", "es", "es-419", "es-ES", "fr", "fr-FR", "pt-BR"];

test("pickSpellCheckerLanguages matches system languages exactly where it can", () => {
  assert.deepEqual(pickSpellCheckerLanguages(["en-GB"], AVAILABLE), ["en-GB"]);
  assert.deepEqual(pickSpellCheckerLanguages(["en-us"], AVAILABLE), ["en-US"]);
  assert.deepEqual(pickSpellCheckerLanguages(["pt_BR"], AVAILABLE), ["pt-BR"]);
});

test("pickSpellCheckerLanguages falls back to the base language, then any variant of it", () => {
  assert.deepEqual(pickSpellCheckerLanguages(["fr-CA"], AVAILABLE), ["fr"]);
  assert.deepEqual(pickSpellCheckerLanguages(["de-AT"], AVAILABLE), ["de-DE"]);
  assert.deepEqual(pickSpellCheckerLanguages(["de"], AVAILABLE), ["de-DE"]);
});

test("pickSpellCheckerLanguages keeps one dictionary per base language, in preference order", () => {
  assert.deepEqual(pickSpellCheckerLanguages(["en-US", "en-US", "en", "en"], AVAILABLE), ["en-US"]);
  assert.deepEqual(pickSpellCheckerLanguages(["fr-FR", "en-GB", "fr"], AVAILABLE), ["fr-FR", "en-GB"]);
});

test("pickSpellCheckerLanguages skips languages with no dictionary, and stops at three", () => {
  assert.deepEqual(pickSpellCheckerLanguages(["tlh", "ja-JP", "en-US"], AVAILABLE), ["en-US"]);
  assert.deepEqual(pickSpellCheckerLanguages([], AVAILABLE), []);
  assert.deepEqual(pickSpellCheckerLanguages(["en-US", "de", "fr", "es"], AVAILABLE), ["en-US", "de-DE", "fr"]);
});

test("installBundledDictionaries copies new .bdic files and leaves existing ones alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-spell-test-"));
  try {
    const from = path.join(root, "bundled");
    const to = path.join(root, "userData", "Dictionaries");
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, "en-US-10-1.bdic"), "bundled");
    fs.writeFileSync(path.join(from, "en-GB-10-1.bdic"), "bundled");
    fs.writeFileSync(path.join(from, "README.md"), "not a dictionary");
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "en-GB-10-1.bdic"), "already there");

    const errors: string[] = [];
    const copied = installBundledDictionaries(from, to, (file) => errors.push(file));
    assert.deepEqual(copied, ["en-US-10-1.bdic"]);
    assert.equal(errors.length, 0);
    assert.equal(fs.readFileSync(path.join(to, "en-GB-10-1.bdic"), "utf-8"), "already there");
    assert.deepEqual(fs.readdirSync(to).sort(), ["en-GB-10-1.bdic", "en-US-10-1.bdic"]);
    const again: string[] = installBundledDictionaries(from, to, (file) => errors.push(file));
    assert.deepEqual(again, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installBundledDictionaries reports a missing bundle instead of throwing", () => {
  const errors: string[] = [];
  const missing = path.join(os.tmpdir(), "moolin-no-such-dir", "dictionaries");
  const copied: string[] = installBundledDictionaries(missing, os.tmpdir(), (file) => errors.push(file));
  assert.deepEqual(copied, []);
  assert.deepEqual(errors, [missing]);
});

test("spellingMenuItems offers suggestions, then adding the word", () => {
  assert.deepEqual(spellingMenuItems("teh", ["the", "ten"]), [
    { kind: "replace", word: "the" },
    { kind: "replace", word: "ten" },
    { kind: "add", word: "teh" },
  ]);
});

test("spellingMenuItems says when there are no suggestions, and is empty for correct words", () => {
  assert.deepEqual(spellingMenuItems("xyzzy", []), [{ kind: "no-suggestions" }, { kind: "add", word: "xyzzy" }]);
  assert.deepEqual(spellingMenuItems("", ["anything"]), []);
});
