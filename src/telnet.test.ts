import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { TelnetSession, type ConnectOptions, type TelnetSessionHandlers, type TlsInfo } from "./telnet";

function options(port: number, overrides: Partial<ConnectOptions> = {}): ConnectOptions {
  return { host: "127.0.0.1", port, tls: false, tlsAllowUntrusted: false, ...overrides };
}

function noopLog(): void {}

function freePort(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

// Records every handler callback in call order, so tests can assert both
// the outcome and the sequence it arrived in (the thing most likely to
// regress silently in this state machine).
function recordingHandlers(): { handlers: TelnetSessionHandlers; events: string[] } {
  const events: string[] = [];
  const handlers: TelnetSessionHandlers = {
    onConnect: (secure) => events.push(`connect:${secure}`),
    onData: () => events.push("data"),
    onDisconnect: (reason, certificateRejected) =>
      events.push(`disconnect:${reason ?? ""}${certificateRejected ? ":certificateRejected" : ""}`),
    onTlsInfo: (info) => events.push(`tlsInfo:${info.certValid}`),
  };
  return { handlers, events };
}

// Resolves once `name` has been called on `handlers`, after recording it.
function waitForHandler(handlers: TelnetSessionHandlers, name: keyof TelnetSessionHandlers): Promise<void> {
  return new Promise((resolve) => {
    const original = handlers[name] as (...args: unknown[]) => void;
    (handlers as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      original(...args);
      resolve();
    };
  });
}

// Bounded so a hang in the code under test fails the test fast with a clear
// "timed out" instead of hanging the whole suite.
const TEST_TIMEOUT_MS = 5000;

// A TLS 1.2+ server with a freshly generated self-signed certificate.
async function selfSignedTlsServer(onConnection: (socket: tls.TLSSocket) => void): Promise<{
  server: tls.Server;
  cleanup: () => void;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-test-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=test.moolin.local"`,
    { stdio: "ignore" },
  );
  const server = tls.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), minVersion: "TLSv1.2" },
    onConnection,
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    server,
    cleanup: () => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("connects in plaintext when the world doesn't use TLS", { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = net.createServer((socket) => socket.write("hello\r\n"));
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers, events } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  try {
    const gotData = waitForHandler(handlers, "onData");
    session.connect(options(freePort(server)));
    await gotData;
    assert.deepEqual(events, ["connect:false", "data"]);
  } finally {
    session.disconnect();
    server.close();
  }
});

test("rejects an untrusted certificate unless the world allows it", { timeout: TEST_TIMEOUT_MS }, async () => {
  let serverReceived = 0;
  const { server, cleanup } = await selfSignedTlsServer((socket) => {
    socket.on("data", (chunk) => (serverReceived += chunk.length));
    socket.on("error", () => {});
  });

  const { handlers, events } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  try {
    const disconnected = waitForHandler(handlers, "onDisconnect");
    session.connect(options(freePort(server), { tls: true }));
    await disconnected;

    assert.equal(events.length, 1);
    assert.match(events[0], /^disconnect:certificate not trusted: .*SELF_SIGNED.*:certificateRejected$/);
    assert.equal(session.isConnected(), false);
    assert.equal(serverReceived, 0, "nothing should be sent over a rejected connection");
  } finally {
    session.disconnect();
    cleanup();
  }
});

test("connects to a self-signed TLS server when allowed, and reports cert/cipher info", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, cleanup } = await selfSignedTlsServer((socket) => socket.write("hello\r\n"));

  const { handlers, events } = recordingHandlers();
  let tlsInfo: TlsInfo | undefined;
  const recordTlsInfo = handlers.onTlsInfo;
  handlers.onTlsInfo = (info) => {
    tlsInfo = info;
    recordTlsInfo(info);
  };
  const session = new TelnetSession(handlers, noopLog);
  try {
    const connected = waitForHandler(handlers, "onConnect");
    session.connect(options(freePort(server), { tls: true, tlsAllowUntrusted: true }));
    await connected;

    assert.deepEqual(events, ["tlsInfo:false", "connect:true"]);
    assert.equal(tlsInfo?.certSubject, "test.moolin.local");
    assert.match(tlsInfo?.protocol ?? "", /^TLSv1\.[23]$/);
    assert.match(tlsInfo?.certValidationError ?? "", /SELF_SIGNED/);
    // A self-signed certificate is its own whole chain.
    assert.equal(tlsInfo?.certificates.length, 1);
    const [cert] = tlsInfo?.certificates ?? [];
    assert.deepEqual(cert?.subject, [["CN", "test.moolin.local"]]);
    assert.deepEqual(cert?.issuer, [["CN", "test.moolin.local"]]);
    assert.equal(cert?.publicKey, "RSA, 2048 bits");
    assert.match(cert?.fingerprintSha256 ?? "", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  } finally {
    session.disconnect();
    cleanup();
  }
});

test("a TLS world against a plaintext server fails instead of falling back", { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("Welcome! Please log in.\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers, events } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  try {
    const disconnected = waitForHandler(handlers, "onDisconnect");
    session.connect(options(freePort(server), { tls: true }));
    await disconnected;

    assert.equal(events.length, 1);
    assert.ok(events[0].startsWith("disconnect:") && events[0] !== "disconnect:", events[0]);
  } finally {
    session.disconnect();
    server.close();
  }
});

test("an unreachable host surfaces as a disconnect with a reason", { timeout: TEST_TIMEOUT_MS }, async () => {
  // ".invalid" is reserved by RFC 2606 to never resolve, so this fails fast
  // and deterministically via DNS rather than depending on how quickly (or
  // whether) a given network refuses a connection to a closed port.
  for (const useTls of [false, true]) {
    const { handlers, events } = recordingHandlers();
    const session = new TelnetSession(handlers, noopLog);
    const disconnected = waitForHandler(handlers, "onDisconnect");
    session.connect({ ...options(12345, { tls: useTls }), host: "nonexistent.invalid" });
    await disconnected;
    assert.equal(events.length, 1, `tls=${useTls}`);
    assert.ok(events[0].startsWith("disconnect:") && events[0] !== "disconnect:", events[0]);
  }
});

test("disconnect() while connecting tears down cleanly without hanging", { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = net.createServer(() => {}); // accepts but never sends anything
  await new Promise<void>((resolve) => server.listen(0, resolve));

  for (const useTls of [false, true]) {
    const { handlers, events } = recordingHandlers();
    const session = new TelnetSession(handlers, noopLog);
    const disconnected = waitForHandler(handlers, "onDisconnect");
    session.connect(options(freePort(server), { tls: useTls }));
    session.disconnect();
    await disconnected;
    assert.deepEqual(events, ["disconnect:"], `tls=${useTls}`);
  }
  server.close();
});

test("negotiates ECHO, NAWS and TTYPE, and stops local echo while the server echoes", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const IAC = 255,
    SB = 250,
    SE = 240,
    WILL = 251,
    WONT = 252,
    DO = 253;
  const ECHO = 1,
    TTYPE = 24,
    NAWS = 31;
  let serverSocket: net.Socket | undefined;
  const received: number[] = [];
  const server = net.createServer((socket) => {
    serverSocket = socket;
    socket.on("data", (chunk) => received.push(...chunk));
    socket.on("error", () => {});
    socket.write(Buffer.from([IAC, WILL, ECHO, IAC, DO, NAWS, IAC, DO, TTYPE, IAC, SB, TTYPE, 1, IAC, SE]));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  const includes = (sequence: number[]): boolean =>
    received.some((_, i) => sequence.every((byte, j) => received[i + j] === byte));
  const waitFor = async (sequence: number[]): Promise<void> => {
    while (!includes(sequence)) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  try {
    const connected = waitForHandler(handlers, "onConnect");
    session.connect(options(freePort(server)));
    await connected;
    session.resize(100, 40);

    await waitFor([IAC, DO, ECHO]);
    await waitFor([IAC, WILL, NAWS]);
    await waitFor([IAC, SB, NAWS, 0, 100, 0, 40, IAC, SE]);
    await waitFor([IAC, WILL, TTYPE]);
    await waitFor([IAC, SB, TTYPE, 0, ...Buffer.from("XTERM"), IAC, SE]);
    assert.deepEqual(session.sendLine("secret"), { echoed: false });

    serverSocket?.write(Buffer.from([IAC, WONT, ECHO]));
    await waitFor([...Buffer.from("secret\r\n")]);
    // WONT ECHO has no reply, so poll until the session has seen it.
    let echo = session.sendLine("look");
    while (!echo.echoed) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      echo = session.sendLine("look");
    }
  } finally {
    session.disconnect();
    server.close();
  }
});

test("refuses options it doesn't support", { timeout: TEST_TIMEOUT_MS }, async () => {
  const IAC = 255,
    WILL = 251,
    WONT = 252,
    DO = 253,
    DONT = 254;
  const received: number[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => received.push(...chunk));
    socket.on("error", () => {});
    socket.write(Buffer.from([IAC, DO, 200, IAC, WILL, 201]));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  try {
    const connected = waitForHandler(handlers, "onConnect");
    session.connect(options(freePort(server)));
    await connected;
    const expected = [IAC, WONT, 200, IAC, DONT, 201];
    while (!received.some((_, i) => expected.every((byte, j) => received[i + j] === byte))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    session.disconnect();
    server.close();
  }
});

test("sendRaw writes text as-is in UTF-8, adding no line ending", { timeout: TEST_TIMEOUT_MS }, async () => {
  const received: number[] = [];
  const server = net.createServer((socket) => socket.on("data", (chunk) => received.push(...chunk)));
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers } = recordingHandlers();
  const session = new TelnetSession(handlers, noopLog);
  try {
    const connected = waitForHandler(handlers, "onConnect");
    session.connect(options(freePort(server)));
    await connected;
    session.sendRaw("co x \xff\r");
    const expected = [...Buffer.from("co x ", "utf8"), 0xc3, 0xbf, 13];
    while (received.length < expected.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, expected);
  } finally {
    session.disconnect();
    server.close();
  }
});
