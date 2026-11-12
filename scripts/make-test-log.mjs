// Makes a large session log to try scrolling and searching on, from a book
// (War and Peace, from Project Gutenberg, by default) dressed up as MU*
// output: lines wrapped at 78 columns, some of them speech, poses and channel
// chatter in colour, a few of Moolin's own status lines, and an arrival time
// for each line spread over months. The book is repeated until the log is as
// big as asked.
//
//   node scripts/make-test-log.mjs --out=FILE [options]
//   node scripts/make-test-log.mjs --try [options]
//
//   --out=FILE      Write the log here.
//   --try           Write it into a throwaway sandbox and open Moolin on it
//                   (run `npm run build` first; `npm run try-log` does), with a
//                   local server to connect to: choose "Test Log" in the Worlds
//                   dialog. The sandbox is deleted when Moolin quits.
//   --size=MB       How big a log to make (default 50).
//   --needles=N     Lines with the word "wyvern" in, spread evenly through the
//                   log, for a search that's rare (default 25). War and Peace
//                   never says it, so a search for it finds exactly these.
//   --source=FILE   The text to use instead of War and Peace. Without it, the
//                   book is downloaded once into .cache/ (which git ignores).
//   --seed=N        Varies the dressing up (default 1); the same seed makes the
//                   same log.
//
// It writes the plain format (see src/log-format.ts). A Moolin with encryption
// on converts a plain log when it opens it, as it does any other.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const BOOK_URL = "https://www.gutenberg.org/cache/epub/2600/pg2600.txt";
const BOOK_CACHE = path.join(ROOT, ".cache", "war-and-peace.txt");
const WIDTH = 78;

function usage(message) {
  if (message) console.error(`make-test-log: ${message}`);
  console.error("usage: node scripts/make-test-log.mjs (--out=FILE | --try) [--size=MB] [--needles=N] [--source=FILE] [--seed=N]");
  process.exit(2);
}

const options = { size: 50, needles: 25, seed: 1, out: null, source: null, try: false };
for (const arg of process.argv.slice(2)) {
  const [, name, value] = /^--([a-z]+)(?:=(.*))?$/.exec(arg) ?? [];
  if (name === "try" && value === undefined) options.try = true;
  else if ((name === "out" || name === "source") && value) options[name] = path.resolve(value);
  else if ((name === "size" || name === "needles" || name === "seed") && value && Number(value) >= 0)
    options[name] = Number(value);
  else usage(`don't understand ${arg}`);
}
if (!options.out && !options.try) usage("say where to write the log (--out=FILE), or --try");
if (options.out && options.try) usage("--out and --try don't go together");

// --- The text -------------------------------------------------------------------

async function bookText() {
  if (options.source) return fs.readFileSync(options.source, "utf8");
  if (!fs.existsSync(BOOK_CACHE)) {
    console.log(`downloading War and Peace from ${BOOK_URL}`);
    const response = await fetch(BOOK_URL);
    if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
    fs.mkdirSync(path.dirname(BOOK_CACHE), { recursive: true });
    fs.writeFileSync(BOOK_CACHE, await response.text());
  }
  return fs.readFileSync(BOOK_CACHE, "utf8");
}

// The book's paragraphs, each as one string, without Project Gutenberg's header
// and licence, which aren't the book.
function paragraphs(text) {
  let body = text.replace(/\r\n?/g, "\n");
  const start = body.search(/^\*\*\* ?START OF.*\*\*\*$/m);
  if (start !== -1) body = body.slice(body.indexOf("\n", start) + 1);
  const end = body.search(/^\*\*\* ?END OF.*\*\*\*$/m);
  if (end !== -1) body = body.slice(0, end);
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
}

function wrap(text, width = WIDTH) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

// --- Dressing it up as MU* output -------------------------------------------------

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

const ESC = "\x1b[";
const PEOPLE = ["Pierre", "Natasha", "Andrei", "Marya", "Nikolai", "Sonya", "Helene", "Anatole", "Kutuzov", "Denisov"];
const CHANNELS = [
  ["Public", "1;34"],
  ["OOC", "1;35"],
  ["Newbie", "1;32"],
];
const PLACES = ["The Rostovs' Drawing Room", "A Muddy Road Near Austerlitz", "The Bald Hills Estate", "A Moscow Ballroom"];

// One paragraph as what a server might send: a list of lines, without line ends.
function dressUp(paragraph, rand) {
  const roll = rand();
  const person = PEOPLE[Math.floor(rand() * PEOPLE.length)];
  if (roll < 0.12) {
    const [channel, colour] = CHANNELS[Math.floor(rand() * CHANNELS.length)];
    const tag = `[${channel}] ${person}: `;
    return wrap(tag + paragraph).map((line, i) =>
      i === 0 ? `${ESC}${colour}m[${channel}]${ESC}0m ${ESC}1m${person}${ESC}0m: ${line.slice(tag.length)}` : line,
    );
  }
  if (roll < 0.3) return wrap(`${person} says, "${paragraph}"`).map((line) => `${ESC}36m${line}${ESC}0m`);
  if (roll < 0.4) return wrap(`${person} ${paragraph.charAt(0).toLowerCase()}${paragraph.slice(1)}`);
  if (roll < 0.43) {
    const place = PLACES[Math.floor(rand() * PLACES.length)];
    return [`${ESC}1;33m${place}${ESC}0m`, ...wrap(paragraph), `${ESC}32mObvious exits: north, south, door${ESC}0m`];
  }
  return wrap(paragraph);
}

// --- Writing the log ----------------------------------------------------------------

// A record of the plain log format: its number, then base64 of the data's
// length (uint32 LE), the data, and a float64 LE time per line feed (NaN for
// none). See encodeRecord in src/log-format.ts.
function record(seq, data, times) {
  const body = Buffer.alloc(4 + data.length + 8 * times.length);
  body.writeUInt32LE(data.length, 0);
  data.copy(body, 4);
  times.forEach((time, i) => body.writeDoubleLE(time ?? Number.NaN, 4 + data.length + 8 * i));
  return `${seq} ${body.toString("base64")}\n`;
}

async function writeLog(file) {
  const book = paragraphs(await bookText());
  if (book.length === 0) throw new Error("the text has no paragraphs");
  const rand = random(options.seed);
  const target = options.size * 1024 * 1024;
  const fd = fs.openSync(file, "w", 0o600);
  let size = 0;
  let pending = [];
  let pendingBytes = 0;
  const flush = () => {
    fs.writeSync(fd, pending.join(""));
    pending = [];
    pendingBytes = 0;
  };
  const write = (text) => {
    pending.push(text);
    pendingBytes += text.length;
    size += text.length;
    if (pendingBytes > 4 * 1024 * 1024) flush();
  };
  write("MOOLIN-LOG 1 plain\n");
  let seq = 0;
  let time = Date.UTC(2023, 0, 1, 19, 0, 0);
  let lines = 0;
  let needles = 0;
  // The size at which the next needle goes in.
  const needleAt = (n) => ((n + 0.5) / options.needles) * target;
  const add = (texts, when) => {
    const data = Buffer.from(texts.map((text) => `${text}\r\n`).join(""), "utf8");
    write(record(seq++, data, texts.map(() => when)));
    lines += texts.length;
  };
  for (let pass = 1; size < target; pass++) {
    // Each pass through the book is a session of its own.
    time += 20 * 3600 * 1000;
    add([`${ESC}33m[connected to Test Log, pass ${pass} through the book]${ESC}0m`], null);
    for (let i = 0; i < book.length && size < target; i++) {
      time += Math.floor(1000 + rand() * 20000);
      // An evening's play, then a gap until the next.
      if (rand() < 0.002) time += Math.floor((10 + rand() * 30) * 3600 * 1000);
      add(dressUp(book[i], rand), time);
      if (needles < options.needles && size >= needleAt(needles)) {
        needles++;
        add([`${ESC}1;31mA wyvern circles high overhead, then is gone. (needle ${needles} of ${options.needles})${ESC}0m`], time);
      }
    }
  }
  flush();
  fs.closeSync(fd);
  console.log(
    `wrote ${file}: ${(size / 1024 / 1024).toFixed(1)} MB, ${seq} records, ${lines} lines, ${needles} wyverns`,
  );
}

// --- Trying it ------------------------------------------------------------------------

async function tryLog() {
  const electron = createRequire(import.meta.url)("electron");
  if (!fs.existsSync(path.join(ROOT, "dist", "main.js"))) usage("no build in dist/; run `npm run try-log`, which builds first");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moolin-try-"));
  try {
    const configDir = path.join(sandbox, "config");
    const documentsDir = path.join(sandbox, "Documents");
    fs.mkdirSync(configDir);
    fs.mkdirSync(documentsDir);

    // A server that greets each connection and says back whatever it's sent.
    const server = net.createServer((socket) => {
      socket.write("Welcome to the test log world. Whatever you type is said back.\r\n");
      let input = "";
      socket.on("data", (data) => {
        input += data.toString("utf8");
        for (let end = input.indexOf("\n"); end !== -1; end = input.indexOf("\n")) {
          const line = input.slice(0, end).replace(/\r$/, "");
          input = input.slice(end + 1);
          if (line !== "") socket.write(`You say, "${line}"\r\n`);
        }
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const world = {
      id: "testlog0-world",
      name: "Test Log",
      host: "127.0.0.1",
      port: server.address().port,
      tls: false,
      tlsAllowUntrusted: false,
      autoLogin: false,
      echoCommands: "inherit",
      wordWrap: "inherit",
      honorClear: "inherit",
      characters: [{ id: "reader00-char", name: "Reader", echoCommands: "inherit", wordWrap: "inherit", honorClear: "inherit" }],
    };
    const worldsFile = path.join(sandbox, "worlds");
    fs.writeFileSync(worldsFile, JSON.stringify({ worlds: [world] }, null, 2));
    // Where Moolin keeps this world and character's log (see logPathFor in
    // src/session-log.ts): a folder per world and character, named by the
    // first 8 letters and digits of its id, a dot, and its name.
    const logFile = path.join(documentsDir, "Moolin", "testlog0.Test Log", "reader00.Reader", "moolin.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    await writeLog(logFile);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform === "linux") {
      fs.writeFileSync(path.join(configDir, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${documentsDir}"\n`);
      env.XDG_CONFIG_HOME = configDir;
    } else {
      env.MOOLIN_CONFIG_DIR = configDir;
      env.MOOLIN_DOCUMENTS_DIR = documentsDir;
    }
    console.log('opening Moolin: in the Worlds dialog, connect to "Test Log" as Reader; quit Moolin to finish');
    const app = spawn(electron, [ROOT, worldsFile], { env, stdio: "inherit" });
    await new Promise((resolve) => app.on("exit", resolve));
    server.close();
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (options.try) await tryLog();
else await writeLog(options.out);
