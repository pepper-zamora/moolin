import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WrongKeyError,
  createEnvelope,
  keyIdOf,
  normalizePhrase,
  open,
  parseEnvelope,
  rewrapEnvelope,
  seal,
  secretFromFile,
  unlockEnvelope,
} from "./crypto-keys";

// The smallest cost the parser accepts, so these tests don't each wait a tenth of a second.
const CHEAP = { N: 1 << 14, r: 8, p: 1 };
const aad = Buffer.from("context");

test("a data key comes back with the phrase it was wrapped under, and not with another", async () => {
  const { envelope, dataKey } = await createEnvelope(normalizePhrase("correct horse"), "phrase", CHEAP);
  assert.deepEqual(await unlockEnvelope(envelope, normalizePhrase("correct horse")), dataKey);
  await assert.rejects(unlockEnvelope(envelope, normalizePhrase("correct horse!")), WrongKeyError);
  await assert.rejects(unlockEnvelope(envelope, normalizePhrase("")), WrongKeyError);
  assert.equal(envelope.keyId, keyIdOf(dataKey));
  assert.equal(envelope.keySource, "phrase");
});

test("a phrase is the same however its accents were typed", async () => {
  const { envelope, dataKey } = await createEnvelope(normalizePhrase("café"), "phrase", CHEAP);
  assert.deepEqual(await unlockEnvelope(envelope, normalizePhrase("café")), dataKey);
});

test("a key file unlocks by its contents, whatever they are", async () => {
  const file = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const { envelope, dataKey } = await createEnvelope(secretFromFile(file), "file", CHEAP);
  assert.equal(envelope.keySource, "file");
  assert.deepEqual(await unlockEnvelope(envelope, secretFromFile(Buffer.from(file))), dataKey);
  await assert.rejects(unlockEnvelope(envelope, secretFromFile(Buffer.from([0, 1, 2]))), WrongKeyError);
});

test("re-wrapping keeps the data key, under a new phrase and a fresh salt", async () => {
  const first = await createEnvelope(normalizePhrase("one"), "phrase", CHEAP);
  const sealed = seal(first.dataKey, Buffer.from("secret"), aad);
  const second = await rewrapEnvelope(first.dataKey, secretFromFile(Buffer.from("a file")), "file", CHEAP);
  assert.notEqual(second.kdf.salt, first.envelope.kdf.salt);
  assert.equal(second.keyId, first.envelope.keyId);
  const dataKey = await unlockEnvelope(second, secretFromFile(Buffer.from("a file")));
  assert.equal(open(dataKey, sealed, aad).toString(), "secret", "what was sealed before still opens");
  await assert.rejects(unlockEnvelope(second, normalizePhrase("one")), WrongKeyError);
});

test("sealed data opens only with its key and its context, and shows no pattern", async () => {
  const { dataKey } = await createEnvelope(normalizePhrase("x"), "phrase", CHEAP);
  const other = (await createEnvelope(normalizePhrase("y"), "phrase", CHEAP)).dataKey;
  const sealed = seal(dataKey, Buffer.from("hunter2"), aad);
  assert.equal(open(dataKey, sealed, aad).toString(), "hunter2");
  assert.throws(() => open(other, sealed, aad));
  assert.throws(() => open(dataKey, sealed, Buffer.from("elsewhere")));
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 20] ^= 1;
  assert.throws(() => open(dataKey, flipped, aad), "a changed byte is caught");
  assert.throws(() => open(dataKey, sealed.subarray(0, 10), aad), "so is a short value");
  assert.notDeepEqual(seal(dataKey, Buffer.from("hunter2"), aad), sealed, "each seal uses a fresh nonce");
  assert.equal(sealed.includes(Buffer.from("hunter2")), false);
});

test("an envelope is read back only if it is well formed and its cost is sane", async () => {
  const { envelope } = await createEnvelope(normalizePhrase("x"), "phrase", CHEAP);
  const roundTripped = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
  assert.deepEqual(roundTripped, envelope);

  const change = (edit: (copy: { kdf: Record<string, unknown>; [key: string]: unknown }) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(envelope));
    edit(copy);
    return parseEnvelope(copy);
  };
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope("x"), null);
  assert.equal(
    change((e) => (e.version = 2)),
    null,
  );
  assert.equal(
    change((e) => (e.keySource = "magic")),
    null,
  );
  assert.equal(
    change((e) => (e.keyId = "nope")),
    null,
  );
  assert.equal(
    change((e) => (e.wrappedKey = "AAAA")),
    null,
  );
  assert.equal(
    change((e) => (e.kdf.name = "md5")),
    null,
  );
  assert.equal(
    change((e) => (e.kdf.salt = "AAAA")),
    null,
  );
  assert.equal(
    change((e) => (e.kdf.N = 1 << 30)),
    null,
    "a cost that would hang or exhaust memory",
  );
  assert.equal(
    change((e) => (e.kdf.N = 100)),
    null,
    "a cost so low it protects nothing",
  );
  assert.equal(
    change((e) => (e.kdf.N = (1 << 15) + 1)),
    null,
  );
  assert.equal(
    change((e) => (e.kdf.r = 0)),
    null,
  );
  assert.equal(
    change((e) => (e.kdf.p = 1000)),
    null,
  );
});

test("an envelope with its wrapped key altered is a wrong key, not a crash", async () => {
  const { envelope } = await createEnvelope(normalizePhrase("x"), "phrase", CHEAP);
  const bytes = Buffer.from(envelope.wrappedKey, "base64");
  bytes[20] ^= 1;
  await assert.rejects(
    unlockEnvelope({ ...envelope, wrappedKey: bytes.toString("base64") }, normalizePhrase("x")),
    WrongKeyError,
  );
});
