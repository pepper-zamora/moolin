import { GreetingDetector } from "./pueblo";
import { TelnetSession, type TlsInfo } from "./telnet";
import type { ConnectTarget } from "./worlds-types";
import { expandLoginTemplate, isConnectable, targetLabel, worldLabel } from "./world-utils";
import type { LogLevel } from "./logger";

type LogFn = (level: Exclude<LogLevel, "none">, ...args: unknown[]) => void;

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

// The cascading settings (see world-utils.ts's resolveTriState) resolved for
// one connection, snapshotted at connect time — same timing as everything
// else a World/Character setting controls (see README's "a connection keeps
// the settings its world had when it connected").
export interface ResolvedSettings {
  wordWrap: boolean;
  echoCommands: boolean;
}

// What the renderer is told about its window's connection.
export interface ConnectionState {
  status: ConnectionStatus;
  // "Character - World" or "World"; null while disconnected.
  label: string | null;
  // "host:port"; null while disconnected.
  address: string | null;
  // The TLS handshake's details once connected over TLS; null on a
  // plaintext connection, and while connecting or disconnected.
  tls: TlsInfo | null;
  // Resolved from Global/World/Character at connect time; false while
  // disconnected.
  wordWrap: boolean;
}

// What the renderer is told about its window: the connection, plus whether
// the window is writing it to the session log.
export interface WindowState extends ConnectionState {
  // False when another window connected to the same world/character already
  // owns that log, and while disconnected.
  logging: boolean;
}

export interface ConnectionManagerHandlers {
  // A connection attempt to `target` is about to begin, before any of its
  // output — the point to switch whatever records the window's output over
  // to that target.
  onConnecting: (target: ConnectTarget) => void;
  // Status or TLS state changed (connecting, connected, or any
  // disconnect) — refresh anything derived from it (menu, title, input box).
  onStateChange: () => void;
  // An ANSI-colored status line to append to the scrollback.
  onMessage: (text: string) => void;
  // Raw telnet traffic to append to the scrollback.
  onData: (data: Uint8Array) => void;
  // A successful connection, for MRU persistence.
  onConnected: (target: ConnectTarget) => void;
  // The connection (or attempt) has ended, after its last status line was
  // written through onMessage — the point to stop recording the window's
  // output for that target.
  onDisconnected: () => void;
  // The server's Pueblo greeting no longer counts: a line has been sent to it
  // (see ConnectionManager.isGreetingOpen).
  onGreetingClosed: () => void;
}

// What Pueblo clients send on seeing the server's greeting (see pueblo.ts); a
// Pueblo world waits for it before sending its tags.
export const PUEBLO_CLIENT_REPLY = "PUEBLOCLIENT 2.01\r\n";

// Moolin's status lines go through the same parser as the server's output, and
// some of what they say comes from outside (a certificate's host names in an
// error, say, or a world's name from a hand-edited file), so control
// characters, escape included, are made harmless before they are interpolated.
export function plain(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

const yellow = (text: string): string => `\x1b[33m[${plain(text)}]\x1b[0m\r\n`;
const green = (text: string): string => `\x1b[32m[${plain(text)}]\x1b[0m\r\n`;
const red = (text: string): string => `\x1b[31m[${plain(text)}]\x1b[0m\r\n`;

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
  private tlsInfo: TlsInfo | null = null;
  private resolved: ResolvedSettings | null = null;
  // Whether the server has greeted this connection as a Pueblo world. Kept
  // after the connection ends, until the next one begins, so the scrollback
  // that holds its tags is still read that way.
  private pueblo = false;
  // Why this side is ending the connection, for the status line, until the
  // session reports it ended.
  private disconnectReason: string | null = null;
  // Whether the server's Pueblo greeting still counts. It does from the start
  // of a connection until the first line is sent to the server, typed or an
  // auto-login: the greeting comes with the server's welcome, before anyone has
  // spoken, while a player could say the same words later and, were it taken
  // for a greeting, turn their text into links that run commands when clicked.
  private greetingOpen = false;
  // The auto-login, held until the server has sent something (see connect).
  private pendingLogin: string | null = null;
  private readonly greeting = new GreetingDetector();
  private greetingDecoder = new TextDecoder();
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
      label: this.target ? targetLabel(this.target.world, this.target.character) : null,
      address: this.target ? `${this.target.world.host.trim()}:${this.target.world.port}` : null,
      tls: this.connected ? this.tlsInfo : null,
      wordWrap: this.resolved?.wordWrap ?? false,
    };
  }

  // Whether this connection should echo typed commands (see the telnetInput
  // IPC handler in main.ts); resolved from Global/World/Character at connect
  // time, same as wordWrap in getState().
  echoCommandsEnabled(): boolean {
    return this.resolved?.echoCommands ?? true;
  }

  // Whether the server has greeted this connection as a Pueblo world, and
  // Moolin answered it (see ScrollbackReplay.pueblo for why the renderer
  // needs to know).
  isPueblo(): boolean {
    return this.pueblo;
  }

  // Whether the server's greeting could still switch Pueblo on (see greetingOpen).
  isGreetingOpen(): boolean {
    return this.greetingOpen;
  }

  private closeGreeting(): void {
    if (!this.greetingOpen) return;
    this.greetingOpen = false;
    this.handlers.onGreetingClosed();
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

  connect(target: ConnectTarget, resolved: ResolvedSettings = { wordWrap: false, echoCommands: true }): void {
    const { world, character } = target;
    this.session?.disconnect();
    const label = targetLabel(world, character);
    if (!isConnectable(world) || world.port === null) {
      this.handlers.onMessage(red(`can't connect to ${label}: it needs a host and a port from 1 to 65535`));
      return;
    }
    this.target = target;
    this.connected = false;
    this.tlsInfo = null;
    this.resolved = resolved;
    this.pueblo = false;
    this.greetingOpen = true;
    this.pendingLogin = null;
    this.greeting.reset();
    this.greetingDecoder = new TextDecoder();
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
          this.handlers.onConnected(target);
          this.handlers.onStateChange();
          this.handlers.onMessage(green(`connected to ${label}${secure ? ", securely (TLS)" : ""}`));
          // Held until the server speaks first, so its greeting is seen before
          // anything is sent (see greetingOpen). A server that says nothing
          // until it is spoken to never gets the login.
          if (character && world.autoLogin) {
            this.pendingLogin = expandLoginTemplate(world.loginTemplate, character.name, character.password);
          }
        },
        onData: (data) => {
          if (this.session !== session) return;
          this.handlers.onData(data);
          this.watchForPuebloGreeting(session, data);
          if (this.pendingLogin !== null) {
            this.log("debug", "sending auto-login for", label);
            const login = this.pendingLogin;
            this.pendingLogin = null;
            this.closeGreeting();
            session.sendRaw(login);
          }
        },
        onDisconnect: (reason, certificateRejected) => {
          if (this.session !== session) return;
          const ourReason = this.disconnectReason;
          this.disconnectReason = null;
          this.log(reason ? "error" : "info", reason ? `connection error: ${reason}` : "disconnected");
          this.session = null;
          this.pendingLogin = null;
          this.target = null;
          this.connected = false;
          this.tlsInfo = null;
          this.resolved = null;
          this.handlers.onStateChange();
          this.handlers.onMessage(
            reason
              ? red(`connection error: ${reason}`)
              : yellow(ourReason ? `disconnected: ${ourReason}` : "disconnected"),
          );
          if (certificateRejected) {
            this.handlers.onMessage(
              yellow(`to connect anyway, turn on "Accept untrusted certificates" for ${worldLabel(world)}`),
            );
          }
          this.handlers.onDisconnected();
        },
        onTlsInfo: (info: TlsInfo) => {
          if (this.session !== session) return;
          this.tlsInfo = info;
          // The details are in the status bar's security popup; only an
          // untrusted certificate is called out here, as a warning.
          if (!info.certValid) {
            this.handlers.onMessage(
              red(
                `warning: certificate is not trusted (${info.certValidationError}); connecting anyway as this world allows`,
              ),
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

  // Answers a Pueblo greeting, once. Neither the reply nor its effect goes
  // through the scrollback or the log: it is the client's half of the greeting,
  // not something typed.
  private watchForPuebloGreeting(session: TelnetSession, data: Uint8Array): void {
    if (this.pueblo || !this.greetingOpen) return;
    if (this.greeting.feed(this.greetingDecoder.decode(data, { stream: true })) < 0) return;
    this.pueblo = true;
    this.log("debug", "Pueblo greeting seen; answering");
    session.sendRaw(PUEBLO_CLIENT_REPLY);
  }

  // Ends the connection. `reason` is shown in the status line ("disconnected:
  // the computer is going to sleep"); `graceful` closes it properly, telling
  // the server, rather than dropping it.
  disconnect(reason?: string, graceful = false): void {
    if (!this.session) return;
    this.disconnectReason = reason ?? null;
    if (reason) this.log("info", "ending the connection:", reason);
    this.session.disconnect(graceful);
  }

  // The computer is about to sleep, which will cut the connection off with no
  // notice to either side: say goodbye now, while the network is still up,
  // rather than leave a window that looks live but isn't.
  disconnectForSleep(): void {
    this.disconnect("the computer is going to sleep", true);
  }

  sendLine(text: string): { echoed: boolean } {
    if (!this.session) return { echoed: false };
    this.closeGreeting();
    return this.session.sendLine(text);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.session?.resize(cols, rows);
  }
}
