# Moolin

A desktop client for MOOs, MUSHes, MUCKs and MUDs, with buttery-smooth
scrollback. Built on Electron and xterm.js (WebGL-rendered), for Linux,
Windows and macOS.

Moolin merges two earlier clients: moolin v1, which this repository's history
continues, and Moolin, which contributed its one-window-per-connection design,
its worlds-and-characters model and dialog, and its input/focus behavior.

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
  ones. The input area is tinted green over TLS and red otherwise.
- **Scrollback that survives a reload.** 100,000 lines, with clickable URLs.
  The main process keeps the last 2 MiB of each window's output, so reloading
  the window (Ctrl+R) or a renderer crash doesn't lose it.
- **Persistent logs.** Everything a window shows, colors included, is appended
  to `~/Documents/Moolin/<world>/<character>/moolin.log` (just `<world>/` when
  connecting without a character). Connecting pre-populates the scrollback with
  the last 2 MiB of that log. If several windows are connected to the same
  world and character, only the first reads and writes the log. The log grows
  without bound for now.
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
rpm and pacman targets need `rpmbuild` and `bsdtar` installed. macOS and
Windows builds are unsigned unless the signing secrets named in the workflow
are set. `packaging/aur/PKGBUILD` is a draft for an AUR `moolin-bin` package.

## Using Moolin

Press **Ctrl+O** to open the Worlds dialog. **New World** adds a world; fill
in its host and port. Right-click a world (or press Shift+F10) to add
characters to it. Select a world or character and press **Connect** (or
Enter, or double-click).

While a window isn't connected, a status strip takes the place of the input
area. Type commands in the input area at the bottom; the scrollback above is
output only.

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
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy the selection / paste into the input area    |
| Ctrl+Z                   | Undo in the input area                                  |
| Ctrl+Shift+Z / Ctrl+Y    | Redo in the input area                                  |
| Ctrl+= / Ctrl+- / Ctrl+0 | Larger / smaller / default font size                    |
| Ctrl+R                   | Reload the window (the connection and scrollback stay)  |

In the Worlds dialog: arrow keys move through the tree (Right/Left expand and
collapse), Enter connects, Delete deletes, Shift+F10 opens the context menu,
and Escape closes it.

## The worlds file

Worlds, characters and recent connections are stored as JSON in
`~/Documents/Moolin/worlds`. Pass a different path as the first command-line
argument to use another file:

```sh
npm start -- ~/my-worlds.json
```

Character passwords are stored in this file **in plain text**.

Writes are atomic (write to a temporary file, then rename). If the file
exists but can't be read or parsed, the Worlds dialog says so and Moolin
refuses to save over it, so a typo from hand-editing doesn't cost you your
worlds. Malformed individual entries are skipped with a warning. Files written
by moolin v1 or Moolin load as-is.

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
| `npm run typecheck` | Typecheck only                                          |
| `npm run lint`      | Lint `src/` with [Biome](https://biomejs.dev/) (`npm run lint:fix` to apply safe fixes) |
| `npm run format`    | Format `src/` with Biome (`npm run format:check` to check without writing) |

The TLS tests generate a throwaway certificate with `openssl`, which must be
on the `PATH`.

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
| `src/world-utils.ts`      | World helpers shared by main and renderer (defaults, labels, login templates) |
| `src/scrollback-buffer.ts`| The per-window replay buffer                                              |
| `src/preload.ts`          | The `window.moolin` API exposed to the renderer                           |
| `src/renderer.ts`         | The terminal window's page: scrollback, input area, keys                  |
| `src/worlds-dialog.ts`    | The Worlds dialog                                                         |
| `src/command-history.ts`  | Input history                                                             |
| `src/input-undo.ts`       | Input area undo/redo                                                     |
| `src/ipc-channels.ts`     | IPC channel names shared by main and preload                              |

## License

MIT; see [LICENSE](LICENSE).

The icon is a remix of "Woman with roses" by j4p4n from
[OpenClipart](https://openclipart.org/), dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
