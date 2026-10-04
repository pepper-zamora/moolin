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

// `events` records every handler call in order, for tests of the sequence.
function managerWithLog(): {
  manager: ConnectionManager;
  messages: string[];
  events: string[];
  connected: Promise<ConnectTarget>;
} {
  const messages: string[] = [];
  const events: string[] = [];
  let resolveConnected: (target: ConnectTarget) => void = () => {};
  const connected = new Promise<ConnectTarget>((resolve) => (resolveConnected = resolve));
  const handlers: ConnectionManagerHandlers = {
    onConnecting: (target) => events.push(`connecting:${target.world.id}`),
    onStateChange: () => events.push("state"),
    onMessage: (text) => {
      messages.push(text);
      events.push(`message:${text.replace(/\x1b\[\d+m|\r\n/g, "")}`);
    },
    onData: (data) => events.push(`data:${Buffer.from(data).toString().trim()}`),
    onConnected: (target) => {
      events.push("connected");
      resolveConnected(target);
    },
    onDisconnected: () => events.push("disconnected"),
  };
  return { manager: new ConnectionManager(handlers, noopLog), messages, events, connected };
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
    assert.deepEqual(manager.getState(), {
      status: "connected",
      label: "Cowpernica - Test",
      address: `127.0.0.1:${port}`,
      tls: null,
    });
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
    assert.deepEqual(manager.getState(), { status: "disconnected", label: null, address: null, tls: null });
    assert.equal(manager.getConnected(), null);
    assert.match(messages[messages.length - 1], /disconnected/);
  } finally {
    server.close();
  }
});

test("a connection's events come in order: connecting before output, disconnected after the last line", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port } = await recordingServer();
  const { manager, events, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), name: "Moo", host: "127.0.0.1", port }, character: null });
    await connected;
    await waitUntil(() => events.includes("data:Welcome!"));
    manager.disconnect();
    // disconnect() reports the disconnect before returning.
    assert.equal(manager.isActive(), false);
    assert.deepEqual(events, [
      "connecting:w",
      `message:[connecting to Moo (127.0.0.1:${port})...]`,
      "state",
      "connected",
      "state",
      "message:[connected to Moo]",
      "data:Welcome!",
      "state",
      "message:[disconnected]",
      "disconnected",
    ]);
  } finally {
    server.close();
  }
});

test("connecting again ends the first connection, and ignores its late events", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port } = await recordingServer();
  const { manager, events, connected } = managerWithLog();
  try {
    const world = { ...newWorld("w"), name: "Moo", host: "127.0.0.1", port };
    manager.connect({ world, character: null });
    await connected;
    events.length = 0;
    manager.connect({ world: { ...world, id: "w2", name: "Moo2" }, character: null });
    // The first connection is over, its log released, before the second begins.
    assert.deepEqual(events.slice(0, 4), ["state", "message:[disconnected]", "disconnected", "connecting:w2"]);
    await waitUntil(() => manager.getConnected()?.world.id === "w2");
    // Let the first socket's own close event arrive: it must change nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.filter((event) => event === "disconnected").length, 1);
    assert.equal(manager.getState().status, "connected");
    assert.equal(manager.getState().label, "Moo2");
  } finally {
    manager.disconnect();
    server.close();
  }
});
