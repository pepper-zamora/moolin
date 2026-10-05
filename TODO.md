# To do

Things we thought of and set aside while finishing something else. Each one
gets its own branch when we pick it up; move it out of this list then.
Larger feature ideas (triggers, aliases, a mapper and so on) live in
[GAPS.md](GAPS.md) instead.

## App

- **Word-wrap's resize scroll position is only approximate.** When a window
  resizes while word-wrap is on, `reflowForResize()` (src/renderer.ts)
  restores scroll position as a proportion of the buffer (`viewportY /
  length` before, scaled by the new `length` after) rather than anchoring to
  the exact logical line that was on screen — reflowing at a new width
  changes how many visual rows each logical line takes, so an exact anchor
  would need per-logical-line marker tracking through the redraw. This was a
  deliberate v1 scoping call, not an oversight, but it needs a hard look
  before it's accepted as the long-term answer: give it real usage (does the
  approximation drift noticeably with a large scrollback or lots of
  wrapped lines?) and decide whether it's good enough or needs the
  marker-based exact version.

## Testing

- **macOS.** Apple silicon confirmed: the "damaged and can't be opened"
  Gatekeeper quarantine message appears as expected, and the README's fix
  (`xattr -dr com.apple.quarantine /Applications/Moolin.app`) works as
  documented. Intel Mac still untested.
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
