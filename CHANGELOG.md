# Changelog

Notable changes to Moolin, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version
numbers follow the rules in the README's [Versioning](README.md#versioning)
section.

Each change adds its entry under **Unreleased** as it's made; a release
renames that section to the new version and date.

## [Unreleased]

### Added

- A Preferences dialog (Worlds → Preferences…, or Ctrl+,/Cmd+,), replacing
  the placeholder: show timestamps, check for updates at startup, and the
  terminal's default font and size, with a live sample of each curated font.
- A freshly opened window now sizes itself to show 80x25 characters at its
  starting font, centered on screen, instead of a fixed size.
- A first-ever launch (no worlds file yet) now starts with LambdaMOO and a
  Guest character already set up, instead of an empty Worlds dialog.
- Iosevka Moolin, a custom [Iosevka](https://typeof.net/Iosevka/) build
  bundled with the app, is now the default terminal font (`npm run
  build:font` rebuilds it from `font/private-build-plans.toml`).
- The status bar shows the terminal's current size in characters (e.g.
  `80x25`), next to the logging indicator.
- Word wrap: an opt-in Global/World/Character setting (Inherit/On/Off,
  Character overrides World overrides Global) that wraps long server lines
  at word boundaries for display. Copying a wrapped line gives back exactly
  the text selected. Off by default. The
  Worlds dialog's Global Settings tab also gained its first real setting,
  **Echo typed commands into the scrollback**, promoted from a World-only
  checkbox to the same Global/World/Character cascade.

- Pueblo support. A world that greets with "This world is Pueblo" is
  answered with `PUEBLOCLIENT 2.01`, and its `<a xch_cmd>`, `<send>` and
  `<a href>` links become clickable in the scrollback (right-click a link
  with several commands to choose one; the status bar shows what a link will
  do while the pointer is on it), with `<br>` and `<xch_page clear=text>`
  honoured (a clear waits until something follows it) and other HTML tags
  dropped; text that only looks like a tag, such as `<name>`, is shown as
  sent. `--log-level=debug` says what was dropped or cleared. See
  [PROTOCOLS.md](PROTOCOLS.md).

### Changed

- **The scrollback is rewritten**, no longer built on xterm.js: each server
  line is a real line of text in the page, which the browser wraps, selects
  and scrolls, with its own parser for colours and attributes. It keeps the
  newest 20,000 lines (it was 100,000), and the main process still keeps the
  last 2 MiB of output for a reload. Search, the timestamp gutter, Clear Screen, links and the selection all behave as
  before, with these differences:
  - Searching marks matches with a ruler over the scrollbar and finds text
    across a wrapped line; only the newest 1,000 matches are kept.
  - A selection stays highlighted, and copyable, after focus returns to the
    input area, until something else is selected.
  - Moving the pointer over a web address shows it in the status bar's left
    area until the pointer leaves.
  - Carriage returns, backspaces and cursor-movement and erase sequences from
    a server are ignored rather than acted on.
  - A line more than 16,384 characters long is split into several.
- **Breaking:** `World.echoCommands` in the worlds file is now a tri-state
  string (`"inherit"`/`"on"`/`"off"`) instead of a plain boolean, to support
  the cascading setting above. An older Moolin can't read a worlds file
  saved by this version; existing files are migrated automatically on read
  (`true` → `"on"`, `false` → `"off"`).

- The Pueblo greeting only counts from the start of a connection until the
  first line is sent to the server (typed, or the auto-login). Before, anyone
  on a world could say the words later and turn their text into links that
  ran commands when clicked. To keep Pueblo working with auto-login, the
  login is now held until the server has sent a whole line; a server that
  sends none until it is spoken to no longer gets the login.

### Removed

- The undocumented `--screen-reader-mode` flag, which only existed to let the
  smoke check read xterm's accessibility tree.

### Fixed

- Select All (Cmd/Ctrl+A) now selects the input line, so what's in it can be
  typed over, unless something is selected in the scrollback, when it selects
  the whole scrollback. Before, it always took the scrollback. Clicking into
  or editing the input line lets go of a lingering scrollback selection, and
  the right-click menu's Select All follows what was clicked on.
- Putting the computer to sleep now closes every connection properly and
  prints "[disconnected: the computer is going to sleep]" in its window.
  Before, the sleep cut the connection off silently, and the window looked
  live after waking until a line sent failed with an error like `read
  EADDRNOTAVAIL`.
- The worlds file, its backup, and session logs (and the folders made for
  them) are now readable by their owner alone on macOS and Linux, where they
  used the system default, usually readable by every user on the machine. A
  file from an earlier version is tightened the next time it is written. The
  README now has a section on what Moolin stores and who can read it.
- The main process now checks everything the window sends it, and only from
  a Moolin window's own page, since that page displays whatever servers send:
  sizes, addresses (only `http` and `https` are opened), text, menu items and
  log calls are all validated before use. The window is sandboxed explicitly,
  can't open other windows or navigate away, and its content security policy
  is stricter. Status lines no longer pass control characters on, such as from
  a certificate's host names in an error, and a connection that never
  answers gives up after 20 seconds instead of waiting for the system's much
  longer timeout.
- A server can no longer make Moolin hold memory without end with a control
  sequence that never finishes, endless distinct colours, or endless made-up
  Pueblo tag names; each is now capped.
- Keyboard shortcuts now use Cmd instead of Ctrl on macOS, matching that
  platform's convention.

## [0.1.0] - 2026-10-04

The first public release.

### Added

- One window per connection, all in one process; launching Moolin again
  opens another window.
- Saved worlds and characters, with auto-login from a per-world template, a
  Worlds dialog, and recent connections on the Worlds menu (Ctrl+1 to
  Ctrl+5).
- Explicit TLS per world, with certificate checking, and a status-bar shield
  showing each connection's security.
- 100,000 lines of scrollback with clickable URLs, kept across window
  reloads, and scrollback search (Ctrl+F).
- Persistent session logs under `Documents/Moolin`, which also refill the
  scrollback on reconnect.
- Line timestamps (View → Show Timestamps).
- Telnet negotiation of ECHO, NAWS, TTYPE and SGA.
- A multi-line input area with command history and its own undo and redo.
- A check for newer releases at startup, which can be turned off (Help →
  Check for Updates at Startup), and by hand (Help → Check for Updates…).
- Builds for Linux (AppImage, deb, rpm, pacman), Windows (installer and
  portable exe) and macOS (dmg and zip, Apple silicon and Intel). The
  Windows and macOS builds are unsigned.

[Unreleased]: https://github.com/pepper-zamora/moolin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pepper-zamora/moolin/releases/tag/v0.1.0
