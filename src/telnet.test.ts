import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import * as tls from "tls";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { TelnetSession, type TelnetSessionHandlers, type TlsInfo } from "./telnet";
import type { World } from "./worlds-types";

function makeWorld(port: number, host = "127.0.0.1"): World {
  return { id: "test", name: "test", host, port };
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
    onDisconnect: (reason) => events.push(`disconnect:${reason ?? ""}`),
    onTlsProbeResult: (secure, info) => events.push(`tlsProbe:${secure}:${info?.protocol ?? ""}`),
  };
  return { handlers, events };
}

// Bounded so a hang in the code under test fails the test fast with a clear
// "timed out" instead of hanging the whole suite.
const TEST_TIMEOUT_MS = 5000;

test("falls back to plaintext against a server that doesn't speak TLS", { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = net.createServer((socket) => socket.write("hello\r\n"));
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers, events } = recordingHandlers();
  const originalOnData = handlers.onData;
  const session = new TelnetSession(handlers, noopLog);

  try {
    await new Promise<void>((resolve) => {
      handlers.onData = (data) => {
        originalOnData(data);
        resolve();
      };
      session.connect(makeWorld(freePort(server)));
    });

    assert.deepEqual(events.slice(0, 3), ["tlsProbe:false:", "connect:false", "data"]);
  } finally {
    session.disconnect();
    server.close();
  }
});

test("connects securely against a TLS 1.2+ server and reports cert/cipher info", { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-test-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=test.moolin.local"`,
    { stdio: "ignore" },
  );

  const server = tls.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), minVersion: "TLSv1.2" },
    (socket) => socket.write("hello\r\n"),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers, events } = recordingHandlers();
  let tlsInfo: TlsInfo | undefined;
  const originalOnConnect = handlers.onConnect;
  const originalOnTlsProbeResult = handlers.onTlsProbeResult;
  handlers.onTlsProbeResult = (secure, info) => {
    tlsInfo = info;
    originalOnTlsProbeResult(secure, info);
  };
  const session = new TelnetSession(handlers, noopLog);

  try {
    await new Promise<void>((resolve) => {
      handlers.onConnect = (secure) => {
        originalOnConnect(secure);
        resolve();
      };
      session.connect(makeWorld(freePort(server)));
    });

    assert.deepEqual(
      events.slice(0, 2).map((e) => e.split(":").slice(0, 2).join(":")),
      ["tlsProbe:true", "connect:true"],
    );
    assert.ok(tlsInfo);
    assert.equal(tlsInfo?.certSubject, "test.moolin.local");
    // Self-signed, so it should connect anyway but flag the cert as untrusted.
    assert.equal(tlsInfo?.certValid, false);
    assert.match(tlsInfo?.certValidationError ?? "", /SELF_SIGNED/);
  } finally {
    session.disconnect();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable host surfaces as a plain disconnect, not a TLS probe result", { timeout: TEST_TIMEOUT_MS }, async () => {
  // ".invalid" is reserved by RFC 2606 to never resolve, so this fails fast
  // and deterministically via DNS rather than depending on how quickly (or
  // whether) a given network refuses a connection to a closed port.
  const { handlers, events } = recordingHandlers();
  const originalOnDisconnect = handlers.onDisconnect;
  const session = new TelnetSession(handlers, noopLog);

  try {
    await new Promise<void>((resolve) => {
      handlers.onDisconnect = (reason) => {
        originalOnDisconnect(reason);
        resolve();
      };
      session.connect(makeWorld(12345, "nonexistent.invalid"));
    });

    assert.deepEqual(events, [events[0]]);
    assert.ok(events[0]?.startsWith("disconnect:") && events[0] !== "disconnect:");
  } finally {
    session.disconnect();
  }
});

test("disconnect() during the TLS probe tears down cleanly without hanging", { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = net.createServer(() => {}); // accepts but never sends anything
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const { handlers, events } = recordingHandlers();
  const originalOnDisconnect = handlers.onDisconnect;
  const session = new TelnetSession(handlers, noopLog);

  try {
    await new Promise<void>((resolve) => {
      handlers.onDisconnect = (reason) => {
        originalOnDisconnect(reason);
        resolve();
      };
      session.connect(makeWorld(freePort(server)));
      session.disconnect();
    });

    assert.deepEqual(events, ["disconnect:"]);
  } finally {
    session.disconnect();
    server.close();
  }
});

test("negotiates ECHO, NAWS and TTYPE, and stops local echo while the server echoes", { timeout: TEST_TIMEOUT_MS }, async () => {
  const IAC = 255, SB = 250, SE = 240, WILL = 251, WONT = 252, DO = 253;
  const ECHO = 1, TTYPE = 24, NAWS = 31;
  let serverSocket: net.Socket | undefined;
  const received: number[] = [];
  const server = net.createServer((socket) => {
    serverSocket = socket;
    socket.on("data", (chunk) => received.push(...chunk));
    socket.on("error", () => {}); // the TLS probe's connection is reset by the client
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
    await new Promise<void>((resolve) => {
      handlers.onConnect = () => resolve();
      session.connect(makeWorld(freePort(server)));
    });
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
  const IAC = 255, WILL = 251, WONT = 252, DO = 253, DONT = 254;
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
    await new Promise<void>((resolve) => {
      handlers.onConnect = () => resolve();
      session.connect(makeWorld(freePort(server)));
    });
    const expected = [IAC, WONT, 200, IAC, DONT, 201];
    while (!received.some((_, i) => expected.every((byte, j) => received[i + j] === byte))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    session.disconnect();
    server.close();
  }
});
