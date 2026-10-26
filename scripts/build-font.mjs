// Builds Moolin's bundled default font, Iosevka Moolin, from
// font/private-build-plans.toml. Not part of `npm run build`: Iosevka's own
// build toolchain (the full be5invis/Iosevka repo, its own large npm
// dependency tree) is much heavier than anything else this project needs,
// and nothing else here requires network access or takes more than a few
// seconds, so it stays a separate, manual step instead of slowing down (or
// adding a new failure mode to) every build and CI run.
//
// Clones Iosevka (shallow) into font/.iosevka-src/ the first time, reusing
// it on later runs (`npm install` is skippable once node_modules exists,
// but is re-run anyway so a Moolin update that bumps the Iosevka version
// doesn't silently build against stale dependencies). Set IOSEVKA_SRC to
// point at a checkout of your own instead.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const FONT_DIR = path.join(ROOT, "font");
const PLAN_NAME = "IosevkaMoolin";
const FACES = ["Regular", "Bold", "Italic", "BoldItalic"];

const iosevkaSrc = process.env.IOSEVKA_SRC ? path.resolve(process.env.IOSEVKA_SRC) : path.join(FONT_DIR, ".iosevka-src");

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

if (!fs.existsSync(iosevkaSrc)) {
  console.log(`Cloning Iosevka into ${iosevkaSrc} (first run only; this takes a minute)...`);
  run("git", ["clone", "--depth", "1", "https://github.com/be5invis/Iosevka.git", iosevkaSrc]);
} else {
  console.log(`Reusing the existing Iosevka checkout at ${iosevkaSrc}.`);
}

console.log("Installing Iosevka's own build dependencies (its tree, not Moolin's)...");
run("npm", ["install"], { cwd: iosevkaSrc });

fs.copyFileSync(path.join(FONT_DIR, "private-build-plans.toml"), path.join(iosevkaSrc, "private-build-plans.toml"));

// Unhinted: ttfautohint is a native tool this project otherwise has no
// reason to require, and hinting mainly matters for legacy low-DPI
// rendering that a modern desktop app's font doesn't need to worry about.
console.log(`Building the "${PLAN_NAME}" plan (this is the slow part)...`);
run("npm", ["run", "build", "--", `ttf-unhinted::${PLAN_NAME}`], { cwd: iosevkaSrc });

const builtDir = path.join(iosevkaSrc, "dist", PLAN_NAME, "TTF-Unhinted");
for (const face of FACES) {
  const from = path.join(builtDir, `${PLAN_NAME}-${face}.ttf`);
  const to = path.join(FONT_DIR, `${PLAN_NAME}-${face}.ttf`);
  fs.copyFileSync(from, to);
  console.log(`Updated ${path.relative(ROOT, to)}`);
}

// Required by the SIL Open Font License the font ships under: redistributing
// it (even a custom build) means redistributing its license text too.
fs.copyFileSync(path.join(iosevkaSrc, "LICENSE.md"), path.join(FONT_DIR, "LICENSE-IosevkaMoolin.md"));

console.log("\nDone. Run `npm run build` (or `npm start`) to bundle the updated font.");
