import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { ConnectionManager, type ConnectionManagerHandlers } from "./connection-manager";
import { newWorld } from "./world-utils";
import type { Character, ConnectTarget } from "./worlds-types";

const TEST_TIMEOUT_MS = 5000;

function noopLog(): void {}

// A server that records what it receives and greets each connection.
async function recordingServer(): Promise<{ server: net.Server; port: number; received: () => string }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => {});
    socket.write("Welcome!\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    received: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function managerWithLog(): { manager: ConnectionManager; messages: string[]; connected: Promise<ConnectTarget> } {
  const messages: string[] = [];
  let resolveConnected: (target: ConnectTarget) => void = () => {};
  const connected = new Promise<ConnectTarget>((resolve) => (resolveConnected = resolve));
  const handlers: ConnectionManagerHandlers = {
    onConnecting: () => {},
    onStateChange: () => {},
    onMessage: (text) => messages.push(text),
    onData: () => {},
    onConnected: (target) => resolveConnected(target),
  };
  return { manager: new ConnectionManager(handlers, noopLog), messages, connected };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
}

const cowpernica: Character = { id: "c", name: "Cowpernica", password: "hunter2" };

test("auto-login sends the expanded template after connecting as a character", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port, received } = await recordingServer();
  const world = { ...newWorld("w"), name: "Test", host: "127.0.0.1", port, characters: [cowpernica] };
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world, character: cowpernica });
    assert.equal(manager.getState().status, "connecting");
    await connected;
    assert.deepEqual(manager.getState(), { status: "connected", secure: false, label: "Cowpernica - Test" });
    await waitUntil(() => received().length > 0);
    assert.equal(received(), 'co "Cowpernica" hunter2\r');
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("no login is sent without a character or with auto-login off", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port, received } = await recordingServer();
  const world = { ...newWorld("w"), host: "127.0.0.1", port, characters: [cowpernica] };
  try {
    const targets = [
      { world, character: null },
      { world: { ...world, autoLogin: false }, character: cowpernica },
    ];
    for (const [index, target] of targets.entries()) {
      const { manager, connected } = managerWithLog();
      manager.connect(target);
      await connected;
      manager.sendLine("look");
      await waitUntil(() => received().split("look\r\n").length - 1 === index + 1);
      manager.disconnect();
    }
    assert.equal(received(), "look\r\nlook\r\n");
  } finally {
    server.close();
  }
});

test("a world without a host or port is refused with a message", () => {
  const { manager, messages } = managerWithLog();
  manager.connect({ world: { ...newWorld("w"), name: "Blank" }, character: null });
  assert.equal(manager.isActive(), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /can't connect to Blank/);
});

test("disconnecting returns to the disconnected state", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port } = await recordingServer();
  const { manager, messages, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    manager.disconnect();
    await waitUntil(() => !manager.isActive());
    assert.deepEqual(manager.getState(), { status: "disconnected", secure: false, label: null });
    assert.equal(manager.getConnected(), null);
    assert.match(messages[messages.length - 1], /disconnected/);
  } finally {
    server.close();
  }
});
