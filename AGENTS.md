# Agent instructions

Moolin is a MOO/MUSH/MUCK/MUD desktop client (Electron + xterm.js,
TypeScript), written by AI at the direction of Pepper, an experienced MU*
player who decides what it does and how it should feel. Every line of code
and docs so far has been written by an AI agent; that's expected to continue,
possibly across more than one vendor's agents, so keep this file accurate and
vendor-neutral rather than tool-specific.

Read [README.md](README.md) first — it's the canonical reference for
features, usage, the worlds file, preferences, command-line options, and the
full `npm run` command table and `src/` file-by-file layout. Don't duplicate
it here; if something here and the README disagree, fix whichever is wrong.

Three more docs are the project's living design/roadmap layer, not historical
notes — check them before assuming a feature or protocol is out of scope:

- [GAPS.md](GAPS.md) — feature gaps vs. established MU* clients (MUSHclient,
  Mudlet, TinTin++, Potato, Atlantis, Blightmud). Moolin has no scripting
  layer yet (triggers, aliases, variables, timers, macros, mapper, OOB
  protocols); this is the roadmap for that.
- [PROTOCOLS.md](PROTOCOLS.md) — how telnet option negotiation is
  implemented, and which MUD-specific protocols (GMCP, MSDP, MXP, MCCP, MSP)
  aren't yet and why they'd matter here.
- [SERVERS.md](SERVERS.md) — reference list of known MOO/MUSH/MUCK/MUD
  server codebases, for matching MSSP's `CODEBASE` field.

## Before committing

Run, and fix anything they flag:

```sh
npm run typecheck   # tsc --strict, no emit
npm run lint         # Biome; npm run lint:fix for safe autofixes
npm run format:check # Biome; npm run format to apply
npm test             # src/*.test.ts via Node's test runner
```

CI (`.github/workflows/release.yml`) only runs `npm test`, on Linux, and only
when packaging a release build — it does not typecheck or lint. Treat the
commands above as mandatory locally regardless; nothing else will catch a
type or style regression before review.

The TLS tests shell out to `openssl` to generate a throwaway certificate, so
it must be on `PATH`. If you touch anything under terminal rendering, the
Worlds dialog, or focus/keyboard handling, also run `npm run smoke` (Linux
and macOS; needs a real display, or `xvfb-run` on headless Linux) — it drives
a real packaged window over the Chrome DevTools Protocol and catches things
unit tests can't, such as focus ending up in the wrong element.

## Code style

Enforced by Biome (`biome.json`) and `tsconfig.json`, both authoritative over
anything paraphrased here: 2-space indent, double quotes, semicolons,
trailing commas, 120-column lines, strict TypeScript. `noUnusedVariables` and
`noUnusedImports` are errors, not warnings. Match the style of the file
you're editing — comment density, naming, and idiom — over introducing a new
one.

## Commit messages

Match the existing log (`git log --oneline`): a short imperative sentence
describing *what changed*, sentence case, no trailing period, no type
prefix (no `feat:`, `fix:`, etc.), e.g. "Add scrollback search" or "Fix
bugs found in review, and add the missing tests". Don't invent a different
convention partway through the history.

## Scope discipline

This codebase was built up deliberately and incrementally, with docs kept in
lockstep with behavior (see the git history: doc updates ride along with the
feature that prompted them, not as separate catch-up commits). Keep that
habit: when you change behavior, update README.md/GAPS.md/PROTOCOLS.md in the
same change if they describe the old behavior, and prefer small, reviewable
commits over sweeping ones.
