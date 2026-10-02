import { TelnetSession, type TlsInfo } from "./telnet";
import type { World } from "./worlds-types";
import type { LogLevel } from "./logger";

type LogFn = (level: Exclude<LogLevel, "none">, ...args: unknown[]) => void;

export interface ConnectionManagerHandlers {
  // Connected/secure state changed (after a successful connect or any
  // disconnect) — refresh anything derived from it (menu, input-box color).
  onStateChange: () => void;
  // An ANSI-colored status line to append to the scrollback.
  onMessage: (text: string) => void;
  // Raw telnet traffic to append to the scrollback.
  onData: (data: Uint8Array) => void;
  // A successful connection, for MRU persistence.
  onConnected: (worldId: string) => void;
}

// Owns one window's TelnetSession plus the "what are we connected to, and
// how" bookkeeping (see TerminalWindow, which holds one of these each).
// All side effects (writing to the scrollback, persisting MRU, rebuilding
// the menu) are delegated back through `handlers` rather than owned here,
// so this class stays testable without an Electron window.
export class ConnectionManager {
  private session: TelnetSession | null = null;
  private connectedWorld: World | null = null;
  private connectedSecure = false;
  // The window's current size, applied to each new session so NAWS reports
  // it from the start rather than the 80x24 default.
  private cols = 80;
  private rows = 24;

  constructor(
    private readonly handlers: ConnectionManagerHandlers,
    private readonly log: LogFn,
  ) {}

  getConnectedWorld(): World | null {
    return this.connectedWorld;
  }

  isSecure(): boolean {
    return this.connectedSecure;
  }

  // Whether the telnet session is fully established (not just "a connect
  // attempt is in flight") — used to decide whether typed input can be sent.
  isConnected(): boolean {
    return this.session?.isConnected() ?? false;
  }

  // Whether a connection exists or is being attempted — a window in this
  // state opens a new window for its next connection rather than dropping
  // this one.
  isActive(): boolean {
    return this.session !== null;
  }

  connect(world: World): void {
    this.session?.disconnect();
    this.connectedWorld = null;
    this.connectedSecure = false;
    this.log("info", "connecting to", `${world.host}:${world.port}`, `(${world.name})`);
    this.handlers.onMessage(`\x1b[33m[connecting to ${world.name} (${world.host}:${world.port})...]\x1b[0m\r\n`);

    // Every callback checks it still belongs to the current session: a
    // replaced session's late close event must not tear down its successor.
    const session = new TelnetSession(
      {
        onConnect: (secure) => {
          if (this.session !== session) return;
          this.log("info", "connected to", world.name, secure ? "(TLS)" : "(plaintext)");
          this.connectedWorld = world;
          this.connectedSecure = secure;
          this.handlers.onConnected(world.id);
          this.handlers.onStateChange();
          this.handlers.onMessage(
            `\x1b[32m[connected to ${world.name}${secure ? ", securely (TLS)" : ""}]\x1b[0m\r\n`,
          );
        },
        onData: (data) => {
          if (this.session !== session) return;
          this.handlers.onData(data);
        },
        onDisconnect: (reason) => {
          if (this.session !== session) return;
          this.log(reason ? "error" : "info", reason ? `connection error: ${reason}` : "disconnected");
          this.session = null;
          this.connectedWorld = null;
          this.connectedSecure = false;
          this.handlers.onStateChange();
          this.handlers.onMessage(
            reason ? `\x1b[31m[connection error: ${reason}]\x1b[0m\r\n` : "\x1b[33m[disconnected]\x1b[0m\r\n",
          );
        },
        onTlsProbeResult: (secure, info?: TlsInfo) => {
          if (this.session !== session) return;
          if (!secure || !info) {
            this.handlers.onMessage("\x1b[33m[TLS not available, falling back to plaintext]\x1b[0m\r\n");
            return;
          }
          this.handlers.onMessage(
            `\x1b[32m[TLS available, connecting securely: ${info.protocol}, ${info.cipherName}]\x1b[0m\r\n`,
          );
          this.handlers.onMessage(
            `\x1b[32m[cert: ${info.certSubject} issued by ${info.certIssuer}, valid ${info.certValidFrom} to ${info.certValidTo}]\x1b[0m\r\n`,
          );
          if (!info.certValid) {
            this.handlers.onMessage(
              `\x1b[31m[warning: certificate is not valid: ${info.certValidationError}]\x1b[0m\r\n`,
            );
          }
        },
      },
      this.log,
    );
    this.session = session;
    session.resize(this.cols, this.rows);
    session.connect(world);
  }

  disconnect(): void {
    this.session?.disconnect();
  }

  sendLine(text: string): { echoed: boolean } {
    if (!this.session) return { echoed: false };
    return this.session.sendLine(text);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.session?.resize(cols, rows);
  }
}
