// Whether passwords and logs are encrypted, and the key that opens them while
// Moolin is unlocked (main process only; nothing in the page ever sees a key).
// No Electron in here, so it can be tested: the caller reads a key file or takes
// a phrase and hands over the secret.
//
//   off       no key phrase or file: everything is stored as it always was
//   locked    encryption is on, and nothing has been entered yet
//   unlocked  encryption is on, and the data key is in memory
import {
  DEFAULT_KDF,
  type KeyEnvelope,
  type KeySource,
  WrongKeyError,
  createEnvelope,
  rewrapEnvelope,
  unlockEnvelope,
} from "./crypto-keys";
import { log } from "./logger";
import { convertAllLogs } from "./log-convert";
import { type LogMode, PLAIN } from "./log-format";
import type { SessionLogRegistry } from "./session-log";
import { changeEncryption, readWorldsFile } from "./worlds";

export type SecurityState = "off" | "locked" | "unlocked";

// What the page is told: never a key.
export interface SecurityInfo {
  state: SecurityState;
  // How the key is entered; null while off.
  keySource: KeySource | null;
}

export interface Outcome {
  ok: boolean;
  error?: string;
  // Things that went wrong without undoing what was asked (a log that
  // couldn't be converted, say).
  warnings?: string[];
}

// What the page is asked at start: the state, and whether to offer setting up
// encryption now (once a run, when off and the user hasn't said never).
export interface SecurityPageState extends SecurityInfo {
  offer: boolean;
}

// Which form of the encryption dialog main asks the page to open.
export type SecurityDialogMode = "offer" | "unlock" | "manage";

const fail = (error: string): Outcome => ({ ok: false, error });

export class Security {
  private key: Buffer | null = null;
  private envelope: KeyEnvelope | null = null;
  // Operations take a while (scrypt, then converting logs) and must not overlap.
  private busy = false;

  constructor(
    private readonly worldsPath: string,
    private readonly logRoot: string,
    private readonly registry: SessionLogRegistry,
    // Only tests lower this.
    private readonly kdfCost: { N: number; r: number; p: number } = DEFAULT_KDF,
  ) {
    this.refresh();
  }

  // Looks in the worlds file for whether encryption is on. A file that can't be
  // read leaves what was known alone.
  refresh(): void {
    const read = readWorldsFile(this.worldsPath, null);
    if (read.error) {
      log("warn", "security", "could not tell whether encryption is on:", read.error);
      return;
    }
    this.envelope = read.encryption ?? null;
    if (!this.envelope) this.key = null;
  }

  // The data key, while unlocked.
  get dataKey(): Buffer | null {
    return this.key;
  }

  state(): SecurityState {
    return this.envelope ? (this.key ? "unlocked" : "locked") : "off";
  }

  info(): SecurityInfo {
    return { state: this.state(), keySource: this.envelope?.keySource ?? null };
  }

  // How logs are written now: null while locked, when none can be.
  logMode(): LogMode | null {
    if (this.state() === "off") return PLAIN;
    return this.key ? { kind: "encrypted", dataKey: this.key } : null;
  }

  private async exclusive(operation: () => Promise<Outcome>): Promise<Outcome> {
    if (this.busy) return fail("Another change to encryption is still in progress");
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      log("error", "security", "operation failed:", (error as Error).message);
      return fail((error as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private requireLogsClosed(): Outcome | null {
    return this.registry.anyOwned() ? fail("Disconnect every window first: a log is being written") : null;
  }

  // Converts the logs to the current mode, reporting those it could not.
  private async reconcileLogs(): Promise<string[]> {
    const mode = this.logMode();
    if (!mode) return [];
    try {
      const summary = await convertAllLogs(this.logRoot, mode, this.key, this.registry);
      return summary.failed.map(({ file, error }) => `${file}: ${error}`);
    } catch (error) {
      return [(error as Error).message];
    }
  }

  // Turns encryption on: the passwords are sealed first, so the key is on disk
  // before anything depends on it, and then the logs are converted.
  enable(secret: Buffer, source: KeySource): Promise<Outcome> {
    return this.exclusive(async () => {
      if (this.state() !== "off") return fail("Encryption is already on");
      const open = this.requireLogsClosed();
      if (open) return open;
      const { envelope, dataKey } = await createEnvelope(secret, source, this.kdfCost);
      changeEncryption(this.worldsPath, null, { envelope, dataKey });
      this.envelope = envelope;
      this.key = dataKey;
      const warnings = await this.reconcileLogs();
      return { ok: true, warnings };
    });
  }

  // Opens an encrypted install. The logs are brought up to date in the
  // background, in case a conversion was stopped part-way.
  unlock(secret: Buffer): Promise<Outcome> {
    return this.exclusive(async () => {
      if (this.state() !== "locked" || !this.envelope) return fail("Moolin isn't locked");
      let dataKey: Buffer;
      try {
        dataKey = await unlockEnvelope(this.envelope, secret);
      } catch (error) {
        if (error instanceof WrongKeyError) return fail(error.message);
        throw error;
      }
      const read = readWorldsFile(this.worldsPath, dataKey);
      if (read.error) return fail(read.error);
      this.key = dataKey;
      void this.reconcileLogs().then((problems) => {
        for (const problem of problems) log("warn", "security", "log not converted:", problem);
      });
      return { ok: true };
    });
  }

  // A new phrase or file for the same data key: nothing sealed needs to change.
  change(secret: Buffer, source: KeySource): Promise<Outcome> {
    return this.exclusive(async () => {
      if (this.state() !== "unlocked" || !this.key) return fail("Unlock Moolin first");
      const envelope = await rewrapEnvelope(this.key, secret, source, this.kdfCost);
      changeEncryption(this.worldsPath, this.key, { envelope, dataKey: this.key });
      this.envelope = envelope;
      return { ok: true };
    });
  }

  // Turns encryption off: the logs go back to plain first, and the worlds file
  // last, so a stop part-way leaves the key in place to finish it with.
  disable(): Promise<Outcome> {
    return this.exclusive(async () => {
      if (this.state() !== "unlocked" || !this.key) return fail("Unlock Moolin first");
      const open = this.requireLogsClosed();
      if (open) return open;
      const summary = await convertAllLogs(this.logRoot, PLAIN, this.key, this.registry);
      changeEncryption(this.worldsPath, this.key, null);
      this.envelope = null;
      this.key = null;
      return { ok: true, warnings: summary.failed.map(({ file, error }) => `${file}: ${error}`) };
    });
  }
}
