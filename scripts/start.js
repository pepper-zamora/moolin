// Launch Electron with ELECTRON_RUN_AS_NODE cleared. VS Code sets it in its
// integrated terminal, which makes Electron behave as plain Node.
const { spawn } = require("node:child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// A snapped VS Code or VSCodium points GTK at the snap's own libraries and
// data, which crashes Electron's native Wayland window. Its terminal doesn't
// always keep SNAP set, but it does keep a *_VSCODE_SNAP_ORIG copy of each
// variable it overrode (empty if it was unset): put those back, and drop the
// remaining variables that only point inside a snap, such as XDG_DATA_HOME.
const ORIG = "_VSCODE_SNAP_ORIG";
if (Object.keys(env).some((key) => key.endsWith(ORIG))) {
  const inSnap = (path) => /\/snap\/[^/]+\/(\d+|current|common)(\/|$)/.test(path);
  const saved = {};
  for (const [key, value = ""] of Object.entries(env)) {
    if (key.endsWith(ORIG)) saved[key.slice(0, -ORIG.length)] = value;
    if (key.endsWith(ORIG) || key.startsWith("SNAP") || (value && value.split(":").every(inSnap))) {
      delete env[key];
    }
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value) env[key] = value;
    else delete env[key];
  }
}

const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("close", (code) => process.exit(code ?? 0));
