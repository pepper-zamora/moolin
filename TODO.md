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
- **Word-wrap-safe copy assumes ordinary (linear) selection.** xterm.js also
  has an Alt+drag "column/block select" mode (rectangular, not line-wrapping
  aware), with no public API to detect it from `getSelectionPosition()`'s
  result, and no documented, cross-platform option to disable it
  (`macOptionClickForcesSelection` only affects macOS). `getWrapAwareSelection()`
  (src/renderer.ts) doesn't special-case it, so Alt+drag-selecting across a
  word-wrapped paragraph may copy more text than the rectangle visually
  highlighted (that paragraph's whole original line, not just the selected
  columns). Narrow, rare-gesture limitation — never wrong/corrupted output,
  just more than expected — accepted rather than engineered around.
- **A dead connection isn't detected after the Mac sleeps and wakes.**
  Reported on macOS: suspending (lid close / sleep) and later waking leaves
  the window showing "Connected" with no error, but the underlying telnet
  socket is actually dead — the server saw the network vanish and presumably
  closed its end, but the client's TCP socket never got a FIN/RST to notice,
  so typing and sending produces no error and nothing ever comes back. Needs
  investigation in `connection-manager.ts`'s socket handling: likely wants
  TCP keepalive (`socket.setKeepAlive`) so a truly-dead connection surfaces a
  `close`/`error` event in reasonable time, and/or hooking Electron's
  `powerMonitor` `"resume"` event to proactively probe or re-check the
  connection right after a sleep/wake cycle, rather than waiting on TCP's own
  (sometimes very slow, or silent) failure detection.

- **`--screen-reader-mode` is internal/undocumented, but could be a real
  feature.** Added so `scripts/smoke.mjs` could read rendered text and
  coordinates via xterm's own accessibility tree (a hidden DOM mirror of
  visible rows) instead of reaching into xterm's internal buffer API — see
  `src/global.d.ts`'s `screenReaderMode` field. It genuinely enables basic
  NVDA/VoiceOver support (xterm.js's own feature, not something built here),
  currently off by default and unmentioned in README's command-line options
  table. Worth deciding deliberately whether to document and ship it as a
  real, user-facing flag (there's a real cost: a DOM node per visible row,
  kept in sync on every render) rather than leaving it as a test-only side
  effect.

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
