import { X509Certificate } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
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

// What to do as an option is switched on or off at one end.
interface OptionSide {
  onEnable?: () => void;
  onDisable?: () => void;
}

// Per-telnet-option behavior, keyed by option number in buildOptionHandlers.
// `local` makes it an option Moolin agrees to perform (the server asks with
// DO/DONT, Moolin answers WILL/WONT); `remote` one Moolin agrees to let the
// server perform (WILL/WONT, answered with DO/DONT). An option without the
// side being asked about is refused.
interface TelnetOptionHandler {
  local?: OptionSide;
  remote?: OptionSide;
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

// One certificate from the server's chain, flattened to plain strings so it
// can cross IPC to the connection details popup.
export interface CertificateDetails {
  // Distinguished-name attributes in certificate order, e.g. ["CN", "example.org"].
  subject: Array<[string, string]>;
  issuer: Array<[string, string]>;
  // "DNS:example.org", "IP Address:10.0.0.1", ...
  subjectAltNames: string[];
  serialNumber: string;
  validFrom: string;
  validTo: string;
  // "RSA, 2048 bits", "EC, P-256", "Ed25519", ...
  publicKey: string;
  signatureAlgorithm?: string;
  // Extended key usage, as names where known (OIDs otherwise).
  extendedKeyUsage: string[];
  isCa: boolean;
  // Authority information access: "OCSP - URI: http://...", ...
  infoAccess: string[];
  fingerprintSha256: string;
  fingerprintSha1: string;
}

export interface TlsInfo {
  protocol: string;
  cipherName: string;
  // The ephemeral key exchange, e.g. "X25519, 253 bits"; absent when
  // the TLS library doesn't report it.
  keyExchange?: string;
  // Whether the cert passed Node's normal chain/hostname verification. Only
  // false on a connection the world allows untrusted certificates for
  // (plenty of MUDs run self-signed certs); otherwise a failure disconnects.
  certValid: boolean;
  certValidationError?: string;
  // The chain as the server presented it (completed from the local trust
  // store where Node could), server certificate first.
  certificates: CertificateDetails[];
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

const EXTENDED_KEY_USAGES: Record<string, string> = {
  "1.3.6.1.5.5.7.3.1": "TLS server authentication",
  "1.3.6.1.5.5.7.3.2": "TLS client authentication",
  "1.3.6.1.5.5.7.3.3": "Code signing",
  "1.3.6.1.5.5.7.3.4": "Email protection",
  "1.3.6.1.5.5.7.3.8": "Time stamping",
  "1.3.6.1.5.5.7.3.9": "OCSP signing",
};

function nameEntries(name: Record<string, string | string[] | undefined> | undefined): Array<[string, string]> {
  if (!name) return [];
  return Object.entries(name).flatMap(([key, value]) =>
    value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v): [string, string] => [key, v]),
  );
}

function describePublicKey(cert: tls.PeerCertificate, x509: X509Certificate | null): string {
  const key = x509?.publicKey;
  const type = key?.asymmetricKeyType;
  const bits = key?.asymmetricKeyDetails?.modulusLength ?? cert.bits;
  const curve = cert.nistCurve ?? cert.asn1Curve ?? key?.asymmetricKeyDetails?.namedCurve;
  if (type === "rsa" || type === "rsa-pss" || (!type && cert.modulus)) {
    return `${type === "rsa-pss" ? "RSA-PSS" : "RSA"}${bits ? `, ${bits} bits` : ""}`;
  }
  if (type === "ec" || (!type && curve)) return `EC${curve ? `, ${curve}` : ""}`;
  if (type === "ed25519") return "Ed25519";
  if (type === "ed448") return "Ed448";
  return type ?? "unknown";
}

function certificateDetails(cert: tls.PeerCertificate): CertificateDetails {
  let x509: X509Certificate | null = null;
  try {
    x509 = new X509Certificate(cert.raw);
  } catch {
    // Fall back to what getPeerCertificate() reported on its own.
  }
  return {
    subject: nameEntries(cert.subject),
    issuer: nameEntries(cert.issuer),
    subjectAltNames: cert.subjectaltname ? cert.subjectaltname.split(", ") : [],
    serialNumber: cert.serialNumber ?? "unknown",
    validFrom: cert.valid_from ?? "unknown",
    validTo: cert.valid_to ?? "unknown",
    publicKey: describePublicKey(cert, x509),
    signatureAlgorithm: x509?.signatureAlgorithm,
    extendedKeyUsage: (cert.ext_key_usage ?? []).map((oid) => EXTENDED_KEY_USAGES[oid] ?? oid),
    isCa: cert.ca,
    infoAccess: Object.entries(cert.infoAccess ?? {}).flatMap(([method, uris]) =>
      (uris ?? []).map((uri) => `${method}: ${uri}`),
    ),
    fingerprintSha256: cert.fingerprint256 ?? "unknown",
    fingerprintSha1: cert.fingerprint ?? "unknown",
  };
}

// Walks issuerCertificate links from the server's certificate. A self-signed
// root links to itself, so stop at the first repeat.
function certificateChain(tlsSocket: tls.TLSSocket): CertificateDetails[] {
  const chain: CertificateDetails[] = [];
  const seen = new Set<string>();
  let cert: tls.DetailedPeerCertificate | undefined = tlsSocket.getPeerCertificate(true);
  while (cert?.raw && !seen.has(cert.fingerprint256) && chain.length < 10) {
    seen.add(cert.fingerprint256);
    chain.push(certificateDetails(cert));
    cert = cert.issuerCertificate;
  }
  return chain;
}

function describeKeyExchange(tlsSocket: tls.TLSSocket): string | undefined {
  const info = tlsSocket.getEphemeralKeyInfo();
  if (!info || !("type" in info) || !info.type) return undefined;
  // Name the group where there is one ("X25519", "X25519MLKEM768"); a plain
  // DH exchange has only its type and size.
  const name = "name" in info && info.name ? info.name : info.type;
  return info.size ? `${name}, ${info.size} bits` : name;
}

function collectTlsInfo(tlsSocket: tls.TLSSocket): TlsInfo {
  const cipher = tlsSocket.getCipher();
  return {
    protocol: tlsSocket.getProtocol() ?? "unknown",
    cipherName: cipher?.standardName || cipher?.name || "unknown",
    keyExchange: describeKeyExchange(tlsSocket),
    certValid: tlsSocket.authorized,
    certValidationError: tlsSocket.authorized ? undefined : tlsSocket.authorizationError?.toString(),
    certificates: certificateChain(tlsSocket),
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
  // The options currently on: those Moolin performs, and those the server
  // does. Only a request that would change one of these is answered (see
  // dispatchNegotiation).
  private readonly localEnabled = new Set<number>();
  private readonly remoteEnabled = new Set<number>();
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
    // an option (e.g. GMCP or MSDP; see PROTOCOLS.md) means adding one
    // registry entry rather than touching the dispatch below. MCCP needs more:
    // decompression has to sit before the parser. Anything with no entry (or
    // no matching callback on its entry) falls back to refusing/ignoring.
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

  // Follows RFC 1143's rule against negotiation loops: a request that
  // matches an option's current state (a repeated DO, a DONT for an option
  // that's off, ...) is not answered, since answering it again is what lets
  // two peers that each acknowledge every request ping-pong forever. A
  // request for an unsupported option is always refused.
  private dispatchNegotiation(
    optionHandlers: Partial<Record<number, TelnetOptionHandler>>,
    verb: NegotiationVerb,
    option: number,
  ): void {
    const handler = optionHandlers[option];
    switch (verb) {
      case "do":
        if (!handler?.local) this.writeNegotiation("wont", option);
        else if (!this.localEnabled.has(option)) {
          this.localEnabled.add(option);
          this.writeNegotiation("will", option);
          handler.local.onEnable?.();
        }
        break;
      case "dont":
        if (this.localEnabled.delete(option)) {
          this.writeNegotiation("wont", option);
          handler?.local?.onDisable?.();
        }
        break;
      case "will":
        if (!handler?.remote) this.writeNegotiation("dont", option);
        else if (!this.remoteEnabled.has(option)) {
          this.remoteEnabled.add(option);
          this.writeNegotiation("do", option);
          handler.remote.onEnable?.();
        }
        break;
      case "wont":
        if (this.remoteEnabled.delete(option)) {
          this.writeNegotiation("dont", option);
          handler?.remote?.onDisable?.();
        }
        break;
    }
  }

  private writeNegotiation(verb: NegotiationVerb, option: number): void {
    this.socket?.write(encodeNegotiation(verb, option));
  }

  private buildOptionHandlers(): Partial<Record<number, TelnetOptionHandler>> {
    return {
      [TELOPT_NAWS]: {
        // The server asks (DO) for window-size updates: send the current
        // size now, and again on every resize until it says DONT.
        local: { onEnable: () => this.sendNaws() },
      },
      [TELOPT_TTYPE]: {
        local: {},
        onSub: (buffer) => {
          if (this.localEnabled.has(TELOPT_TTYPE) && buffer[0] === 1 /* SEND */) {
            this.socket?.write(
              encodeSub(TELOPT_TTYPE, Buffer.concat([Buffer.from([0 /* IS */]), Buffer.from("XTERM", "ascii")])),
            );
          }
        },
      },
      [TELOPT_SGA]: { local: {}, remote: {} },
      [TELOPT_ECHO]: {
        // Server takes over echoing — typically for password prompts.
        remote: {
          onEnable: () => {
            this.localEchoSuppressed = true;
          },
          onDisable: () => {
            this.localEchoSuppressed = false;
          },
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
    this.socket.write(escapeIac(Buffer.from(`${text.replace(/\n/g, "\r\n")}\r\n`, "utf8")));
    return { echoed: !this.localEchoSuppressed };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.sendNaws();
  }

  private sendNaws(): void {
    if (!this.socket || !this.localEnabled.has(TELOPT_NAWS)) return;
    this.log("debug", "sending NAWS", `${this.cols}x${this.rows}`);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(this.cols, 0);
    buffer.writeUInt16BE(this.rows, 2);
    this.socket.write(encodeSub(TELOPT_NAWS, buffer));
  }

  // Closes the connection and reports it (onDisconnect) before returning, so
  // a caller can rely on the disconnect having been handled, e.g. a window
  // that's closing logs it before giving up its log. The socket's own close
  // event then finds nothing left to tear down.
  //
  // `graceful` says goodbye to the server first (a TLS close notice, then FIN)
  // and lets the socket finish closing in the background, instead of dropping
  // it: for a connection about to be cut off by the machine going to sleep.
  disconnect(graceful = false): void {
    const socket = this.socket ?? this.pendingSocket;
    if (graceful) socket?.destroySoon();
    else socket?.destroy();
    this.teardown();
  }
}
