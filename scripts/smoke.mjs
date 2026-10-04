// Smoke check: launches the built app (run `npm run build` first; `npm run
// smoke` does) and drives it over the Chrome DevTools Protocol, checking the
// renderer behavior unit tests can't reach: where keyboard focus goes, and
// that typing reaches the server.
//
// Everything runs in a throwaway sandbox: its own config folder (so its own
// preferences and single-instance lock, apart from a Moolin you have
// running), worlds file and Documents folder (for session logs), and a local
// server to connect to. Windows open on screen while it runs. Linux only,
// since it sandboxes via XDG_CONFIG_HOME and user-dirs.dirs.
//
// Exits non-zero if any check fails.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const electron = createRequire(import.meta.url)("electron");
const TIMEOUT_MS = 10000;

if (process.platform !== "linux") {
  console.error("smoke: Linux only for now (it sandboxes the app via XDG_CONFIG_HOME)");
  process.exit(2);
}
if (!fs.existsSync(path.join(ROOT, "dist", "main.js"))) {
  console.error("smoke: no build in dist/; run `npm run smoke`, which builds first");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls `condition` (sync or async) until it's truthy, or throws `what`.
async function waitFor(what, condition, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// --- The sandbox -------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-smoke-"));
const configDir = path.join(sandbox, "config");
const documentsDir = path.join(sandbox, "Documents");
const worldsFile = path.join(sandbox, "worlds");
fs.mkdirSync(configDir);
fs.mkdirSync(documentsDir);
fs.writeFileSync(path.join(configDir, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${documentsDir}"\n`);
const env = { ...process.env, XDG_CONFIG_HOME: configDir };
delete env.ELECTRON_RUN_AS_NODE;

// A server that greets each connection and records what it's sent.
let received = "";
const server = net.createServer((socket) => {
  socket.on("data", (data) => {
    received += data.toString();
  });
  socket.on("error", () => {});
  socket.write("Welcome to the smoke test!\r\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverPort = server.address().port;

const launched = [];
function launch(...extraArgs) {
  const child = spawn(electron, [ROOT, worldsFile, ...extraArgs], { env, stdio: "ignore", detached: true });
  launched.push(child);
  return child;
}

// --- Chrome DevTools Protocol --------------------------------------------------

let devtoolsPort;

async function pageTargets() {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  return targets.filter((target) => target.type === "page");
}

// One window's page, driven over its own DevTools connection.
class Page {
  static async attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const page = new Page(ws);
    await waitFor("the page to load", () => page.evaluate("!!document.getElementById('input-area')").catch(() => false));
    return page;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (message) => {
      const reply = JSON.parse(message.data);
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
    });
  }

  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  // The focused element, as its id (or tag name when it has none).
  activeElement() {
    return this.evaluate("(() => { const a = document.activeElement; return a ? a.id || a.className || a.tagName : null; })()");
  }

  hasFocus() {
    return this.evaluate("document.hasFocus()");
  }

  // A point inside the scrollback, `dx` pixels in from its left edge.
  async scrollbackPoint(dx = 20) {
    return this.evaluate(
      `(() => { const r = document.querySelector("#terminal .xterm-screen").getBoundingClientRect(); return { x: r.x + ${dx}, y: r.y + 10 }; })()`,
    );
  }

  async mouse(type, { x, y }, clickCount = 1) {
    await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  }

  async clickScrollback() {
    const point = await this.scrollbackPoint();
    await this.mouse("mousePressed", point);
    await this.mouse("mouseReleased", point);
    await sleep(150); // focus is put right after the event that moved it
  }

  async dragInScrollback() {
    const from = await this.scrollbackPoint(5);
    await this.mouse("mousePressed", from);
    for (let i = 1; i <= 5; i++) await this.mouse("mouseMoved", { x: from.x + i * 15, y: from.y });
    await this.mouse("mouseReleased", { x: from.x + 75, y: from.y });
    await sleep(150);
  }

  async doubleClickScrollback() {
    const point = await this.scrollbackPoint();
    for (const clickCount of [1, 2]) {
      await this.mouse("mousePressed", point, clickCount);
      await this.mouse("mouseReleased", point, clickCount);
    }
    await sleep(150);
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
    }
  }

  // Types `text` wherever focus is, then presses Enter.
  async typeLine(text) {
    for (const char of text) await this.call("Input.dispatchKeyEvent", { type: "char", text: char });
    await this.key("Enter", "Enter", 13);
  }

  close() {
    this.ws.close();
  }
}

// --- Checks ------------------------------------------------------------------

const results = [];

async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}${note ? ` (${note})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Types a line and checks it reaches the server (and only it).
async function typingReachesServer(page, text) {
  received = "";
  await page.typeLine(text);
  const arrived = await waitFor("the line", () => received.includes(`${text}\r\n`), 2000).catch(() => false);
  if (!arrived) {
    const focus = await page.activeElement();
    throw new Error(`typed ${JSON.stringify(text)}, but the server got ${JSON.stringify(received)} (focus was on ${focus})`);
  }
  expectEqual(received, `${text}\r\n`, "what the server received");
}

const pages = [];
try {
  launch("--remote-debugging-port=0");
  // Chromium writes the port it picked into the profile folder.
  const portFile = path.join(configDir, "Moolin", "DevToolsActivePort");
  devtoolsPort = await waitFor("the app to start", () =>
    fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) : 0,
  );
  const [firstTarget] = await waitFor("a window", async () => {
    const targets = await pageTargets().catch(() => []);
    return targets.length > 0 && targets;
  });
  const main = await Page.attach(firstTarget);
  pages.push(main);

  console.log("smoke: connected window");
  await check("connects to a world", async () => {
    await main.evaluate(
      `window.moolin.connect(${JSON.stringify({
        id: "smoke",
        name: "Smoke Test",
        host: "127.0.0.1",
        port: serverPort,
        tls: false,
        tlsAllowUntrusted: false,
        autoLogin: false,
        loginTemplate: "",
        echoCommands: true,
        characters: [],
      })}, null)`,
    );
    await waitFor("the status bar to say connected", async () =>
      (await main.evaluate("document.getElementById('status-text').textContent")).startsWith("Connected"),
    );
    expectEqual(await main.activeElement(), "input-area", "focus once connected");
  });

  await check("typing in the input area reaches the server", () => typingReachesServer(main, "look"));

  await check("clicking the scrollback leaves typing in the input area", async () => {
    await main.clickScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the click");
    await typingReachesServer(main, "after click");
  });

  await check("selecting in the scrollback leaves typing in the input area", async () => {
    await main.dragInScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the drag");
    await typingReachesServer(main, "after drag");
  });

  await check("double-clicking the scrollback leaves typing in the input area", async () => {
    await main.doubleClickScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the double-click");
    await typingReachesServer(main, "after double-click");
  });

  // Launching again opens a second window in the running instance; it starts
  // disconnected, and (usually) takes focus from the first.
  console.log("smoke: a second, disconnected window");
  launch();
  const secondTarget = await waitFor("a second window", async () =>
    (await pageTargets()).find((target) => target.id !== firstTarget.id),
  );
  const second = await Page.attach(secondTarget);
  pages.push(second);

  await check("clicking an inactive window's scrollback leaves typing in its input area", async () => {
    // An inactive window fires no focus events, so focus can be lost (here,
    // by removing the focused element) and then land in the scrollback on a
    // click without any focusout to react to: the case focusin handles.
    const inactive = await waitFor("the first window to lose focus", async () => !(await main.hasFocus()), 3000).catch(
      () => false,
    );
    if (!inactive) return "skipped: the window manager kept the first window active";
    await main.evaluate(
      `(() => { const b = document.createElement("button"); document.body.append(b); b.focus(); b.remove(); })()`,
    );
    expectEqual(await main.activeElement(), "BODY", "focus before the click");
    await main.clickScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the click");
    await typingReachesServer(main, "after inactive click");
  });

  await check("while not connected, the scrollback doesn't keep focus", async () => {
    expectEqual(await second.evaluate("document.getElementById('input-area').disabled"), true, "input disabled");
    await second.clickScrollback();
    expectEqual(await second.activeElement(), "BODY", "focus after the click");
  });

  // Electron doesn't run menu shortcuts for keys sent over DevTools, so this
  // checks their precondition instead: a shortcut only fires if the page
  // doesn't cancel the key. xterm would (it turns Ctrl+letter into a control
  // character), so this puts focus in its text box, the worst case, and
  // presses Ctrl+O there in the same task, before focus can be reclaimed.
  await check("the scrollback never swallows menu shortcuts like Ctrl+O", async () => {
    for (const page of [main, second]) {
      const cancelled = await page.evaluate(`(() => {
        document.querySelector(".xterm-helper-textarea").focus();
        const event = new KeyboardEvent("keydown", { key: "o", code: "KeyO", ctrlKey: true, bubbles: true, cancelable: true });
        Object.defineProperty(event, "keyCode", { get: () => 79 }); // what xterm reads
        document.activeElement.dispatchEvent(event);
        return event.defaultPrevented;
      })()`);
      expectEqual(cancelled, false, "Ctrl+O cancelled");
    }
  });
} catch (error) {
  results.push({ name: "setup", ok: false });
  console.log(`  FAIL  setup: ${error.message}`);
} finally {
  for (const page of pages) page.close();
  for (const child of launched) {
    try {
      process.kill(-child.pid); // the whole process group: Electron's helpers too
    } catch {
      // already gone
    }
  }
  server.close();
  await sleep(500);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `smoke: ${failed} of ${results.length} failed` : `smoke: all ${results.length} passed`);
process.exit(failed ? 1 : 0);
