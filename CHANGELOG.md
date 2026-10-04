# Changelog

Notable changes to Moolin, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version
numbers follow the rules in the README's [Versioning](README.md#versioning)
section.

Each change adds its entry under **Unreleased** as it's made; a release
renames that section to the new version and date.

## [Unreleased]

### Added

- A Preferences dialog (Worlds → Preferences…), replacing the placeholder:
  show timestamps, check for updates at startup, and the terminal's default
  font and size, with a live sample of each curated font.
- A freshly opened window now sizes itself to show 80x25 characters at its
  starting font, centered on screen, instead of a fixed size.

### Fixed

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
