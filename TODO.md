# To do

Things we thought of and set aside while finishing something else. Each one
gets its own branch when we pick it up; move it out of this list then.
Larger feature ideas (triggers, aliases, a mapper and so on) live in
[GAPS.md](GAPS.md) instead.

## App

- **Preferences dialog.** Worlds → Preferences… is a placeholder that says
  "Not yet implemented". The two settings there are so far (timestamps, the
  update check) are menu checkboxes. Either build the dialog or remove the
  menu item until there's one.

## Testing

- **macOS.** Nothing has run the macOS build yet. Test the `.dmg` on a Mac,
  both Apple silicon and Intel if possible, and check the README's
  Gatekeeper steps against what macOS actually shows.
- **rpm and pacman packages.** Built by CI but never installed. Test them on
  Fedora and Arch, for example in a VM.

## Development setup

- **npm install-script approvals.** npm 11.16 holds back install scripts
  until they're approved, and `esbuild` and `electron-winstaller` have
  pending ones. Decide which to approve (`npm approve-scripts`) so installs
  stop warning.
- **README's Node version.** "Getting started" says Node.js 22 or later, but
  CI and Electron are on Node 24.

## Releases

- **Withdrawing a release.** Write down how to pull a bad release (back to a
  draft, delete its CI artifacts, ship a fix, tell people), as a
  `SECURITY.md` or a README section, so it's ready if it's ever needed.
