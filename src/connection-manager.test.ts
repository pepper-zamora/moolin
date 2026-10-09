import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { ConnectionManager, type ConnectionManagerHandlers, PUEBLO_CLIENT_REPLY } from "./connection-manager";
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
    onGreetingClosed: () => events.push("greeting-closed"),
  };
  return { manager: new ConnectionManager(handlers, noopLog), messages, events, connected };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
}

const cowpernica: Character = {
  id: "c",
  name: "Cowpernica",
  password: "hunter2",
  echoCommands: "inherit",
  wordWrap: "inherit",
};

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
      wordWrap: false,
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

test("connect()'s resolved settings carry through to getState() and echoCommandsEnabled()", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port } = await recordingServer();
  const { manager, connected } = managerWithLog();
  try {
    manager.connect(
      { world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null },
      { wordWrap: true, echoCommands: false },
    );
    await connected;
    assert.equal(manager.getState().wordWrap, true);
    assert.equal(manager.echoCommandsEnabled(), false);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("omitting connect()'s resolved settings defaults to no word-wrap and echo on", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port } = await recordingServer();
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    assert.equal(manager.getState().wordWrap, false);
    assert.equal(manager.echoCommandsEnabled(), true);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("getState().wordWrap and echoCommandsEnabled() fall back once disconnected", () => {
  const { manager } = managerWithLog();
  assert.equal(manager.getState().wordWrap, false);
  assert.equal(manager.echoCommandsEnabled(), true);
});

test("disconnecting returns to the disconnected state", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port } = await recordingServer();
  const { manager, messages, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    manager.disconnect();
    await waitUntil(() => !manager.isActive());
    assert.deepEqual(manager.getState(), {
      status: "disconnected",
      label: null,
      address: null,
      tls: null,
      wordWrap: false,
    });
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

// A server that greets each connection by writing `pieces` in turn (with a
// pause between, so each arrives as its own chunk), and records what it gets.
async function greetingServer(pieces: string[]): Promise<{ server: net.Server; port: number; received: () => string }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => {});
    void (async () => {
      for (const piece of pieces) {
        socket.write(piece);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    received: () => Buffer.concat(chunks).toString("utf8"),
  };
}

test("a Pueblo greeting is answered once, and the connection is marked Pueblo", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port, received } = await greetingServer(["This world is Pueblo 1.0 Enhanced.\r\n", "later\r\n"]);
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    assert.equal(manager.isPueblo(), false);
    await connected;
    await waitUntil(() => received().length > 0);
    assert.equal(received(), PUEBLO_CLIENT_REPLY);
    assert.equal(manager.isPueblo(), true);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("a greeting split across chunks is still answered", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port, received } = await greetingServer(["This world is Pue", "blo\r\n"]);
  const { manager } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await waitUntil(() => received().length > 0);
    assert.equal(received(), PUEBLO_CLIENT_REPLY);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("a server that doesn't greet is sent nothing and isn't Pueblo", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port, received } = await greetingServer(["Welcome to a plain world\r\n"]);
  const { manager, events, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    await waitUntil(() => events.some((event) => event.startsWith("data:")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received(), "");
    assert.equal(manager.isPueblo(), false);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("Pueblo mode outlives the connection, and the next connection starts without it", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const pueblo = await greetingServer(["This world is Pueblo\r\n"]);
  const plain = await greetingServer(["hello\r\n"]);
  const { manager, events } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("a"), host: "127.0.0.1", port: pueblo.port }, character: null });
    await waitUntil(() => manager.isPueblo());
    manager.disconnect();
    await waitUntil(() => events.includes("disconnected"));
    assert.equal(manager.isPueblo(), true);
    manager.connect({ world: { ...newWorld("b"), host: "127.0.0.1", port: plain.port }, character: null });
    assert.equal(manager.isPueblo(), false);
    await waitUntil(() => events.filter((event) => event.startsWith("data:")).length > 1);
    assert.equal(manager.isPueblo(), false);
  } finally {
    manager.disconnect();
    pueblo.server.close();
    plain.server.close();
  }
});

test("disconnecting for sleep ends the connection with a message saying why", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port } = await recordingServer();
  const { manager, messages, events, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    manager.disconnectForSleep();
    assert.equal(manager.getState().status, "disconnected");
    assert.equal(manager.isActive(), false);
    assert.equal(events.filter((event) => event === "disconnected").length, 1);
    assert.match(messages[messages.length - 1], /\[disconnected: the computer is going to sleep\]/);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("the server sees a graceful close when the computer goes to sleep", { timeout: TEST_TIMEOUT_MS }, async () => {
  let ended = false;
  const server = net.createServer((socket) => {
    socket.on("end", () => (ended = true));
    socket.on("error", () => {});
    socket.resume(); // 'end' is only seen by a socket that is being read
    socket.write("hi\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { manager, events, connected } = managerWithLog();
  try {
    manager.connect({
      world: { ...newWorld("w"), host: "127.0.0.1", port: (server.address() as net.AddressInfo).port },
      character: null,
    });
    await connected;
    // Closing a socket that still has unread input can reset it instead of
    // ending it cleanly, so let the greeting arrive first.
    await waitUntil(() => events.includes("data:hi"));
    manager.disconnectForSleep();
    await waitUntil(() => ended);
  } finally {
    server.close();
  }
});

test("an ordinary disconnect keeps the plain message, and disconnecting with nothing connected does nothing", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const idle = managerWithLog();
  idle.manager.disconnect("no reason to speak of");
  idle.manager.disconnectForSleep();
  assert.deepEqual(idle.events, []);

  const { server, port } = await recordingServer();
  const { manager, messages, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    manager.disconnect();
    assert.match(messages[messages.length - 1], /\[disconnected\]/);
  } finally {
    server.close();
  }
});

// A server that says nothing until `speak()` is called, then writes `text`, and
// records what it gets.
async function quietServer(): Promise<{
  server: net.Server;
  port: number;
  received: () => string;
  speak: (text: string) => Promise<void>;
}> {
  const chunks: Buffer[] = [];
  let accepted: (socket: net.Socket) => void = () => {};
  const client = new Promise<net.Socket>((resolve) => (accepted = resolve));
  const server = net.createServer((socket) => {
    accepted(socket);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    received: () => Buffer.concat(chunks).toString("utf8"),
    // The client sees the connection before the server has accepted it.
    speak: async (text) => {
      (await client).write(text);
    },
  };
}

test("auto-login waits for the server to say something first", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port, received, speak } = await quietServer();
  const world = { ...newWorld("w"), host: "127.0.0.1", port, characters: [cowpernica] };
  const { manager, events, connected } = managerWithLog();
  try {
    manager.connect({ world, character: cowpernica });
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received(), "", "nothing is sent to a server that hasn't spoken");
    assert.equal(manager.isGreetingOpen(), true);
    await speak("Welcome!\r\n");
    await waitUntil(() => received().length > 0);
    assert.equal(received(), 'co "Cowpernica" hunter2\r');
    assert.equal(manager.isGreetingOpen(), false);
    assert.equal(events.filter((e) => e === "greeting-closed").length, 1);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("a greeting in the welcome is answered before an auto-login, which then closes the greeting", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port, received, speak } = await quietServer();
  const world = { ...newWorld("w"), host: "127.0.0.1", port, characters: [cowpernica] };
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world, character: cowpernica });
    await connected;
    await speak("This world is Pueblo 1.0 Enhanced.\r\n");
    await waitUntil(() => received().includes("hunter2"));
    assert.equal(received(), `${PUEBLO_CLIENT_REPLY}co "Cowpernica" hunter2\r`);
    assert.equal(manager.isPueblo(), true);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("the words said after an auto-login are not a greeting", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port, received, speak } = await quietServer();
  const world = { ...newWorld("w"), host: "127.0.0.1", port, characters: [cowpernica] };
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world, character: cowpernica });
    await connected;
    await speak("Welcome!\r\n");
    await waitUntil(() => received().includes("hunter2"));
    await speak('Mallory says, "This world is Pueblo"\r\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received(), 'co "Cowpernica" hunter2\r');
    assert.equal(manager.isPueblo(), false);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("the words said after a typed line are not a greeting, but a greeting before one is", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { server, port, received, speak } = await quietServer();
  const { manager, events, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    assert.equal(manager.isGreetingOpen(), true);
    manager.sendLine("look");
    assert.equal(manager.isGreetingOpen(), false);
    manager.sendLine("again");
    assert.equal(events.filter((e) => e === "greeting-closed").length, 1, "closing is reported once");
    await speak("This world is Pueblo\r\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received(), "look\r\nagain\r\n");
    assert.equal(manager.isPueblo(), false);
  } finally {
    manager.disconnect();
    server.close();
  }
});

test("a new connection opens the greeting again", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { server, port } = await quietServer();
  const { manager, connected } = managerWithLog();
  try {
    manager.connect({ world: { ...newWorld("w"), host: "127.0.0.1", port }, character: null });
    await connected;
    manager.sendLine("look");
    assert.equal(manager.isGreetingOpen(), false);
    manager.connect({ world: { ...newWorld("w2"), host: "127.0.0.1", port }, character: null });
    assert.equal(manager.isGreetingOpen(), true);
  } finally {
    manager.disconnect();
    server.close();
  }
});
