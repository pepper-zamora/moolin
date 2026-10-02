// Launch Electron with ELECTRON_RUN_AS_NODE cleared. VS Code sets it in its
// integrated terminal, which makes Electron behave as plain Node.
const { spawn } = require("node:child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("close", (code) => process.exit(code ?? 0));
