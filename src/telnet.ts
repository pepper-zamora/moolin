import * as net from "net";
import * as tls from "tls";
import { TelnetParser, encodeNegotiation, encodeSub, escapeIac, type NegotiationVerb } from "./telnet-protocol";
import type { LogLevel } from "./logger";

const TELOPT_ECHO = 1;
const TELOPT_SGA = 3;
const TELOPT_TTYPE = 24;
const TELOPT_NAWS = 31;

// How long to wait, once TCP is up, for the TLS handshake to finish. A
// plaintext server usually answers a ClientHello with an immediate protocol
// error, but some just sit waiting for a login line.
const TLS_HANDSHAKE_TIMEOUT_MS = 15000;

// Per-telnet-option behavior, keyed by option number in buildOptionHandlers.
// Any callback left unset falls back to the default do/will/wont/sub
// behavior (refuse/ignore) rather than needing an explicit no-op.
interface TelnetOptionHandler {
  onDo?: () => void;
  onWill?: () => void;
  onWont?: () => void;
  onSub?: (buffer: Buffer) => void;
}

type Socket = net.Socket | tls.TLSSocket;

export interface ConnectOptions {
  host: string;
  port: number;
  tls: boolean;
  // Connect even if the server's certificate fails verification.
  tlsAllowUntrusted: boolean;
}

export interface TlsInfo {
  protocol: string;
  cipherName: string;
  certSubject: string;
  certIssuer: string;
  certValidFrom: string;
  certValidTo: string;
  // Whether the cert passed Node's normal chain/hostname verification. Only
  // false on a connection the world allows untrusted certificates for
  // (plenty of MUDs run self-signed certs); otherwise a failure disconnects.
  certValid: boolean;
  certValidationError?: string;
}

export interface TelnetSessionHandlers {
  onConnect: (secure: boolean) => void;
  onData: (data: Uint8Array) => void;
  // A `reason` means the socket errored; its absence means a normal close.
  // `certificateRejected` marks a TLS certificate that failed verification
  // on a world that doesn't allow untrusted certificates.
  onDisconnect: (reason?: string, certificateRejected?: boolean) => void;
  // Fired after a successful TLS handshake, just before onConnect.
  onTlsInfo: (info: TlsInfo) => void;
}

function formatCertName(name: Record<string, string | string[] | undefined> | undefined): string {
  if (!name) return "unknown";
  if (name.CN) return Array.isArray(name.CN) ? name.CN.join(", ") : name.CN;
  return Object.entries(name)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join(", ");
}

function collectTlsInfo(tlsSocket: tls.TLSSocket): TlsInfo {
  const cipher = tlsSocket.getCipher();
  const cert = tlsSocket.getPeerCertificate();
  return {
    protocol: tlsSocket.getProtocol() ?? "unknown",
    cipherName: cipher?.standardName || cipher?.name || "unknown",
    certSubject: formatCertName(cert?.subject),
    certIssuer: formatCertName(cert?.issuer),
    certValidFrom: cert?.valid_from ?? "unknown",
    certValidTo: cert?.valid_to ?? "unknown",
    certValid: tlsSocket.authorized,
    certValidationError: tlsSocket.authorized ? undefined : tlsSocket.authorizationError?.toString(),
  };
}

type LogFn = (level: Exclude<LogLevel, "none">, ...args: unknown[]) => void;

const noopLog: LogFn = () => {};

export class TelnetSession {
  // Set by `establish()` once the telnet session is up.
  private socket: Socket | null = null;
  // The TCP/TLS socket during the connect-in-progress window, before
  // `establish()` promotes it to `socket`. Needed so `isConnected`/`disconnect`/
  // `teardown` still work while the TCP connect or TLS handshake is in flight.
  private pendingSocket: Socket | null = null;
  private localEchoSuppressed = false;
  private nawsEnabled = false;
  private cols = 80;
  private rows = 24;

  constructor(
    private readonly handlers: TelnetSessionHandlers,
    private readonly log: LogFn = noopLog,
  ) {}

  // TLS is the world's explicit setting, never guessed: probing for it would
  // send a ClientHello to plaintext servers, and silently falling back to
  // plaintext would let anyone on the network path downgrade the connection.
  connect(options: ConnectOptions): void {
    const { host, port } = options;
    this.log("debug", "tcp connecting to", `${host}:${port}`, options.tls ? "(TLS)" : "(plaintext)");
    if (!options.tls) {
      const socket = net.createConnection({ host, port });
      this.pendingSocket = socket;
      this.handlePendingSocket(socket, "connect", () => {
        this.log("debug", "tcp connected (plaintext)");
        this.establish(socket, false);
      });
      return;
    }

    // Verification is checked by hand below rather than via
    // rejectUnauthorized, so an untrusted certificate can be reported with
    // its details either way. Nothing is written to the socket before then.
    // Only TLS 1.2+; no maxVersion ceiling, so newer versions stay allowed.
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    this.pendingSocket = socket;
    socket.once("connect", () => {
      socket.setTimeout(TLS_HANDSHAKE_TIMEOUT_MS, () => {
        socket.destroy(new Error("TLS handshake timed out (is this port really TLS?)"));
      });
    });
    this.handlePendingSocket(socket, "secureConnect", () => {
      socket.setTimeout(0);
      const info = collectTlsInfo(socket);
      if (!info.certValid && !options.tlsAllowUntrusted) {
        this.log("debug", "rejecting untrusted certificate:", info.certValidationError);
        socket.destroy();
        this.teardown(`certificate not trusted: ${info.certValidationError}`, true);
        return;
      }
      this.log("debug", "tls handshake succeeded:", info.protocol, info.cipherName);
      this.handlers.onTlsInfo(info);
      this.establish(socket, true);
    });
  }

  // Wires error/close for the connect-in-progress window, then hands off to
  // `onReady` once `readyEvent` fires; `establish()` attaches its own
  // handling for the rest of the session.
  private handlePendingSocket(socket: Socket, readyEvent: "connect" | "secureConnect", onReady: () => void): void {
    const onError = (err: Error): void => {
      this.log("debug", "connect failed:", err.message);
      this.teardown(err.message);
    };
    // Covers `disconnect()` being called while the connect is in flight.
    const onClose = (): void => this.teardown();
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once(readyEvent, () => {
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      onReady();
    });
  }

  private establish(socket: Socket, secure: boolean): void {
    this.pendingSocket = null;
    this.socket = socket;
    this.handlers.onConnect(secure);

    const parser = new TelnetParser();
    // One entry per supported option instead of a switch per verb, so adding
    // an option (GMCP/MSDP/MCCP are MUD-specific extensions layered on top of
    // telnet that would need this — out of scope for this pass) means adding
    // one registry entry rather than touching the dispatch below. Anything
    // with no entry (or no matching callback on its entry) falls back to
    // refusing/ignoring.
    const optionHandlers = this.buildOptionHandlers();

    socket.on("data", (chunk: Buffer) => {
      for (const event of parser.parse(chunk)) {
        switch (event.type) {
          case "data":
            this.handlers.onData(event.data);
            break;
          case "negotiation":
            this.log("debug", `recv IAC ${event.verb.toUpperCase()}`, event.option);
            this.dispatchNegotiation(optionHandlers, event.verb, event.option);
            break;
          case "sub":
            this.log("debug", "recv IAC SB", event.option, "len =", event.data.length);
            optionHandlers[event.option]?.onSub?.(event.data);
            break;
          case "command":
            break; // GA, NOP, etc. — nothing to do.
        }
      }
    });

    socket.on("error", (err) => {
      this.log("error", "socket error:", err.message);
      this.teardown(err.message);
    });
    socket.on("close", () => {
      this.log("debug", "socket closed");
      this.teardown();
    });
  }

  private dispatchNegotiation(
    optionHandlers: Partial<Record<number, TelnetOptionHandler>>,
    verb: NegotiationVerb,
    option: number,
  ): void {
    const handler = optionHandlers[option];
    switch (verb) {
      case "do":
        if (handler?.onDo) handler.onDo();
        else this.writeNegotiation("wont", option);
        break;
      case "will":
        if (handler?.onWill) handler.onWill();
        else this.writeNegotiation("dont", option);
        break;
      case "wont":
        handler?.onWont?.();
        break;
      case "dont":
        // We never enable an option the server hasn't asked for, so there's
        // nothing to turn off; not replying also avoids negotiation loops.
        break;
    }
  }

  private writeNegotiation(verb: NegotiationVerb, option: number): void {
    this.socket?.write(encodeNegotiation(verb, option));
  }

  private buildOptionHandlers(): Partial<Record<number, TelnetOptionHandler>> {
    return {
      [TELOPT_NAWS]: {
        // Remote is asking us (DO) to send window-size updates.
        onDo: () => {
          this.nawsEnabled = true;
          this.writeNegotiation("will", TELOPT_NAWS);
          this.sendNaws();
        },
      },
      [TELOPT_TTYPE]: {
        onDo: () => this.writeNegotiation("will", TELOPT_TTYPE),
        onSub: (buffer) => {
          if (buffer[0] === 1 /* SEND */) {
            this.socket?.write(
              encodeSub(TELOPT_TTYPE, Buffer.concat([Buffer.from([0 /* IS */]), Buffer.from("XTERM", "ascii")])),
            );
          }
        },
      },
      [TELOPT_SGA]: {
        onDo: () => this.writeNegotiation("will", TELOPT_SGA),
        onWill: () => this.writeNegotiation("do", TELOPT_SGA),
      },
      [TELOPT_ECHO]: {
        // Server takes over echoing — typically for password prompts.
        onWill: () => {
          this.localEchoSuppressed = true;
          this.writeNegotiation("do", TELOPT_ECHO);
        },
        onWont: () => {
          this.localEchoSuppressed = false;
        },
      },
    };
  }

  private teardown(reason?: string, certificateRejected = false): void {
    if (!this.socket && !this.pendingSocket) return;
    this.socket = null;
    this.pendingSocket = null;
    this.handlers.onDisconnect(reason, certificateRejected);
  }

  // True only once the telnet session is actually established — while the
  // connect or TLS handshake is still in flight, callers should treat the
  // session as not yet connected (see `pendingSocket`).
  isConnected(): boolean {
    return this.socket !== null;
  }

  // Writes text as-is (IAC-escaped, no line ending added) — used for the
  // auto-login string, whose template supplies its own line endings. Never
  // logged, since it carries a password.
  sendRaw(text: string): void {
    this.socket?.write(escapeIac(Buffer.from(text, "utf8")));
  }

  sendLine(text: string): { echoed: boolean } {
    if (!this.socket) return { echoed: false };
    this.socket.write(escapeIac(Buffer.from(text.replace(/\n/g, "\r\n") + "\r\n", "utf8")));
    return { echoed: !this.localEchoSuppressed };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.sendNaws();
  }

  private sendNaws(): void {
    if (!this.socket || !this.nawsEnabled) return;
    this.log("debug", "sending NAWS", `${this.cols}x${this.rows}`);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(this.cols, 0);
    buffer.writeUInt16BE(this.rows, 2);
    this.socket.write(encodeSub(TELOPT_NAWS, buffer));
  }

  disconnect(): void {
    // Don't clear the socket fields here — let the resulting `close` event
    // drive `teardown()`, which is what actually fires `onDisconnect`.
    (this.socket ?? this.pendingSocket)?.destroy();
  }
}
