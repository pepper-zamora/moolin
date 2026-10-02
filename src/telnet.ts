import * as net from "net";
import * as tls from "tls";
import { TelnetSocket } from "telnet-stream";
import type { World } from "./worlds-types";
import type { LogLevel } from "./logger";

const TELOPT_ECHO = 1;
const TELOPT_SGA = 3;
const TELOPT_TTYPE = 24;
const TELOPT_NAWS = 31;

// How long to wait for a TLS handshake to resolve before assuming the peer
// doesn't speak TLS and falling back to plaintext.
const TLS_PROBE_TIMEOUT_MS = 5000;

// Per-telnet-option behavior, keyed by option number in buildOptionHandlers.
// Any callback left unset falls back to the default do/will/wont/sub
// behavior (refuse/ignore) rather than needing an explicit no-op.
interface TelnetOptionHandler {
  onDo?: () => void;
  onWill?: () => void;
  onWont?: () => void;
  onSub?: (buffer: Buffer) => void;
}

export interface TlsInfo {
  protocol: string;
  cipherName: string;
  certSubject: string;
  certIssuer: string;
  certValidFrom: string;
  certValidTo: string;
  // Whether the cert passed Node's normal chain/hostname verification. We
  // don't reject on failure (rejectUnauthorized is off, since plenty of
  // MUDs run self-signed certs), but we still want to surface the warning.
  certValid: boolean;
  certValidationError?: string;
}

export interface TelnetSessionHandlers {
  onConnect: (secure: boolean) => void;
  onData: (data: string | Uint8Array) => void;
  // A `reason` means the socket errored; its absence means a normal close.
  onDisconnect: (reason?: string) => void;
  // Fired once per connection attempt, after the TCP connection itself
  // succeeded, reporting whether the TLS handshake on top of it succeeded.
  // Not fired at all if the TCP connection never came up (that's a plain
  // connection error, not a TLS outcome). `info` is present iff `secure`.
  onTlsProbeResult: (secure: boolean, info?: TlsInfo) => void;
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
  private socket: TelnetSocket | null = null;
  // The raw TCP/TLS socket during the connect-in-progress window, before it's
  // wrapped into `socket` by `establish()`. Needed so `isConnected`/`disconnect`/
  // `teardown` still work while a TLS probe or plaintext fallback is in flight.
  private pendingSocket: net.Socket | tls.TLSSocket | null = null;
  private localEchoSuppressed = false;
  private nawsEnabled = false;
  private cols = 80;
  private rows = 24;

  constructor(
    private readonly handlers: TelnetSessionHandlers,
    private readonly log: LogFn = noopLog,
  ) {}

  connect(world: World): void {
    this.probeTls(world);
  }

  // Servers that speak TLS expect the client to send a ClientHello as the
  // very first bytes on the socket, so there's no way to "peek" for TLS
  // without attempting the handshake. We always try TLS first and fall back
  // to plaintext if the handshake fails on an otherwise-live TCP connection.
  private probeTls(world: World): void {
    this.log("debug", "tcp connecting to", `${world.host}:${world.port}`, "(probing TLS)");
    // Only TLS 1.2+: older versions (1.0/1.1) are treated the same as "no
    // TLS" and fall back to plaintext rather than connecting insecurely.
    // No maxVersion ceiling, so newer protocol versions stay allowed.
    const tlsSocket = tls.connect({
      host: world.host,
      port: world.port,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    let tcpConnected = false;
    let settled = false;

    tlsSocket.once("connect", () => {
      tcpConnected = true;
    });

    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      tlsSocket.setTimeout(0);
      const info = collectTlsInfo(tlsSocket);
      this.log("debug", "tls handshake succeeded:", info.protocol, info.cipherName);
      this.handlers.onTlsProbeResult(true, info);
      this.establish(tlsSocket, true);
    });

    tlsSocket.setTimeout(TLS_PROBE_TIMEOUT_MS, () => {
      if (settled) return;
      this.log("debug", "tls handshake timed out, falling back to plaintext");
      this.fallBackToPlaintext(world, tlsSocket);
      settled = true;
    });

    tlsSocket.once("error", (err) => {
      if (settled) return;
      settled = true;
      if (!tcpConnected) {
        // The TCP connection itself never came up (DNS failure, connection
        // refused, etc.) — a real connection error, not a TLS outcome, so
        // report it immediately rather than waiting on 'close' (not
        // guaranteed to fire promptly here) or the TLS probe timeout.
        this.log("debug", "tcp connect failed:", err.message);
        this.teardown(err.message);
        return;
      }
      this.log("debug", "tls handshake failed, falling back to plaintext:", err.message);
      this.fallBackToPlaintext(world, tlsSocket);
    });

    // Covers `disconnect()` being called while the probe is still in flight.
    tlsSocket.once("close", () => {
      if (settled) return;
      settled = true;
      this.teardown();
    });

    this.pendingSocket = tlsSocket;
  }

  private fallBackToPlaintext(world: World, tlsSocket: tls.TLSSocket): void {
    tlsSocket.removeAllListeners();
    tlsSocket.destroy();
    this.handlers.onTlsProbeResult(false);

    const rawSocket = net.createConnection({ host: world.host, port: world.port });
    this.pendingSocket = rawSocket;
    rawSocket.once("connect", () => {
      this.log("debug", "tcp connected (plaintext)");
      // Hand off to `establish()`, which attaches its own error/close
      // handling on the wrapping TelnetSocket for the rest of the session.
      rawSocket.removeAllListeners("error");
      rawSocket.removeAllListeners("close");
      this.establish(rawSocket, false);
    });
    rawSocket.on("error", (err) => {
      this.log("error", "socket error:", err.message);
      this.teardown(err.message);
    });
    rawSocket.on("close", () => {
      this.log("debug", "socket closed");
      this.teardown();
    });
  }

  private establish(rawSocket: net.Socket | tls.TLSSocket, secure: boolean): void {
    this.pendingSocket = null;
    const telnetSocket = new TelnetSocket(rawSocket);
    this.socket = telnetSocket;
    this.handlers.onConnect(secure);

    telnetSocket.on("data", (data) => {
      this.handlers.onData(typeof data === "string" ? data : new Uint8Array(data));
    });

    // One entry per supported option instead of a switch per event type, so
    // adding an option (GMCP/MSDP/MCCP are MUD-specific extensions layered on
    // top of telnet that would need this — out of scope for this pass) means
    // adding one registry entry rather than touching do/will/wont/sub below.
    // Anything with no entry (or no matching callback on its entry) falls
    // back to refusing/ignoring, same as the old switch statements' defaults.
    const optionHandlers = this.buildOptionHandlers(telnetSocket);

    telnetSocket.on("do", (option) => {
      this.log("debug", "recv IAC DO", option);
      const onDo = optionHandlers[option]?.onDo;
      if (onDo) onDo();
      else telnetSocket.writeWont(option);
    });

    telnetSocket.on("will", (option) => {
      this.log("debug", "recv IAC WILL", option);
      const onWill = optionHandlers[option]?.onWill;
      if (onWill) onWill();
      else telnetSocket.writeDont(option);
    });

    telnetSocket.on("wont", (option) => {
      this.log("debug", "recv IAC WONT", option);
      optionHandlers[option]?.onWont?.();
    });

    telnetSocket.on("sub", (option, buffer) => {
      this.log("debug", "recv IAC SB", option, "len =", buffer.length);
      optionHandlers[option]?.onSub?.(buffer);
    });

    telnetSocket.on("error", (err) => {
      this.log("error", "socket error:", err.message);
      this.teardown(err.message);
    });
    telnetSocket.on("close", () => {
      this.log("debug", "socket closed");
      this.teardown();
    });
  }

  private buildOptionHandlers(telnetSocket: TelnetSocket): Partial<Record<number, TelnetOptionHandler>> {
    return {
      [TELOPT_NAWS]: {
        // Remote is asking us (DO) to send window-size updates.
        onDo: () => {
          this.nawsEnabled = true;
          telnetSocket.writeWill(TELOPT_NAWS);
          this.sendNaws();
        },
      },
      [TELOPT_TTYPE]: {
        onDo: () => telnetSocket.writeWill(TELOPT_TTYPE),
        onSub: (buffer) => {
          if (buffer[0] === 1 /* SEND */) {
            telnetSocket.writeSub(
              TELOPT_TTYPE,
              Buffer.concat([Buffer.from([0 /* IS */]), Buffer.from("XTERM", "ascii")]),
            );
          }
        },
      },
      [TELOPT_SGA]: {
        onDo: () => telnetSocket.writeWill(TELOPT_SGA),
        onWill: () => telnetSocket.writeDo(TELOPT_SGA),
      },
      [TELOPT_ECHO]: {
        // Server takes over echoing — typically for password prompts.
        onWill: () => {
          this.localEchoSuppressed = true;
          telnetSocket.writeDo(TELOPT_ECHO);
        },
        onWont: () => {
          this.localEchoSuppressed = false;
        },
      },
    };
  }

  private teardown(reason?: string): void {
    if (!this.socket && !this.pendingSocket) return;
    this.socket = null;
    this.pendingSocket = null;
    this.handlers.onDisconnect(reason);
  }

  // True only once the telnet session is actually established — while a TLS
  // probe or plaintext fallback is still in flight, callers should treat the
  // session as not yet connected (see `pendingSocket`).
  isConnected(): boolean {
    return this.socket !== null;
  }

  sendLine(text: string): { echoed: boolean } {
    if (!this.socket) return { echoed: false };
    this.socket.write(text.replace(/\n/g, "\r\n") + "\r\n");
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
    this.socket.writeSub(TELOPT_NAWS, buffer);
  }

  disconnect(): void {
    // Don't clear the socket fields here — let the resulting `close` event
    // drive `teardown()`, which is what actually fires `onDisconnect`.
    (this.socket ?? this.pendingSocket)?.destroy();
  }
}
