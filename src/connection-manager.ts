import { TelnetSession, type TlsInfo } from "./telnet";
import type { ConnectTarget } from "./worlds-types";
import { expandLoginTemplate, isConnectable, targetLabel, worldLabel } from "./world-utils";
import type { LogLevel } from "./logger";

type LogFn = (level: Exclude<LogLevel, "none">, ...args: unknown[]) => void;

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

// What the renderer is told about its window's connection.
export interface ConnectionState {
  status: ConnectionStatus;
  secure: boolean;
  // "Character - World" or "World"; null while disconnected.
  label: string | null;
}

export interface ConnectionManagerHandlers {
  // A connection attempt to `target` is about to begin, before any of its
  // output — the point to switch whatever records the window's output over
  // to that target.
  onConnecting: (target: ConnectTarget) => void;
  // Status or secure state changed (connecting, connected, or any
  // disconnect) — refresh anything derived from it (menu, title, input box).
  onStateChange: () => void;
  // An ANSI-colored status line to append to the scrollback.
  onMessage: (text: string) => void;
  // Raw telnet traffic to append to the scrollback.
  onData: (data: Uint8Array) => void;
  // A successful connection, for MRU persistence.
  onConnected: (target: ConnectTarget) => void;
}

const yellow = (text: string): string => `\x1b[33m[${text}]\x1b[0m\r\n`;
const green = (text: string): string => `\x1b[32m[${text}]\x1b[0m\r\n`;
const red = (text: string): string => `\x1b[31m[${text}]\x1b[0m\r\n`;

// Owns one window's TelnetSession plus the "what are we connected to, and
// how" bookkeeping (see TerminalWindow, which holds one of these each).
// All side effects (writing to the scrollback, persisting MRU, rebuilding
// the menu) are delegated back through `handlers` rather than owned here,
// so this class stays testable without an Electron window.
export class ConnectionManager {
  private session: TelnetSession | null = null;
  // Set from connect() until disconnect, including while connecting.
  private target: ConnectTarget | null = null;
  private connected = false;
  private secure = false;
  // The window's current size, applied to each new session so NAWS reports
  // it from the start rather than the 80x24 default.
  private cols = 80;
  private rows = 24;

  constructor(
    private readonly handlers: ConnectionManagerHandlers,
    private readonly log: LogFn,
  ) {}

  // The target of the established connection, or null if not connected.
  getConnected(): ConnectTarget | null {
    return this.connected ? this.target : null;
  }

  getState(): ConnectionState {
    return {
      status: this.connected ? "connected" : this.session ? "connecting" : "disconnected",
      secure: this.secure,
      label: this.target ? targetLabel(this.target.world, this.target.character) : null,
    };
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

  connect(target: ConnectTarget): void {
    const { world, character } = target;
    this.session?.disconnect();
    const label = targetLabel(world, character);
    if (!isConnectable(world) || world.port === null) {
      this.handlers.onMessage(red(`can't connect to ${label}: it needs a host and a port from 1 to 65535`));
      return;
    }
    this.target = target;
    this.connected = false;
    this.secure = false;
    const host = world.host.trim();
    const port = world.port;
    this.log("info", "connecting to", `${host}:${port}`, `(${label})`, world.tls ? "over TLS" : "");
    this.handlers.onConnecting(target);
    this.handlers.onMessage(yellow(`connecting to ${label} (${host}:${port}${world.tls ? ", TLS" : ""})...`));

    // Every callback checks it still belongs to the current session: a
    // replaced session's late close event must not tear down its successor.
    const session = new TelnetSession(
      {
        onConnect: (secure) => {
          if (this.session !== session) return;
          this.log("info", "connected to", label, secure ? "(TLS)" : "(plaintext)");
          this.connected = true;
          this.secure = secure;
          this.handlers.onConnected(target);
          this.handlers.onStateChange();
          this.handlers.onMessage(green(`connected to ${label}${secure ? ", securely (TLS)" : ""}`));
          if (character && world.autoLogin) {
            this.log("debug", "sending auto-login for", label);
            session.sendRaw(expandLoginTemplate(world.loginTemplate, character.name, character.password));
          }
        },
        onData: (data) => {
          if (this.session !== session) return;
          this.handlers.onData(data);
        },
        onDisconnect: (reason, certificateRejected) => {
          if (this.session !== session) return;
          this.log(reason ? "error" : "info", reason ? `connection error: ${reason}` : "disconnected");
          this.session = null;
          this.target = null;
          this.connected = false;
          this.secure = false;
          this.handlers.onStateChange();
          this.handlers.onMessage(reason ? red(`connection error: ${reason}`) : yellow("disconnected"));
          if (certificateRejected) {
            this.handlers.onMessage(
              yellow(`to connect anyway, turn on "Accept untrusted certificates" for ${worldLabel(world)}`),
            );
          }
        },
        onTlsInfo: (info: TlsInfo) => {
          if (this.session !== session) return;
          this.handlers.onMessage(green(`TLS: ${info.protocol}, ${info.cipherName}`));
          this.handlers.onMessage(
            green(`cert: ${info.certSubject} issued by ${info.certIssuer}, valid ${info.certValidFrom} to ${info.certValidTo}`),
          );
          if (!info.certValid) {
            this.handlers.onMessage(
              red(`warning: certificate is not trusted (${info.certValidationError}); connecting anyway as this world allows`),
            );
          }
        },
      },
      this.log,
    );
    this.session = session;
    session.resize(this.cols, this.rows);
    session.connect({ host, port, tls: world.tls, tlsAllowUntrusted: world.tlsAllowUntrusted });
    this.handlers.onStateChange();
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
