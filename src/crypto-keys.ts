// The keys behind encryption at rest (main process only). One random data key
// encrypts the passwords and logs; the user's key phrase or key file only
// wraps that data key, so changing the phrase or file re-wraps one small value
// instead of re-encrypting every log. Built on node:crypto alone: scrypt to
// turn a phrase into a wrapping key, AES-256-GCM for everything sealed.
import * as crypto from "node:crypto";
import * as fs from "node:fs";

export type KeySource = "phrase" | "file";

export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
  // base64
  salt: string;
}

// Stored in the worlds file, whose presence there is what says passwords and
// logs are encrypted.
export interface KeyEnvelope {
  version: 1;
  kdf: KdfParams;
  keySource: KeySource;
  // The data key sealed under the key made from the phrase or file (base64).
  wrappedKey: string;
  // Names the data key without revealing it, so a log can say which key it
  // needs and a wrong key is told from a damaged file.
  keyId: string;
}

// Raised when the phrase or key file doesn't open the envelope.
export class WrongKeyError extends Error {
  constructor() {
    super("That key phrase or key file doesn't match");
    this.name = "WrongKeyError";
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const ENVELOPE_AAD = Buffer.from("moolin key envelope v1");

// scrypt's cost for new envelopes (about a tenth of a second). A read envelope's
// own parameters are used, within the bounds below, so they can be raised later.
export const DEFAULT_KDF = { N: 1 << 15, r: 8, p: 1 } as const;
const MIN_N = 1 << 14;
const MAX_R = 32;
const MAX_P = 16;
// What a read envelope's parameters may ask of this machine: scrypt needs about
// 128 * N * r bytes, which must fit in what crypto.scrypt is allowed (with room
// to spare), and N * r * p bounds the time (the default is 2^18, about 0.1 s).
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
const MAX_KDF_MEMORY = SCRYPT_MAXMEM / 2;
const MAX_KDF_WORK = 1 << 24;

export function normalizePhrase(phrase: string): Buffer {
  return Buffer.from(phrase.normalize("NFC"), "utf8");
}

// A key file's contents stand in for a phrase, whatever they are: what is used
// is the SHA-256 of the file at `file`, read a piece at a time so a file of any
// size works without being held in memory.
export function secretFromFilePath(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest()));
  });
}

export function keyIdOf(dataKey: Buffer): string {
  return crypto.createHmac("sha256", dataKey).update("moolin key id").digest("hex").slice(0, 16);
}

function scrypt(secret: Buffer, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      secret,
      Buffer.from(kdf.salt, "base64"),
      KEY_BYTES,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

// nonce | ciphertext | tag. `aad` is authenticated but not stored: opening
// with different AAD fails, which keeps a sealed value from being moved to
// somewhere it doesn't belong.
export function seal(key: Buffer, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad as Buffer);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

// Throws (a WrongKeyError is for the envelope; here it's whatever node says)
// when the key, the AAD or the data is not what it was sealed with.
export function open(key: Buffer, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error("sealed data is too short");
  const buffer = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, NONCE_BYTES));
  decipher.setAAD(aad as Buffer);
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
  return Buffer.concat([decipher.update(buffer.subarray(NONCE_BYTES, buffer.length - TAG_BYTES)), decipher.final()]);
}

async function wrap(dataKey: Buffer, secret: Buffer, keySource: KeySource, kdf: KdfParams): Promise<KeyEnvelope> {
  const wrappingKey = await scrypt(secret, kdf);
  return {
    version: 1,
    kdf,
    keySource,
    wrappedKey: seal(wrappingKey, dataKey, ENVELOPE_AAD).toString("base64"),
    keyId: keyIdOf(dataKey),
  };
}

function newKdf(cost: { N: number; r: number; p: number }): KdfParams {
  return { name: "scrypt", ...cost, salt: crypto.randomBytes(SALT_BYTES).toString("base64") };
}

// A new random data key, wrapped under `secret` (a normalised phrase, or a key
// file's secretFromFile). `cost` is only for tests, which don't want to wait.
export async function createEnvelope(
  secret: Buffer,
  keySource: KeySource,
  cost: { N: number; r: number; p: number } = DEFAULT_KDF,
): Promise<{ envelope: KeyEnvelope; dataKey: Buffer }> {
  const dataKey = crypto.randomBytes(KEY_BYTES);
  return { envelope: await wrap(dataKey, secret, keySource, newKdf(cost)), dataKey };
}

// The data key, if `secret` is the one it was wrapped under.
export async function unlockEnvelope(envelope: KeyEnvelope, secret: Buffer): Promise<Buffer> {
  const wrappingKey = await scrypt(secret, envelope.kdf);
  let dataKey: Buffer;
  try {
    dataKey = open(wrappingKey, Buffer.from(envelope.wrappedKey, "base64"), ENVELOPE_AAD);
  } catch {
    throw new WrongKeyError();
  }
  if (dataKey.length !== KEY_BYTES || keyIdOf(dataKey) !== envelope.keyId) throw new WrongKeyError();
  return dataKey;
}

// The same data key under a new phrase or file, with a fresh salt. Nothing
// sealed with the data key needs to change.
export async function rewrapEnvelope(
  dataKey: Buffer,
  secret: Buffer,
  keySource: KeySource,
  cost: { N: number; r: number; p: number } = DEFAULT_KDF,
): Promise<KeyEnvelope> {
  return wrap(dataKey, secret, keySource, newKdf(cost));
}

function isBase64Of(value: unknown, bytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return bytes === undefined || Buffer.from(value, "base64").length === bytes;
}

// Checks an envelope read from a file, which may have been edited or damaged.
// Its scrypt cost is bounded (see MAX_KDF_MEMORY and MAX_KDF_WORK), so a hostile
// file can't make unlocking hang or run out of memory, and everything accepted
// is something unlocking can run.
export function parseEnvelope(value: unknown): KeyEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, kdf, keySource, wrappedKey, keyId } = value as Record<string, unknown>;
  if (version !== 1 || (keySource !== "phrase" && keySource !== "file")) return null;
  if (typeof keyId !== "string" || !/^[0-9a-f]{16}$/.test(keyId)) return null;
  if (!isBase64Of(wrappedKey, NONCE_BYTES + KEY_BYTES + TAG_BYTES)) return null;
  if (typeof kdf !== "object" || kdf === null) return null;
  const { name, N, r, p, salt } = kdf as Record<string, unknown>;
  if (name !== "scrypt" || !isBase64Of(salt, SALT_BYTES)) return null;
  if (typeof N !== "number" || !Number.isInteger(N) || N < MIN_N || (N & (N - 1)) !== 0) return null;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  if (128 * N * r > MAX_KDF_MEMORY || N * r * p > MAX_KDF_WORK) return null;
  return { version: 1, kdf: { name: "scrypt", N, r, p, salt }, keySource, wrappedKey, keyId };
}
