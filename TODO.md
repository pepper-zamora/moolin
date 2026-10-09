# To do

Things we thought of and set aside while finishing something else. Each one
gets its own branch when we pick it up; move it out of this list then.
Larger feature ideas (triggers, aliases, a mapper and so on) live in
[GAPS.md](GAPS.md) instead.

## App

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
- **The View menu shows "Toggle Full Screen" twice on macOS (upstream
  Electron bug).** One row with fn+F (the Globe key), one with Ctrl+Cmd+F.
  This is [electron/electron#52821](https://github.com/electron/electron/issues/52821),
  open as of this writing, with an unmerged fix in
  [PR #53137](https://github.com/electron/electron/pull/53137). Cause, per
  that thread: AppKit sees the `togglefullscreen` role's menu item and
  injects its own *hidden* duplicate carrying the system shortcut; Electron
  then makes every item visible, exposing it. It was first reported as
  #49048, fixed in #49074, and has since regressed — reproduced on 42.x,
  43.x and our 44.5.1 (macOS Tahoe 26.6.2). Nothing to do here but wait for
  the upstream fix and re-test on the Electron bump.

  Every app-side workaround was tried and each costs the working fn+F
  shortcut, which is why the duplicate is left in place:

  | Menu config | Visible rows | fn+F works |
  | --- | --- | --- |
  | `role: "togglefullscreen"` (what we ship) | 2 | yes |
  | role + explicit `accelerator` | 2 | yes (that accelerator doesn't) |
  | role + `registerAccelerator: false` | 2 | yes |
  | role + `accelerator: ""` | 1 | no |
  | role + `visible: false` | 0 | yes |
  | role hidden *plus* a plain visible item | 1 | no |
  | plain item + click handler, no role | 1 | no |
  | no item at all | 0 | no |

  Also tried: forcing AppKit's own automatic item via the
  `NSFullScreenMenuItemEverywhere` Info.plist key (absent from Electron's
  bundle). No effect — an Electron maintainer notes in #49074 that this
  workaround no longer functions. Note too that fn+F is assigned by macOS
  to the role's item; Electron accelerators have no Globe/fn modifier, so
  it can't be bound directly.

- **Screen readers are untested with the new scrollback.** It is ordinary
  page content (a `div` per line) rather than a canvas, so a screen reader can
  read it, but nothing marks it as a live log (`role="log"`, `aria-live`),
  and a busy MUD would make announcing every new line noisy. Try NVDA and
  VoiceOver and decide deliberately what, if anything, to announce.

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
