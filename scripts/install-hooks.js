// Point git at the committed hooks in .githooks/ (run by npm's prepare step).
// Git never enables hooks from a clone on its own. Outside a git checkout,
// such as an unpacked source archive, there's nothing to set, so do nothing.
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
if (existsSync(path.join(root, ".git"))) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
  } catch {
    // git isn't installed; the hooks just stay off.
  }
}
