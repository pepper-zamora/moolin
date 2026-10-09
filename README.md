# Moolin

A cross-platform MOO / MUSH / MUD client written by AI to Pepper's personal
tastes. When this repository was first published, every line of its code and
documentation had been written by AI (Anthropic's Claude), at the direction of
Pepper, an experienced player on social servers such as LambdaMOO, who decided
what it should do and how it should feel to use.

A desktop client for MOOs, MUSHes, MUCKs and MUDs, with buttery-smooth
scrollback. Built on Electron, with its own DOM-based scrollback, for Linux,
Windows and macOS.

Moolin merges two earlier clients: moolin v1, which this repository's history
continues, and an older, parallel project, which contributed its
one-window-per-connection design, its worlds-and-characters model and dialog,
and its input/focus behavior.

## Installing

Download a build from the
[Releases](https://github.com/pepper-zamora/moolin/releases) page:

| System  | File                                                                 |
| ------- | -------------------------------------------------------------------- |
| Linux   | `.AppImage` (any distribution), `.deb`, `.rpm` or `.pacman`          |
| Windows | `-setup-x64.exe` (installer) or `-portable-x64.exe` (no install)     |
| macOS   | `-mac-arm64.dmg` (Apple silicon) or `-mac-x64.dmg` (Intel)           |

The Windows and macOS builds aren't signed, so each system warns about them
the first time.

**Windows:** SmartScreen says it "protected your PC". Click **More info**, then
**Run anyway**.

**macOS:** open the `.dmg` and drag Moolin to Applications. Gatekeeper blocks
the first launch because the app isn't from an identified developer. To allow
it, once:

- **macOS 15 (Sequoia) and later:** open Moolin, and click **Done** when macOS
  says it can't be opened. Then open **System Settings → Privacy & Security**,
  scroll down to the message that Moolin was blocked, click **Open Anyway**,
  and confirm with your password.
- **macOS 14 and earlier:** in Applications, Control-click Moolin, choose
  **Open**, then click **Open** in the dialog.

After that it opens normally. If macOS instead says Moolin "is damaged and
can't be opened", that's the quarantine flag macOS puts on downloads, not real
damage; clear it in Terminal, then open Moolin again:

```sh
xattr -dr com.apple.quarantine /Applications/Moolin.app
```

### The update check

Moolin doesn't update itself. Instead, every time it starts it asks GitHub
whether a newer release has been published, and if one has, it says so and
offers to open the release's page. That's all the check is for: to make sure
you hear about new releases, including one that replaces a release withdrawn
for a serious bug.

The check contacts only GitHub (`api.github.com`), and it isn't used for
tracking in any way. The request carries nothing about you, your worlds or
your settings, not even which version of Moolin you have; the comparison
happens on your computer. GitHub, like any website, sees the IP address the
request comes from, under [GitHub's privacy
statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

To turn the check off, uncheck **Help → Check for Updates at Startup**. You can
still check by hand any time with **Help → Check for Updates…**. Builds run
from source never check at startup.

## Features

- **One window per connection.** Connecting from a window that already has a
  connection opens the new one in a window of its own. All windows run in one
  process; launching Moolin again just opens another window. A freshly
  opened window (not one opened this way, which instead cascades from the
  window it came from) sizes itself to show 80x25 characters at its starting
  font, centered on screen; if that wouldn't fit the screen, it falls back to
  75% of it instead.
- **Worlds and characters.** Save worlds (host, port, TLS) and the characters
  you play on each, then connect to a world, or to a world as a character.
- **Word wrap.** Off by default; turn it on in the Worlds dialog's Global
  Settings tab (with a World or Character able to override it) to wrap long
  server lines at word boundaries instead of at the last column, mid-word.
  See [Word wrap](#word-wrap) below.
- **Auto-login.** Connecting as a character can send a login command built
  from a per-world template, e.g. `co "{{character}}" {{password}}\r`. It is
  sent once the server has sent something first (its welcome), so a server
  that says nothing until it is spoken to won't get it.
- **TLS, explicitly.** Each world either uses TLS or doesn't; Moolin never
  guesses, so a connection can't be silently downgraded. Certificates are
  verified unless the world opts into accepting untrusted (e.g. self-signed)
  ones. A shield at the right of the status bar shows the connection's
  security: green with a check for TLS with a trusted certificate, yellow
  with a question mark for an untrusted certificate the world accepts, red
  with a cross for plaintext. Hover over it for the protocol, cipher, key
  exchange and the certificate chain's details.
- **Scrollback that survives a reload.** 20,000 lines, with clickable URLs.
  The main process keeps the last 2 MiB of each window's output, so reloading
  the window (Ctrl+R, Cmd+R on macOS) or a renderer crash doesn't lose it.
- **Pueblo.** On a world that speaks it, links are clickable (right-click
  one with several commands to choose), and the status bar shows what a link
  will send or open while the pointer is on it. See
  [PROTOCOLS.md](PROTOCOLS.md#pueblo).
- **Persistent logs.** Everything a window shows, colors included, is appended
  to `~/Documents/Moolin/<world>/<character>/moolin.log` (just `<world>/` when
  connecting without a character). Each folder's name starts with 8
  characters of the world's or character's id, as in
  `3f2a9c1e.LambdaMOO/7b0d44aa.Cowpernica/`, so worlds with the same name (or
  names differing only in case) get folders of their own, and renaming a
  world or character renames its folder to match. Folders from before the
  ids were added are renamed the first time their world or character
  connects. Connecting pre-populates the scrollback with the last 2 MiB of
  the log. A log belongs to one window at a time: the first window to
  connect to a world and character reads and writes it until it
  disconnects (its last line is the "disconnected" one), and other windows
  connected meanwhile don't log. The status bar shows which: a scroll beside
  the security shield when the window is logging, a red "no" sign when
  another window has the log. The log grows without bound for now, as does
  the `moolin.log.times` file beside it (see timestamps, below); delete or
  prune the two together. While a window has the log open there's also a
  small `moolin.log.open` file beside it, which lets Moolin repair the
  timestamps if it crashes.
- **Line timestamps.** View > Show Timestamps adds a gutter showing when each
  line from the server arrived, with the date wherever the day changes. The
  times are display-only: they never appear in copied text or in the log,
  and are kept in `moolin.log.times` so logged history keeps its times on
  reconnect. The last setting chosen is remembered for new windows (see
  [Preferences](#preferences)).
- **Scrollback search.** Edit > Find (Ctrl+F, Cmd+F on macOS) opens a find box at the top
  right of the window, with match-case, whole-word and regular-expression
  toggles. Every match is highlighted, and marked beside the scrollbar, and
  the matches update as new output arrives (the newest 1,000 are kept).
- **Telnet negotiation** of ECHO (no local echo during password prompts),
  NAWS (window size), TTYPE and SGA; every other option is refused.
- **Multi-line input** that grows as you type, with shell-like history and its
  own undo/redo (coalesced typing, and atomic steps for cut/paste).
- **Cut, copy and paste** that work against either the scrollback selection or
  the input area, whichever was selected last.
- **Recent connections** on the Worlds menu, Ctrl+1 to Ctrl+5 (Cmd on macOS).

## Getting started

Requires Node.js 22 or later.

```sh
npm install
node node_modules/electron/install.js   # downloads the Electron binary
npm start          # builds into dist/, then launches
```

Electron no longer downloads its binary during `npm install`, hence the
second step. On Linux, if Electron aborts at launch complaining about the SUID
sandbox helper, make it root-owned (this must be redone whenever Electron is
reinstalled):

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

`npm start` runs `scripts/start.js`, which clears `ELECTRON_RUN_AS_NODE`
(set by VS Code's integrated terminal, where it would make Electron behave as
plain Node).

To launch from a desktop menu on Linux, build once with `npm run build`, then
copy `moolin.desktop` to `~/.local/share/applications/`. Its paths point at
`/home/YOUR_USERNAME/Projects/moolin`; edit them if the checkout lives elsewhere.

## Packaging

Installers are built with [electron-builder](https://www.electron.build/)
(`electron-builder.yml`); output goes to `release/`.

```sh
npm run pack         # unpacked app only, for a quick check
npm run dist:linux   # AppImage, deb, rpm, pacman
npm run dist:win     # NSIS installer and portable exe
npm run dist:mac     # dmg and zip, x64 and arm64
```

Each target has to be built on its own OS; `.github/workflows/release.yml`
does that on every `v*` tag and attaches the results to a GitHub Release. It
also builds and tests every push to `dev` and every pull request into `dev` or
`main` on all three OSes, without releasing anything; the installers are kept
as the run's artifacts. The rpm and pacman targets need `rpmbuild` and `bsdtar` installed. Windows builds
are unsigned, and so are macOS builds unless the signing secrets named in the
workflow are set. `packaging/aur/PKGBUILD` is a draft for an AUR `moolin-bin` package.

### Versioning

Moolin follows [semantic versioning](https://semver.org/), with the usual
convention before 1.0: the middle number goes up for a breaking change, and
the last number for everything else. A change is breaking if it stops
something existing users rely on from working, for example:

- the worlds file or `preferences.json` changes so an older Moolin can't read
  it, or a newer one stops reading older files
- a command-line option, keyboard shortcut or menu command is removed or
  changes meaning
- a feature is removed, or a default changes in a way people would notice as
  broken
- the minimum supported OS or architecture rises, or a package format is
  dropped

New features and fixes that keep everything working only raise the last
number (0.1.0, 0.1.1, ...). `package.json` holds the version of the next
release; after a release it's bumped right away, and a release's tag
(`v0.1.1`) must match it. [CHANGELOG.md](CHANGELOG.md) lists what changed in
each release, and what's changed since the last one.

## Using Moolin

The first time Moolin runs (no worlds file yet — see below), it starts with
one world already set up: LambdaMOO, with a Guest character, ready to
connect to. Deleting it is permanent, the same as deleting anything else you
add.

Press **Ctrl+O** (**Cmd+O** on macOS) to open the Worlds dialog. Its tree has a **Global** root,
with each world (globe icon) under it and each world's characters (silhouette
icon) under that. **New World** adds a world; fill in its host and port. With
a world or one of its characters selected, **New Character** adds a character
to that world (as does right-clicking a world, or Shift+F10). Select a world
or character and press **Connect** (or Enter, or double-click).

The selected item's details are in tabs to the right of the tree; for now
there is just **Settings**, with more (such as triggers) to come. When the
tabs don't fit on one row, ‹ › buttons at the right end scroll through them.

Global's Settings tab holds two app-wide defaults — **Wrap long lines at
word boundaries** and **Echo typed commands into the scrollback** — that a
World or a Character can each override: their own Settings tab offers
**Inherit** (use whatever the level above resolves to), **On** or **Off** for
both. Character wins over World wins over Global. Word-wrap wraps long
server lines at word boundaries instead of mid-word — see
[Word wrap](#word-wrap) below.

A connection keeps the settings its world and character had when it
connected: changes saved in the Worlds dialog, including these two cascading
settings and the world's name, apply to windows already connected to that
world only once they reconnect.

Type commands in the input area at the bottom; the scrollback above is output
only. The status bar below the input area shows what the window is connected
to, plus the terminal's current size in characters (e.g. `80x25`); the input
area is disabled while it isn't connected.

### Auto-login templates

When **Log in characters automatically** is on, connecting as a character
sends the world's login command once connected. In the template:

| Text            | Becomes                  |
| --------------- | ------------------------ |
| `{{character}}` | the character's name     |
| `{{password}}`  | the character's password |
| `\r`            | a carriage return        |
| `\n`            | a line feed              |
| `\\`            | a backslash              |

Nothing else is added, so end the template with `\r` (most servers) or
`\r\n`. The default is `co "{{character}}" {{password}}\r`.

### Word wrap

By default a line that's too long for the window wraps at the last column,
mid-word if that's where it lands, as a terminal does. Turning word wrap on
(Global, World or Character — see [Using Moolin](#using-moolin) above)
wraps at the last word boundary that fits instead. Either way it's only how
the line is shown: it is still one line, so selecting and copying it gives
back exactly the text you selected, and resizing the window re-wraps
everything at once.

### Keyboard shortcuts

On macOS, use Cmd in place of Ctrl in all the shortcuts below.

| Keys                     | Action                                                  |
| ------------------------ | ------------------------------------------------------- |
| Ctrl+O                   | Open the Worlds dialog                                  |
| Ctrl+N                   | New world                                               |
| Ctrl+K                   | Disconnect (asks first)                                 |
| Ctrl+W                   | Close the window                                        |
| Ctrl+,                   | Open the Preferences dialog                             |
| Ctrl+1 … Ctrl+5          | Connect to a recent world or character                  |
| Enter / Shift+Enter      | Send / insert a newline                                 |
| Up / Down                | Previous / next command, from the first / last line     |
| Ctrl+Up / Ctrl+Down      | Previous / next command, from anywhere                  |
| Page Up / Page Down      | Scroll the scrollback                                   |
| Ctrl+L                   | Clear the screen (earlier output stays scrollable)      |
| Ctrl+F                   | Find in the scrollback                                  |
| F3 / Shift+F3            | Next / previous match                                   |
| Ctrl+A                   | Select all of the input line, or of the scrollback if something there is selected |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy the selection / paste into the input area    |
| Ctrl+Z                   | Undo in the input area                                  |
| Ctrl+Shift+Z / Ctrl+Y    | Redo in the input area (Ctrl+Y only on Windows/Linux)   |
| Ctrl+= / Ctrl+- / Ctrl+0 | Larger / smaller / default font size                    |
| Ctrl+R                   | Reload the window (the connection and scrollback stay)  |

In the find box: Enter / Shift+Enter go to the next / previous match,
Alt+C / Alt+W / Alt+R toggle match case, whole word and regular expression,
and Escape closes it.

In the Worlds dialog, Tab and Shift+Tab move through it in order: the tree,
New World and New Character, the tabs (one stop, on the selected tab), the
selected tab's fields, then Connect.

| Keys                              | Action                                                        |
| --------------------------------- | ------------------------------------------------------------- |
| Up / Down, Home / End             | Move through the tree                                         |
| Right / Left                      | In the tree: expand / collapse (Left on a collapsed item goes to its parent) |
| Enter                             | In the tree: connect                                          |
| Delete                            | In the tree: delete the world or character (asks first)       |
| Shift+F10                         | In the tree: open the context menu                            |
| Left / Right, Home / End          | On the tabs: previous / next, first / last tab                |
| Ctrl+Page Down / Ctrl+Page Up     | Next / previous tab, from anywhere in the dialog (Cmd on macOS) |
| Ctrl+Tab / Ctrl+Shift+Tab         | Next / previous tab, likewise (Cmd on macOS)                   |
| F6 / Shift+F6                     | Jump between the tree, the tabs and the selected tab's fields |
| Alt+N / Alt+H / Alt+C / Alt+S     | New World / New Character / Connect / the Settings tab        |
| Escape                            | Close the dialog (as does a click outside it)                 |

Changes are saved as you make them.

## The worlds file

Worlds, characters and recent connections are stored as JSON in
`~/Documents/Moolin/worlds`. Pass a different path as the first command-line
argument to use another file:

```sh
npm start -- ~/my-worlds.json
```

Moolin runs as a single process, so this only takes effect for the first
launch: launching again while Moolin is running opens a new window that uses
the running instance's worlds file, whatever path is passed.

If the file doesn't exist yet, Moolin creates it with one world already in
it — LambdaMOO, with a Guest character — rather than starting empty.

Character passwords are stored in this file **in plain text**.

Writes are atomic (write to a temporary file, then rename), and each one
first copies the previous version to `worlds.bak` beside it. If the file
exists but can't be read or parsed, Moolin falls back to `worlds.bak`: the
Worlds dialog says so, and the next change is saved as a new `worlds`, with
the unreadable file kept beside it as `worlds.unreadable-<date>`, so a typo
from hand-editing never costs you anything. If the backup can't be read
either, the dialog says so and Moolin refuses to save at all. Malformed
individual entries are skipped with a warning.

## Preferences

Worlds → Preferences… (Ctrl+,, Cmd+, on macOS) opens a dialog for app-wide settings: whether to show
timestamps, whether to check for updates at startup, and the terminal's
default font and size. The default is Iosevka Moolin, a custom build of
[Iosevka](https://typeof.net/Iosevka/) bundled with the app (see
[`npm run build:font`](#commands)), so there's a deliberately-chosen
monospace font out of the box rather than whatever happens to be installed.
Each curated font is shown with a live sample highlighting characters that
commonly look alike in a monospace font (`0O`, `1lI`, `rn` vs `m`, and so
on), so you can judge it before picking it; one that isn't actually
installed (everything but Iosevka Moolin relies on the system already
having it) just falls back to the next one in its CSS stack, which the
sample makes obvious. Changes save and apply immediately:
showTimestamps is this window's own setting too (same as the View menu's
checkbox), while the font/size and update-check setting also become the
default for windows opened after. There's no Save or Cancel — like the
Worlds dialog, it saves as you go.

Settings are kept in `preferences.json` in the usual per-app config folder:

| OS      | Location                                          |
| ------- | ------------------------------------------------- |
| Linux   | `~/.config/Moolin/preferences.json`               |
| macOS   | `~/Library/Application Support/Moolin/preferences.json` |
| Windows | `%APPDATA%\Moolin\preferences.json`              |

A missing or unreadable file just means the defaults.

## Command-line options

| Option              | Effect                                                   |
| ------------------- | -------------------------------------------------------- |
| `<path>`            | Use this worlds file instead of the default              |
| `--log-level=LEVEL` | Log to the terminal: `none` (default), `error`, `warn`, `info` or `debug` |

## Development

### Branches

- `main` matches the latest release.
- `dev` collects finished work that isn't released yet; it's the branch to
  build and try for the current state of things. CI builds every push to it.
- Each feature or fix gets a branch of its own from `dev` (`feature/...`,
  `fix/...`), holding just that one change. When it's done it's merged
  straight into `dev`, and pushing `dev` has CI build and test it on Linux,
  Windows and macOS.
- A release is a pull request from `dev` into `main`, so it gets a full CI
  run and a record of its own before merging, followed by a version tag on
  `main` (see [Versioning](#versioning)).

### Commands

| Command             | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `npm run build`     | Typecheck, then bundle main, preload and renderer into `dist/` |
| `npm run dev`       | Rebuild on change (reload the window to pick it up)      |
| `npm test`          | Run the unit tests (`src/*.test.ts`, Node's test runner) |
| `npm run smoke`     | Build, then drive the real app through focus, typing, copy and link checks (see below) |
| `npm run typecheck` | Typecheck only                                          |
| `npm run lint`      | Lint `src/` with [Biome](https://biomejs.dev/) (`npm run lint:fix` to apply safe fixes) |
| `npm run format`    | Format `src/` with Biome (`npm run format:check` to check without writing) |
| `npm run build:font` | Rebuild the bundled default font from `font/private-build-plans.toml` (see below) |

The TLS tests generate a throwaway certificate with `openssl`, which must be
on the `PATH`.

`npm run build:font` (`scripts/build-font.mjs`) rebuilds Iosevka Moolin, the
custom [Iosevka](https://typeof.net/Iosevka/) build Moolin bundles as its
default font (`font/`). It's not part of `npm run build`: it clones the full
[be5invis/Iosevka](https://github.com/be5invis/Iosevka) build toolchain
(much heavier than anything else this project needs) into
`font/.iosevka-src/` the first time it's run, reusing it on later runs, and
only needs rerunning when `private-build-plans.toml` changes. Set
`IOSEVKA_SRC` to point at a checkout of your own instead of letting it
clone one. The four built faces (Regular, Bold, Italic, BoldItalic — what
the scrollback switches between for SGR bold/italic) are committed, along
with the font's SIL Open Font License text (`font/LICENSE-IosevkaMoolin.md`).

`npm run smoke` (`scripts/smoke.mjs`) covers what the unit tests can't
reach: the renderer in a real window. It launches Moolin in a throwaway
sandbox (its own config folder, worlds file and Documents folder, so it
leaves a Moolin you have running and your logs alone), connects it to a
local test server, and drives it over the Chrome DevTools Protocol:
clicking, selecting, copying and typing, and checking where keyboard focus
goes, that typed commands reach the server, what copying a wrapped or
partial selection gives, Clear Screen, and a Pueblo world's links. Its windows appear on screen while it
runs (a few seconds), so it needs a real display; on headless Linux use
`xvfb-run`. Runs on Linux and macOS; on Windows the same mechanism should
work but hasn't been tried. To check a packaged build instead, point
`MOOLIN_SMOKE_APP` at its executable, e.g.
`MOOLIN_SMOKE_APP=release/linux-unpacked/moolin node scripts/smoke.mjs`
(the AppImage works too; on macOS, the binary inside the `.app`'s
`Contents/MacOS/`).

### Layout

| File                      | Role                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `src/main.ts`             | App lifecycle, menus, IPC handlers                                        |
| `src/window-manager.ts`   | The set of open terminal windows and their placement                      |
| `src/terminal-window.ts`  | One window: its BrowserWindow, connection, scrollback buffer and menu     |
| `src/connection-manager.ts` | One window's connection: status, auto-login, status messages            |
| `src/telnet.ts`           | A telnet session over TCP or TLS, with per-option negotiation handlers    |
| `src/telnet-protocol.ts`  | Telnet byte-stream parser and command encoding (no I/O)                   |
| `src/worlds.ts`           | Reading, validating and writing the worlds file                           |
| `src/worlds-types.ts`     | The World, Character and MRU types shared by main and renderer            |
| `src/preferences.ts`      | Reading and writing app-wide preferences                                  |
| `src/fonts.ts`            | The curated monospace font list, size bounds and sample text              |
| `src/world-utils.ts`      | World helpers shared by main and renderer (defaults, labels, login templates) |
| `src/update-check.ts`     | Asking GitHub whether a newer release exists                              |
| `src/scrollback-buffer.ts`| The per-window replay buffer, with each line's arrival time               |
| `src/session-log.ts`      | Persistent per-world/character logs, their `.times` sidecar, and which window owns each |
| `src/line-feeds.ts`       | The line-feed count that keeps per-line times aligned across all of these |
| `src/preload.ts`          | The `window.moolin` API exposed to the renderer                           |
| `src/renderer.ts`         | The terminal window's page: wires the scrollback, gutter, input area, status bar and keys together |
| `src/scrollback-view.ts`  | The scrollback's DOM: draws lines, keeps to the bottom, trims, measures its size |
| `src/line-stream.ts`      | What the scrollback shows: text in, lines with arrival times out (no DOM)  |
| `src/ansi-parser.ts`      | Streaming parser for colour and attribute sequences, and how a style looks |
| `src/line-builder.ts`     | Builds lines (their text, styled runs and time) from the parser's output   |
| `src/held-selection.ts`   | Keeps the scrollback's selection, and its highlight, after focus moves away |
| `src/timestamp-gutter.ts` | The per-line timestamp column                                              |
| `src/linkify.ts`          | Finding web addresses in text                                              |
| `src/pueblo.ts`           | Pueblo: the greeting, and reading its links, line breaks and clears        |
| `src/link-menu.ts`        | The popup that lists a Pueblo link's commands                              |
| `src/scrollback-search.ts`| Finding matches in the lines, and which match is current                   |
| `src/worlds-dialog.ts`    | The Worlds dialog                                                         |
| `src/preferences-dialog.ts` | The Preferences dialog                                                  |
| `src/tabs.ts`             | Tab strips (the Worlds dialog's), with ‹ › scrolling when they overflow   |
| `src/find-widget.ts`      | The scrollback find box                                                   |
| `src/live-replay.ts`      | Merging a window's scrollback replay with its live output, without repeats |
| `src/security-status.ts`  | The status bar's security shield and its connection details popup         |
| `src/command-history.ts`  | Input history                                                             |
| `src/input-undo.ts`       | Input area undo/redo                                                     |
| `src/ipc-channels.ts`     | IPC channel names shared by main and preload                              |
| `src/logger.ts`           | Leveled logging to the terminal, set by `--log-level`                     |

## License

MIT; see [LICENSE](LICENSE).

The icon is a remix of "Woman with roses" by j4p4n from
[OpenClipart](https://openclipart.org/), dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

The bundled default font, Iosevka Moolin (`font/`), is a custom build of
[Iosevka](https://typeof.net/Iosevka/) by Belleve Invis, licensed under the
[SIL Open Font License 1.1](font/LICENSE-IosevkaMoolin.md).
