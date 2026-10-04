# Moolin

A cross-platform MOO / MUSH / MUD client written by AI to Pepper's personal
tastes. When this repository was first published, every line of its code and
documentation had been written by AI (Anthropic's Claude), at the direction of
Pepper, an experienced player on social servers such as LambdaMOO, who decided
what it should do and how it should feel to use.

A desktop client for MOOs, MUSHes, MUCKs and MUDs, with buttery-smooth
scrollback. Built on Electron and xterm.js (WebGL-rendered), for Linux,
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

## Features

- **One window per connection.** Connecting from a window that already has a
  connection opens the new one in a window of its own. All windows run in one
  process; launching Moolin again just opens another window.
- **Worlds and characters.** Save worlds (host, port, TLS) and the characters
  you play on each, then connect to a world, or to a world as a character.
- **Auto-login.** Connecting as a character can send a login command built
  from a per-world template, e.g. `co "{{character}}" {{password}}\r`.
- **TLS, explicitly.** Each world either uses TLS or doesn't; Moolin never
  guesses, so a connection can't be silently downgraded. Certificates are
  verified unless the world opts into accepting untrusted (e.g. self-signed)
  ones. A shield at the right of the status bar shows the connection's
  security: green with a check for TLS with a trusted certificate, yellow
  with a question mark for an untrusted certificate the world accepts, red
  with a cross for plaintext. Hover over it for the protocol, cipher, key
  exchange and the certificate chain's details.
- **Scrollback that survives a reload.** 100,000 lines, with clickable URLs.
  The main process keeps the last 2 MiB of each window's output, so reloading
  the window (Ctrl+R) or a renderer crash doesn't lose it.
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
- **Scrollback search.** Edit > Find (Ctrl+F) opens a find box at the top
  right of the window, with match-case, whole-word and regular-expression
  toggles. Every match is highlighted, and marked beside the scrollbar, and
  the matches update as new output arrives.
- **Telnet negotiation** of ECHO (no local echo during password prompts),
  NAWS (window size), TTYPE and SGA; every other option is refused.
- **Multi-line input** that grows as you type, with shell-like history and its
  own undo/redo (coalesced typing, and atomic steps for cut/paste).
- **Cut, copy and paste** that work against either the scrollback selection or
  the input area, whichever was selected last.
- **Recent connections** on the Worlds menu, Ctrl+1 to Ctrl+5.

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
does that on every `v*` tag and attaches the results to a GitHub Release. The
rpm and pacman targets need `rpmbuild` and `bsdtar` installed. Windows builds
are unsigned, and so are macOS builds unless the signing secrets named in the
workflow are set. `packaging/aur/PKGBUILD` is a draft for an AUR `moolin-bin` package.

## Using Moolin

Press **Ctrl+O** to open the Worlds dialog. Its tree has a **Global** root
(for settings shared by every world; there are none yet), with each world
(globe icon) under it and each world's characters (silhouette icon) under
that. **New World** adds a world; fill in its host and port. With a world or
one of its characters selected, **New Character** adds a character to that
world (as does right-clicking a world, or Shift+F10). Select a world or
character and press **Connect** (or Enter, or double-click).

The selected item's details are in tabs to the right of the tree; for now
there is just **Settings**, with more (such as triggers) to come. When the
tabs don't fit on one row, ‹ › buttons at the right end scroll through them.

A connection keeps the settings its world had when it connected: changes
saved in the Worlds dialog, including **Echo typed commands into the
scrollback** and the world's name, apply to windows already connected to that
world only once they reconnect.

Type commands in the input area at the bottom; the scrollback above is output
only. The status bar below the input area shows what the window is connected
to; the input area is disabled while it isn't connected.

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

### Keyboard shortcuts

| Keys                     | Action                                                  |
| ------------------------ | ------------------------------------------------------- |
| Ctrl+O                   | Open the Worlds dialog                                  |
| Ctrl+N                   | New world                                               |
| Ctrl+K                   | Disconnect (asks first)                                 |
| Ctrl+W                   | Close the window                                        |
| Ctrl+1 … Ctrl+5          | Connect to a recent world or character                  |
| Enter / Shift+Enter      | Send / insert a newline                                 |
| Up / Down                | Previous / next command, from the first / last line     |
| Ctrl+Up / Ctrl+Down      | Previous / next command, from anywhere                  |
| Page Up / Page Down      | Scroll the scrollback                                   |
| Ctrl+L                   | Clear the screen (earlier output stays scrollable)      |
| Ctrl+F                   | Find in the scrollback                                  |
| F3 / Shift+F3            | Next / previous match                                   |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy the selection / paste into the input area    |
| Ctrl+Z                   | Undo in the input area                                  |
| Ctrl+Shift+Z / Ctrl+Y    | Redo in the input area                                  |
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
| Ctrl+Page Down / Ctrl+Page Up     | Next / previous tab, from anywhere in the dialog              |
| Ctrl+Tab / Ctrl+Shift+Tab         | Next / previous tab, likewise                                 |
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

App-wide settings (for now, just whether new windows show timestamps) are
kept in `preferences.json` in the usual per-app config folder:

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

| Command             | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `npm run build`     | Typecheck, then bundle main, preload and renderer into `dist/` |
| `npm run dev`       | Rebuild on change (reload the window to pick it up)      |
| `npm test`          | Run the unit tests (`src/*.test.ts`, Node's test runner) |
| `npm run smoke`     | Build, then drive the real app through focus and typing checks (Linux; see below) |
| `npm run typecheck` | Typecheck only                                          |
| `npm run lint`      | Lint `src/` with [Biome](https://biomejs.dev/) (`npm run lint:fix` to apply safe fixes) |
| `npm run format`    | Format `src/` with Biome (`npm run format:check` to check without writing) |

The TLS tests generate a throwaway certificate with `openssl`, which must be
on the `PATH`.

`npm run smoke` (`scripts/smoke.mjs`) covers what the unit tests can't
reach: the renderer in a real window. It launches Moolin in a throwaway
sandbox (its own config folder, worlds file and Documents folder, so it
leaves a Moolin you have running and your logs alone), connects it to a
local test server, and drives it over the Chrome DevTools Protocol:
clicking, selecting and typing, and checking where keyboard focus goes and
that typed commands reach the server. Its windows appear on screen while it
runs (a few seconds). Linux only for now, and it needs a display (use
`xvfb-run` without one). To check a packaged build instead, point
`MOOLIN_SMOKE_APP` at its executable, e.g.
`MOOLIN_SMOKE_APP=release/linux-unpacked/moolin node scripts/smoke.mjs`
(the AppImage works too).

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
| `src/world-utils.ts`      | World helpers shared by main and renderer (defaults, labels, login templates) |
| `src/scrollback-buffer.ts`| The per-window replay buffer, with each line's arrival time               |
| `src/session-log.ts`      | Persistent per-world/character logs, their `.times` sidecar, and which window owns each |
| `src/line-feeds.ts`       | The line-feed count that keeps per-line times aligned across all of these |
| `src/preload.ts`          | The `window.moolin` API exposed to the renderer                           |
| `src/renderer.ts`         | The terminal window's page: scrollback, gutter, input area, status bar, keys |
| `src/worlds-dialog.ts`    | The Worlds dialog                                                         |
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
