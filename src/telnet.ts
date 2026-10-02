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

export interface TelnetSessionHandlers {
  onConnect: (secure: boolean) => void;
  onData: (data: string | Uint8Array) => void;
  // A `reason` means the socket errored; its absence means a normal close.
  onDisconnect: (reason?: string) => void;
  // Fired once per connection attempt, after the TCP connection itself
  // succeeded, reporting whether the TLS handshake on top of it succeeded.
  // Not fired at all if the TCP connection never came up (that's a plain
  // connection error, not a TLS outcome).
  onTlsProbeResult: (secure: boolean) => void;
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
    const tlsSocket = tls.connect({ host: world.host, port: world.port, rejectUnauthorized: false });
    let tcpConnected = false;
    let settled = false;

    tlsSocket.once("connect", () => {
      tcpConnected = true;
    });

    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      tlsSocket.setTimeout(0);
      this.log("debug", "tls handshake succeeded");
      this.handlers.onTlsProbeResult(true);
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
        // The TCP connection itself never came up — a real connection error,
        // not a TLS outcome, so let it surface as the usual error/close path.
        this.log("debug", "tcp connect failed:", err.message);
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

    // Reasonable defaults: accept NAWS/TTYPE/SGA/ECHO, refuse everything else
    // (GMCP/MSDP/MCCP are MUD-specific extensions layered on top of telnet
    // that would need dedicated handling — out of scope for this pass).
    telnetSocket.on("do", (option) => {
      this.log("debug", "recv IAC DO", option);
      switch (option) {
        case TELOPT_NAWS:
          this.nawsEnabled = true;
          telnetSocket.writeWill(TELOPT_NAWS);
          this.sendNaws();
          break;
        case TELOPT_TTYPE:
          telnetSocket.writeWill(TELOPT_TTYPE);
          break;
        case TELOPT_SGA:
          telnetSocket.writeWill(TELOPT_SGA);
          break;
        default:
          telnetSocket.writeWont(option);
      }
    });

    telnetSocket.on("will", (option) => {
      this.log("debug", "recv IAC WILL", option);
      switch (option) {
        case TELOPT_ECHO:
          // Server takes over echoing — typically for password prompts.
          this.localEchoSuppressed = true;
          telnetSocket.writeDo(option);
          break;
        case TELOPT_SGA:
          telnetSocket.writeDo(option);
          break;
        default:
          telnetSocket.writeDont(option);
      }
    });

    telnetSocket.on("wont", (option) => {
      this.log("debug", "recv IAC WONT", option);
      if (option === TELOPT_ECHO) this.localEchoSuppressed = false;
    });

    telnetSocket.on("sub", (option, buffer) => {
      this.log("debug", "recv IAC SB", option, "len =", buffer.length);
      if (option === TELOPT_TTYPE && buffer[0] === 1 /* SEND */) {
        telnetSocket.writeSub(TELOPT_TTYPE, Buffer.concat([Buffer.from([0 /* IS */]), Buffer.from("XTERM", "ascii")]));
      }
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
