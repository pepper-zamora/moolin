// Smoke check: launches the built app (run `npm run build` first; `npm run
// smoke` does) and drives it over the Chrome DevTools Protocol, checking the
// renderer behavior unit tests can't reach: where keyboard focus goes, and
// that typing reaches the server.
//
// Everything runs in a throwaway sandbox: its own config folder (so its own
// preferences and single-instance lock, apart from a Moolin you have
// running), worlds file and Documents folder (for session logs), and a local
// server to connect to. Windows open on screen while it runs (so it needs a
// real display; on headless Linux use xvfb-run).
//
// On Linux, the sandbox works by setting XDG_CONFIG_HOME and faking
// user-dirs.dirs, which Electron's app.getPath("userData"/"documents")
// honors there. Elsewhere (macOS, Windows) Electron ignores both, so main.ts
// instead reads MOOLIN_CONFIG_DIR/MOOLIN_DOCUMENTS_DIR directly when set and
// redirects app.setPath() itself before anything reads those paths.
//
// To check a packaged build instead, set MOOLIN_SMOKE_APP to its executable
// (release/linux-unpacked/moolin, the AppImage, or the macOS .app's binary
// inside Contents/MacOS/).
//
// Exits non-zero if any check fails.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const packagedApp = process.env.MOOLIN_SMOKE_APP && path.resolve(process.env.MOOLIN_SMOKE_APP);
const electron = createRequire(import.meta.url)("electron");
const TIMEOUT_MS = 10000;
// Focus returns to the input area this long after a click in the scrollback,
// the time the system allows for it to become a double click (see renderer.ts).
const FOCUS_RETURN_MS = 650;

if (packagedApp && !fs.existsSync(packagedApp)) {
  console.error(`smoke: no app at ${packagedApp}`);
  process.exit(2);
}
if (!packagedApp && !fs.existsSync(path.join(ROOT, "dist", "main.js"))) {
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

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Where Electron actually resolves app.getPath("userData") to, given how
// each platform's branch below redirects it; used to find DevToolsActivePort.
let userDataDir;
if (process.platform === "linux") {
  // Electron's default userData is $XDG_CONFIG_HOME/<app name>.
  fs.writeFileSync(path.join(configDir, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${documentsDir}"\n`);
  env.XDG_CONFIG_HOME = configDir;
  userDataDir = path.join(configDir, "Moolin");
} else {
  // macOS/Windows: Electron doesn't consult XDG_CONFIG_HOME or
  // user-dirs.dirs, so redirect the paths directly (main.ts honors these,
  // via app.setPath, which takes configDir as the literal userData path —
  // no app-name subdirectory appended).
  env.MOOLIN_CONFIG_DIR = configDir;
  env.MOOLIN_DOCUMENTS_DIR = documentsDir;
  userDataDir = configDir;
}

// A server that greets each connection and records what it's sent. Also
// keeps the latest socket around so a check can push arbitrary data to the
// client on demand (see the copy checks below).
let received = "";
let latestSocket = null;
const server = net.createServer((socket) => {
  latestSocket = socket;
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
  const [command, ...appArgs] = packagedApp ? [packagedApp] : [electron, ROOT];
  const child = spawn(command, [...appArgs, worldsFile, ...extraArgs], { env, stdio: "ignore", detached: true });
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
      `(() => { const r = document.querySelector("#terminal").getBoundingClientRect(); return { x: r.x + ${dx}, y: r.y + 10 }; })()`,
    );
  }

  async mouse(type, { x, y }, clickCount = 1) {
    await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  }

  // `settle` waits for focus to come back to the input area, which is put
  // there once the time for a double click has passed (or at the first key).
  async clickScrollback(settle = true) {
    const point = await this.scrollbackPoint();
    await this.mouse("mousePressed", point);
    await this.mouse("mouseReleased", point);
    if (settle) await sleep(FOCUS_RETURN_MS);
  }

  async dragInScrollback() {
    const from = await this.scrollbackPoint(5);
    await this.mouse("mousePressed", from);
    for (let i = 1; i <= 5; i++) await this.mouse("mouseMoved", { x: from.x + i * 15, y: from.y });
    await this.mouse("mouseReleased", { x: from.x + 75, y: from.y });
    await sleep(FOCUS_RETURN_MS);
  }

  async doubleClickScrollback() {
    const point = await this.scrollbackPoint();
    for (const clickCount of [1, 2]) {
      await this.mouse("mousePressed", point, clickCount);
      await this.mouse("mouseReleased", point, clickCount);
    }
    await sleep(150);
  }

  // The scrollback's lines as the page has them: one element per line the
  // server sent, however many rows it wraps to.
  async lineTexts() {
    return this.evaluate(`Array.from(document.querySelectorAll("#terminal .line"), (line) => line.textContent)`);
  }

  // How many line elements the scrollback holds.
  async lineCount() {
    return this.evaluate(`document.querySelectorAll("#terminal .line").length`);
  }

  // The screen position of character `offset` of the newest line starting
  // with `prefix` (null if there is none): its top-left corner plus a pixel
  // when `edge` is "left", and the middle of its box when "middle". A drag
  // that starts at one character's left edge and ends at another's selects
  // exactly the characters between them. Offsets past the end of the text
  // give the right edge of the last character.
  async textPoint(prefix, offset, edge = "left") {
    return this.evaluate(`(() => {
      const prefix = ${JSON.stringify(prefix)};
      const offset = ${offset};
      const line = Array.from(document.querySelectorAll("#terminal .line")).reverse().find((l) => l.textContent.startsWith(prefix));
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let seen = 0;
      let last = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        last = node;
        if (offset < seen + node.length) {
          const range = document.createRange();
          range.setStart(node, offset - seen);
          range.setEnd(node, offset - seen + 1);
          const box = range.getBoundingClientRect();
          return { x: ${edge === "middle" ? "box.x + box.width / 2" : "box.x + 1"}, y: box.y + box.height / 2 };
        }
        seen += node.length;
      }
      if (!last) return null;
      const range = document.createRange();
      range.setStart(last, last.length - 1);
      range.setEnd(last, last.length);
      const box = range.getBoundingClientRect();
      return { x: box.right - 1, y: box.y + box.height / 2 };
    })()`);
  }

  // Drags a selection from one point to another with real mouse events, in
  // many small steps with a frame between them, as a hand would.
  async dragSelect(from, to) {
    await this.mouse("mousePressed", from);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await sleep(10);
    }
    await this.mouse("mouseReleased", to);
    await sleep(150);
  }

  // Selects characters [start, end) of the newest line starting with `prefix`.
  async selectText(prefix, start, end) {
    const from = await this.textPoint(prefix, start);
    const to = await this.textPoint(prefix, end);
    if (!from || !to) throw new Error(`couldn't find a line starting with ${JSON.stringify(prefix)}`);
    await this.dragSelect(from, to);
  }

  // Selects from character `start` of one line to character `end` of another.
  async selectAcross(fromPrefix, start, toPrefix, end) {
    const from = await this.textPoint(fromPrefix, start);
    const to = await this.textPoint(toPrefix, end);
    if (!from || !to) throw new Error("couldn't find both lines");
    await this.dragSelect(from, to);
  }

  // Clicks `count` times in a row at a point (2 selects a word, 3 a line).
  async clickAt(point, count) {
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await this.mouse("mousePressed", point, clickCount);
      await this.mouse("mouseReleased", point, clickCount);
    }
    await sleep(150);
  }

  // What Ctrl+C put on the clipboard.
  async copy() {
    await this.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    return this.evaluate("window.moolin.clipboard.readText()");
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
    }
  }

  // Types `text` wherever focus is, then presses Enter. Each character goes
  // down as a real key press does, a keydown then the character, since the
  // page may act on the keydown (the first one after a click in the
  // scrollback is what moves focus to the input area).
  async typeLine(text) {
    for (const char of text) {
      await this.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: char, text: char });
      await this.call("Input.dispatchKeyEvent", { type: "char", text: char });
      await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
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
  const portFile = path.join(userDataDir, "DevToolsActivePort");
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
      // wordWrap is forced on here (rather than just for its own checks,
      // below) so they can reuse this same connection instead of opening a
      // second window mid-run — word wrap only affects how server output is
      // displayed, so it doesn't interfere with any of the other checks that
      // share this connection.
      `window.moolin.connect(${JSON.stringify({
        id: "smoke",
        name: "Smoke Test",
        host: "127.0.0.1",
        port: serverPort,
        tls: false,
        tlsAllowUntrusted: false,
        autoLogin: false,
        loginTemplate: "",
        echoCommands: "on",
        wordWrap: "on",
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

  await check("typing straight after clicking the scrollback reaches the input area", async () => {
    await main.clickScrollback(false);
    await typingReachesServer(main, "straight after click");
  });

  await check("double-clicking the scrollback leaves typing in the input area", async () => {
    await main.doubleClickScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the double-click");
    await typingReachesServer(main, "after double-click");
  });

  // Copying from the scrollback gives exactly the text selected, however the
  // lines wrap on screen. The long line below is built long enough (many
  // "words", far wider than any window) to wrap at least twice, so a
  // selection can start on one row and end on another.
  const longLine = Array.from({ length: 15 }, (_, i) => `wordNumber${i}IsDeliberatelyLong`).join(" ");
  const cols = Number((await main.evaluate("document.getElementById('screen-size').textContent")).split("x")[0]);
  await check("a word-wrapped long line copies back as exactly one line, with no padding", async () => {
    if (!latestSocket) throw new Error("no server socket to write the long line to");
    if (cols >= longLine.length) throw new Error(`test window too wide (cols=${cols}) for this line to wrap`);
    latestSocket.write(`${longLine}\r\n`);
    await waitFor("the long line", async () => (await main.lineTexts()).includes(longLine), 3000);
    await main.selectText("wordNumber0", 0, longLine.length);
    expectEqual(await main.copy(), longLine, "clipboard after copying the whole wrapped line");
  });

  await check("a selection crossing a wrap point copies exactly the selected text", async () => {
    await main.selectText("wordNumber0", cols - 10, cols + 10);
    expectEqual(await main.copy(), longLine.slice(cols - 10, cols + 10), "clipboard after copying across a wrap");
  });

  await check("a selection confined to one row of a wrapped paragraph copies precisely", async () => {
    await main.selectText("wordNumber0", 0, 10); // "wordNumber"
    expectEqual(await main.copy(), longLine.slice(0, 10), "clipboard after a single-row selection");
  });

  await check("double-clicking a word inside a wrapped paragraph copies just that word", async () => {
    const point = await main.textPoint("wordNumber0", longLine.indexOf("wordNumber1") + 5, "middle");
    await main.clickAt(point, 2);
    expectEqual(await main.copy(), "wordNumber1IsDeliberatelyLong", "clipboard after double-clicking a word");
  });

  // The third standard gesture: triple-click selects a whole line, and a
  // wrapped one is still one line.
  await check("triple-clicking a wrapped paragraph copies the whole line", async () => {
    await main.clickAt(await main.textPoint("wordNumber0", 5, "middle"), 3);
    expectEqual(await main.copy(), longLine, "clipboard after triple-clicking the wrapped paragraph");
  });

  await check("a partial selection on a short line is copied precisely", async () => {
    if (!latestSocket) throw new Error("no server socket to write the short line to");
    latestSocket.write("short line\r\n");
    await waitFor("the short line", async () => (await main.lineTexts()).includes("short line"), 3000);
    await main.selectText("short line", 0, 5);
    expectEqual(await main.copy(), "short", "clipboard after copying part of a short line");
  });

  // A selection across separate lines takes the selected part of the first and
  // last, and every middle line whole, joined by newlines.
  await check("a selection spanning parts of two lines copies just the selected part of each", async () => {
    if (!latestSocket) throw new Error("no server socket to write to");
    latestSocket.write("alpha bravo charlie\r\ndelta echo foxtrot\r\n");
    await waitFor("both lines", async () => (await main.lineTexts()).includes("delta echo foxtrot"), 3000);
    await main.selectAcross("alpha bravo", 6, "delta echo", 5); // "bravo charlie" .. "delta"
    expectEqual(await main.copy(), "bravo charlie\ndelta", "clipboard after spanning two partial lines");
  });

  await check("a selection spanning two partial lines with a whole line between copies all three", async () => {
    if (!latestSocket) throw new Error("no server socket to write to");
    latestSocket.write("golf hotel india\r\njuliet kilo lima\r\nmike november oscar\r\n");
    await waitFor("all three lines", async () => (await main.lineTexts()).includes("mike november oscar"), 3000);
    await main.selectAcross("golf hotel", 5, "mike november", 6);
    expectEqual(await main.copy(), "hotel india\njuliet kilo lima\nmike n", "clipboard after spanning three lines");
  });

  // Select All (Cmd/Ctrl+A) selects the input line, so it can be typed over,
  // unless something is selected in the scrollback, when it selects the whole
  // scrollback.
  await check("Select All selects the input line, or the scrollback when it has a selection", async () => {
    const input = () =>
      main.evaluate(`(() => { const i = document.getElementById("input-area"); return [i.selectionStart, i.selectionEnd, i.value.length]; })()`);
    const pageSelection = () => main.evaluate("getSelection().toString()");
    // The earlier checks left a selection in the scrollback; clicking into the
    // input line is what lets go of it.
    await main.evaluate(`document.getElementById("input-area").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
    await main.evaluate(`(() => { const i = document.getElementById("input-area"); i.focus(); i.value = "say hello"; i.setSelectionRange(9, 9); })()`);
    await main.key("a", "KeyA", 65, 2 /* Ctrl */);
    await sleep(150);
    expectEqual(JSON.stringify(await input()), "[0,9,9]", "input selection after Select All with nothing selected above");
    // Select something in the scrollback with the mouse; focus returns to the input line.
    await main.selectText("Welcome to the smoke test", 0, 7);
    await waitFor("focus back in the input line", async () => (await main.activeElement()) === "input-area", 2000);
    await main.key("a", "KeyA", 65, 2 /* Ctrl */);
    await sleep(150);
    const everything = (await main.lineTexts()).join("\n");
    const whole = await pageSelection();
    if (whole.trimEnd() !== everything.trimEnd()) {
      throw new Error(
        `Select All with a scrollback selection didn't select the whole scrollback (${whole.length} of ${everything.length} characters)`,
      );
    }
    // Clicking into the input line lets go of the scrollback selection, so Select All is the input line's again.
    await main.evaluate(`document.getElementById("input-area").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
    await main.evaluate(`(() => { const i = document.getElementById("input-area"); i.focus(); i.setSelectionRange(3, 3); })()`);
    await main.key("a", "KeyA", 65, 2 /* Ctrl */);
    await sleep(150);
    expectEqual(JSON.stringify(await input()), "[0,9,9]", "input selection after clicking back into the input line");
    await main.evaluate(`document.getElementById("input-area").value = ""`);
  });

  // A web address in the output shows where it goes in the status bar's left
  // area while the pointer is over it, and the connection status returns when
  // it leaves.
  await check("hovering a web address shows it in the status bar, and leaving restores the status", async () => {
    if (!latestSocket) throw new Error("no server socket to write to");
    latestSocket.write("docs at https://example.com/page now\r\n");
    await waitFor("the address", async () => (await main.lineTexts()).includes("docs at https://example.com/page now"), 3000);
    const status = () => main.evaluate("document.getElementById('status-text').textContent");
    const before = await status();
    await main.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await main.textPoint("docs at", 12, "middle")) });
    await waitFor("the address in the status bar", async () => (await status()) === "https://example.com/page", 2000);
    await main.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await main.textPoint("docs at", 0, "middle")) });
    await waitFor("the status to return", async () => (await status()) === before, 2000);
  });

  // Ctrl+L scrolls everything so far out of view with blank lines, once.
  await check("Clear Screen moves earlier output out of view, and a second press adds nothing", async () => {
    await main.key("l", "KeyL", 76, 2 /* Ctrl */);
    await sleep(300);
    const visibleText = () =>
      main.evaluate(`Array.from(document.querySelectorAll("#terminal .line"))
        .filter((l) => { const r = l.getBoundingClientRect(); const t = document.getElementById("terminal").getBoundingClientRect(); return r.bottom > t.top && r.top < t.bottom; })
        .map((l) => l.textContent).join("")`);
    expectEqual(await visibleText(), "", "text left in view after clearing");
    const count = await main.lineCount();
    await main.key("l", "KeyL", 76, 2 /* Ctrl */);
    await sleep(300);
    expectEqual(await main.lineCount(), count, "lines after a second clear");
    latestSocket?.write("after the clear\r\n");
    await waitFor("new output after clearing", async () => (await visibleText()).includes("after the clear"), 3000);
  });

  // A Pueblo world announces itself; Moolin answers, and from then on its
  // links can be hovered (the status bar says what they send) and clicked.
  await check("a Pueblo greeting is answered, and its links show their command and send it", async () => {
    if (!latestSocket) throw new Error("no server socket to write to");
    received = "";
    latestSocket.write('This world is Pueblo 1.0 Enhanced.\r\nExits: <a xch_cmd="north|n">north</a><br>\r\n');
    await waitFor("the Pueblo reply", () => received.includes("PUEBLOCLIENT 2.01\r\n"), 3000);
    await waitFor("the link", () => main.evaluate("!!document.querySelector('#terminal .link')"), 3000);
    const status = () => main.evaluate("document.getElementById('status-text').textContent");
    const before = await status();
    const point = await main.textPoint("Exits:", 8, "middle");
    await main.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await waitFor("the link's command in the status bar", async () => (await status()) === "Send: north | n", 2000);
    received = "";
    await main.clickAt(point, 1);
    await waitFor("the command", () => received === "north\r\n", 2000);
    await main.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await main.textPoint("Exits:", 0, "middle")) });
    await waitFor("the status to return", async () => (await status()) === before, 2000);
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
  // doesn't cancel the key. The key is sent to the scrollback itself, where a
  // click leaves focus.
  await check("the scrollback never swallows menu shortcuts like Ctrl+O", async () => {
    for (const page of [main, second]) {
      const cancelled = await page.evaluate(`(() => {
        const event = new KeyboardEvent("keydown", { key: "o", code: "KeyO", ctrlKey: true, bubbles: true, cancelable: true });
        document.getElementById("terminal").dispatchEvent(event);
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
