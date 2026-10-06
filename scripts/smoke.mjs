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
// client on demand (see the word-wrap check below).
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

  // The on-screen rect of one currently-visible row (0 = top of viewport),
  // via xterm's accessibility tree — a hidden, full-size DOM mirror of the
  // rendered rows it maintains for screen readers (one real <div> per
  // viewport row, kept in sync with rendering regardless of which renderer,
  // canvas/WebGL/DOM, is actually drawing the visible terminal). Reading
  // real rendered text and real screen coordinates from it, rather than
  // reaching into xterm's internal buffer API, keeps this a true black-box
  // "drive it like a user would" check.
  async rowRect(viewportRow) {
    return this.evaluate(
      `document.querySelectorAll("#terminal .xterm-accessibility-tree > div")[${viewportRow}]?.getBoundingClientRect().toJSON()`,
    );
  }

  async allRowTexts() {
    return this.evaluate(
      `Array.from(document.querySelectorAll("#terminal .xterm-accessibility-tree > div")).map((d) => d.textContent)`,
    );
  }

  async rowText(viewportRow) {
    return (await this.allRowTexts())[viewportRow] ?? "";
  }

  // The viewport row index (0 = top) of the first currently-visible row whose
  // text starts with `prefix`, or -1 if none does.
  async findVisibleRow(prefix) {
    return (await this.allRowTexts()).findIndex((t) => t.startsWith(prefix));
  }

  // A point at (row, col) in screen pixels, using the full terminal screen's
  // rect (not just one row's, which is only as wide as its own text) so a
  // column past a short row's rendered content still resolves to a real
  // on-screen x; the row's own rect still supplies y, since accessibility
  // rows don't all share the screen rect's full height.
  async cellPoint(row, col, cols) {
    const rowRect = await this.rowRect(row);
    const screenRect = await this.evaluate(
      `document.querySelector("#terminal .xterm-screen").getBoundingClientRect().toJSON()`,
    );
    const cellWidth = screenRect.width / cols;
    return { x: screenRect.x + col * cellWidth + cellWidth / 2, y: rowRect.y + rowRect.height / 2 };
  }

  // Drags a selection spanning `length` characters starting at column
  // `startCol` of viewport row `startRow`, wrapping to subsequent rows past
  // `cols` columns — the same linear-range semantics as xterm's own
  // term.select(col, row, length), driven here via real mouse events instead
  // of that internal API. `cols` comes from the status bar's own #screen-size
  // text (real rendered UI, not an internal reached into for the test).
  async dragSelectRange(startRow, startCol, length, cols) {
    const startPoint = await this.cellPoint(startRow, startCol, cols);
    const endIndex = startCol + length;
    const endRow = startRow + Math.floor(endIndex / cols);
    const endCol = endIndex % cols;
    const endPoint = await this.cellPoint(endRow, endCol, cols);
    await this.mouse("mousePressed", startPoint);
    const steps = Math.max(5, (endRow - startRow + 1) * 5);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", {
        x: startPoint.x + ((endPoint.x - startPoint.x) * i) / steps,
        y: startPoint.y + ((endPoint.y - startPoint.y) * i) / steps,
      });
      await sleep(10);
    }
    await this.mouse("mouseReleased", endPoint);
    await sleep(150);
  }

  // Drags from just inside the scrollback's top-left corner to just inside
  // its bottom-right, selecting every row currently visible — used instead
  // of Select All (Ctrl+A), which only ever reaches the renderer through a
  // real Electron menu click, not reproducible over CDP alone. Many small
  // mousemove steps, not a single jump to the end point: xterm's selection
  // tracking extends row by row as the mouse crosses each one, so a coarse
  // drag (too few intermediate points) can under-select past wherever the
  // last step happened to land.
  async selectAllVisible() {
    const rect = await this.evaluate(
      `(() => { const r = document.querySelector("#terminal .xterm-screen").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const from = { x: rect.x + 2, y: rect.y + 2 };
    const to = { x: rect.x + rect.width - 2, y: rect.y + rect.height - 2 };
    const steps = 30;
    await this.mouse("mousePressed", from);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await sleep(10); // a real frame between steps, not just rapid-fire events
    }
    await this.mouse("mouseReleased", to);
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
  // --screen-reader-mode enables xterm's accessibility tree (a hidden DOM
  // mirror of rendered rows — see src/global.d.ts), which the word-wrap copy
  // checks below use to read rendered text and real screen coordinates
  // without reaching into xterm's internal buffer/selection API.
  launch("--remote-debugging-port=0", "--screen-reader-mode");
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
      // wordWrap is forced on here (rather than just for its own check,
      // below) so that check can reuse this same connection instead of
      // opening a second window mid-run — word wrap only affects how
      // server output is displayed, so it doesn't interfere with any of
      // the other checks that share this connection.
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

  await check("double-clicking the scrollback leaves typing in the input area", async () => {
    await main.doubleClickScrollback();
    expectEqual(await main.activeElement(), "input-area", "focus after the double-click");
    await typingReachesServer(main, "after double-click");
  });

  // The concrete regression tests for word wrap's copy guarantee: a line
  // from the server must copy back out as EXACTLY the line it sent — not
  // just "no inserted newline" (xterm's own isWrapped row-joining already
  // gave us that for free), but no extra whitespace either. Word wrap pads a
  // row with spaces to trigger xterm's own wrap at a word boundary (see
  // word-wrap.ts); getWrapAwareSelection (src/renderer.ts) is what keeps
  // those padding spaces out of a copy by substituting the original raw line
  // instead of xterm's padded display text — but ONLY when the selection
  // itself actually crosses a wrap boundary; a selection confined to one
  // visual row (even one that's part of a longer wrapped paragraph, e.g.
  // double-clicking a single word) must still copy precisely, not the whole
  // paragraph. The line below is built long enough (several "words" with no
  // real line anywhere near this wide) to wrap at least twice on any
  // reasonable window width, so all of these cases are actually exercised.
  //
  // Selection is driven via real mouse events against xterm's accessibility
  // tree (a hidden DOM mirror of the rendered rows — see Page#rowRect),
  // never by reaching into xterm's internal buffer/selection API, so this
  // stays a true "drive it like a user would" check.
  const cols = Number((await main.evaluate("document.getElementById('screen-size').textContent")).split("x")[0]);
  let wrapRow;
  const longLine = Array.from({ length: 15 }, (_, i) => `wordNumber${i}IsDeliberatelyLong`).join(" ");
  await check("a word-wrapped long line copies back as exactly one line, with no padding", async () => {
    if (!latestSocket) throw new Error("no server socket to write the long line to");
    if (cols >= longLine.length) throw new Error(`test window too wide (cols=${cols}) for this line to wrap`);
    latestSocket.write(`${longLine}\r\n`);
    // xterm's accessibility tree (see Page#rowRect) lags noticeably behind
    // actual rendering -- 300ms (enough for the write/wrap itself) isn't
    // enough for its own text mirror to catch up, confirmed empirically.
    await sleep(1500);

    wrapRow = await main.findVisibleRow("wordNumber0");
    if (wrapRow < 0) {
      throw new Error(`couldn't find the long line in the viewport; rows were ${JSON.stringify(await main.allRowTexts())}`);
    }

    await main.dragSelectRange(wrapRow, 0, longLine.length, cols);
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, longLine, "clipboard after copying the whole wrapped line");
  });

  // The user-visible tradeoff behind the fix above, made explicit (see
  // CHANGELOG.md): since a selection that crosses a wrap boundary
  // substitutes the whole ORIGINAL line rather than splicing a sub-range out
  // of it, selecting only part of a wrapped paragraph — as long as that part
  // still straddles the actual wrap point — copies that paragraph's whole
  // original line, never a truncated or padded fragment of it. The range
  // below deliberately straddles the exact column where word wrap pads: 5
  // characters before the row ends, 5 into the next one.
  await check("a selection crossing the wrap point still copies the whole original line", async () => {
    await main.dragSelectRange(wrapRow, cols - 5, 10, cols);
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, longLine, "clipboard after copying across the wrap point");
  });

  // The flip side, and the reason the fix above has to check what the
  // SELECTION spans, not just what paragraph it's part of: a selection
  // confined to one visual row of a wrapped paragraph — nowhere near the
  // wrap point — never touches any padding, so it must still copy exactly
  // the selected text, not the whole paragraph.
  await check("a selection confined to one row of a wrapped paragraph copies precisely, not the whole paragraph", async () => {
    await main.dragSelectRange(wrapRow, 0, 10, cols); // "wordNumber" — well short of the wrap point
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, longLine.slice(0, 10), "clipboard after a single-row selection within a wrapped paragraph");
  });

  // The real-world version of the same case: double-clicking a word inside a
  // wrapped paragraph must copy just that word. Word wrap guarantees a word
  // is never itself split across the wrap (that's its whole purpose), so
  // this is always a single-row selection — double-clicking the second word
  // ("wordNumber1IsDeliberatelyLong", comfortably within the first visual
  // row) must never pull in the rest of the paragraph.
  await check("double-clicking a word inside a wrapped paragraph copies just that word", async () => {
    const rowText = await main.rowText(wrapRow);
    const wordCol = rowText.indexOf("wordNumber1");
    if (wordCol < 0) throw new Error(`"wordNumber1" not found on the wrapped line's first row: ${JSON.stringify(rowText)}`);
    const point = await main.cellPoint(wrapRow, wordCol + 5, cols); // well inside the word, not at its edge
    for (const clickCount of [1, 2]) {
      await main.mouse("mousePressed", point, clickCount);
      await main.mouse("mouseReleased", point, clickCount);
    }
    await sleep(150);
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, "wordNumber1IsDeliberatelyLong", "clipboard after double-clicking a word mid-paragraph");
  });

  // The third standard selection gesture (after drag and double-click-word):
  // triple-click to select a whole line. xterm treats a word-wrapped
  // paragraph's chained isWrapped rows as one "line" for this purpose, so
  // triple-clicking anywhere in it selects the whole paragraph in one
  // gesture — the most natural way a real user would select "this one line
  // of chat" to copy it, and worth its own check alongside the manual
  // full-paragraph drag above.
  await check("triple-clicking a wrapped paragraph selects and copies the whole original line", async () => {
    const point = await main.cellPoint(wrapRow, 5, cols);
    for (const clickCount of [1, 2, 3]) {
      await main.mouse("mousePressed", point, clickCount);
      await main.mouse("mouseReleased", point, clickCount);
    }
    await sleep(150);
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, longLine, "clipboard after triple-clicking the wrapped paragraph");
  });

  // Regression guard: an ordinary short line (never wrapped) must still copy
  // exactly the selected substring, unaffected by the wrap-aware path above.
  await check("a partial selection on a short, non-wrapped line is still copied precisely", async () => {
    if (!latestSocket) throw new Error("no server socket to write the short line to");
    latestSocket.write("short line\r\n");
    await sleep(1500); // see the accessibility-tree lag note above
    const shortRow = await main.findVisibleRow("short line");
    if (shortRow < 0) throw new Error("couldn't find the short line in the viewport");
    await main.dragSelectRange(shortRow, 0, 5, cols); // "short"
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, "short", "clipboard after copying part of an unwrapped line");
  });

  // Ordinary multi-line selection across separate (non-wrapped) lines must
  // still behave exactly like xterm's own default: the first and last lines
  // contribute only their selected portion, joined by "\n" — none of them
  // individually wrap, so getWrapAwareSelection's whole-paragraph
  // substitution never triggers here; this only exercises its single-row
  // extraction branch, once per touched line.
  await check("a selection spanning parts of two separate lines copies just the selected part of each", async () => {
    if (!latestSocket) throw new Error("no server socket to write to");
    latestSocket.write("alpha bravo charlie\r\n");
    latestSocket.write("delta echo foxtrot\r\n");
    await sleep(1500); // see the accessibility-tree lag note above
    const rowA = await main.findVisibleRow("alpha bravo");
    if (rowA < 0) throw new Error("couldn't find the first line in the viewport");

    // From column 6 of the first line ("bravo charlie", skipping "alpha ")
    // to column 5 of the next ("delta") — neither line's full text.
    await main.dragSelectRange(rowA, 6, cols + (5 - 6), cols);
    await main.key("c", "KeyC", 67, 2 /* Ctrl */);
    await sleep(150);
    const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
    expectEqual(clipboard, "bravo charlie\ndelta", "clipboard after spanning two partially-selected lines");
  });

  // Same shape, but with one COMPLETE line in between: that middle line must
  // come through in full (the ordinary "middle lines of a selection are
  // whole" rule xterm already applies), while the first and last still only
  // contribute their selected portion.
  await check(
    "a selection spanning two partial lines with a complete line between them copies all three correctly",
    async () => {
      if (!latestSocket) throw new Error("no server socket to write to");
      latestSocket.write("golf hotel india\r\n");
      latestSocket.write("juliet kilo lima\r\n");
      latestSocket.write("mike november oscar\r\n");
      await sleep(1500); // see the accessibility-tree lag note above
      const rowFirst = await main.findVisibleRow("golf hotel");
      if (rowFirst < 0) throw new Error("couldn't find the first line in the viewport");

      // From column 5 of the first line ("hotel india", skipping "golf ")
      // through the whole second line, to column 6 of the third ("mike n").
      await main.dragSelectRange(rowFirst, 5, 2 * cols + (6 - 5), cols);
      await main.key("c", "KeyC", 67, 2 /* Ctrl */);
      await sleep(150);
      const clipboard = await main.evaluate("window.moolin.clipboard.readText()");
      expectEqual(
        clipboard,
        "hotel india\njuliet kilo lima\nmike n",
        "clipboard after spanning two partial lines with a full line between them",
      );
    },
  );

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
