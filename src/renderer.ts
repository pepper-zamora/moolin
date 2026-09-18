import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

const term = new Terminal({
  scrollback: 100000,
  convertEol: true,
  fontFamily: "Menlo, Consolas, monospace",
  fontSize: 14,
  theme: {
    background: "#000000",
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const container = document.getElementById("terminal");
if (!container) throw new Error("missing #terminal container");
term.open(container);

try {
  term.loadAddon(new WebglAddon());
} catch {
  // Falls back to the default canvas renderer if WebGL is unavailable.
}

fitAddon.fit();
window.addEventListener("resize", () => fitAddon.fit());

term.writeln("\x1b[36mmoolin skeleton — connected to nothing yet.\x1b[0m");
term.writeln("Type below (local echo only, no connection wired up).");
for (let i = 1; i <= 500; i++) {
  term.writeln(`\x1b[90m[${i}]\x1b[0m filler scrollback line for testing scroll feel.`);
}

term.onData((data) => {
  if (data === "\r") {
    term.write("\r\n");
  } else if (data === "\x7f" || data === "\b") {
    term.write("\b \b");
  } else {
    term.write(data);
  }
});
