# To do

Things we thought of and set aside while finishing something else. Each one
gets its own branch when we pick it up; move it out of this list then.
Larger feature ideas (triggers, aliases, a mapper and so on) live in
[GAPS.md](GAPS.md) instead.

## App

- **Decide whether to honour a Pueblo server's clear.** `<xch_page
  clear=text>` adds a screenful of blank lines (as Ctrl+L does), once
  something follows it (`LineStream`, `src/line-stream.ts`). Penultimate
  Destination (PennMUSH) sends `</xch_mudtext><img xch_mode=purehtml><xch_page
  clear=text>` at the end of every login burst, right after the room
  description (seen in its session log at 09:42:17 and 09:49:05, in the same
  burst as the login text), so the room scrolls out of view as soon as the
  reply to your first command arrives. A first version honoured the clear at
  once and scrolled the room away during login, which is how this was found;
  deferring it only delays the same loss. Options: ignore server clears
  entirely (history is scrollable anyway, Ctrl+L stays your own clear, and
  `--log-level=debug` still notes them); ignore them by default with a
  Global/World/Character Inherit/On/Off setting like word wrap; or keep it
  as is. Other clients mostly ignore `xch_page` clears, which argues for the
  first. Whichever is chosen, `README.md`, `PROTOCOLS.md` and
  `CHANGELOG.md` describe the current behaviour.
- **Endless scroll: page older history into the scrollback from main.** The
  scrollback keeps the newest 20,000 lines as page elements (`SCROLLBACK_LINES`
  in `src/renderer.ts`); anything older is gone from the window even though
  the main process still has it. Paging it back in would let the user scroll
  through far more without paying for it in page elements. Not urgent: the
  bounded scrollback is already cheap. Measured in Electron on macOS, a
  40,000-line replay (reload, world switch) takes about 250 ms with only the
  newest 20,000 drawn, a 30,000-line flood about 260 ms including layout,
  steady output no measurable work beyond the frame, and scrolling back
  through 20,000 lines about 8 ms a frame. Two things tried and rejected:
  `content-visibility: auto` on the lines was about five times *slower*
  (57 ms against 10 ms a frame with steady output, 41 ms against 8 ms a
  scrolled frame), because pinning to the bottom and the gutter's `offsetTop`
  reads keep forcing layout of the skipped content; and drawing a long replay
  in slices across frames isn't needed (lines about to be trimmed are never
  drawn). Do this only if people want deep history.

  The data is already in main: `ScrollbackBuffer` (`src/scrollback-buffer.ts`)
  records every line a window receives, in memory, whether or not the session
  log file is being written (the file is skipped when another window owns it),
  and the log file with its `.times` sidecar (`src/session-log.ts`) is a
  colder tier behind it when this window owns it. Today the buffer is capped
  at 2 MiB (`MAX_SCROLLBACK_BYTES`, `src/terminal-window.ts`) and the
  renderer replays all of it. The design:

  - The renderer holds a window of recent lines (live data plus the initial
    replay). Older lines are fetched on demand as the user scrolls toward the
    top, prepended with the scroll position compensated (`overflow-anchor`, or
    `scrollTop` plus the added height), and dropped from the far end when
    scrolling back down. Pages rather than per-line virtualization: wrapping
    makes line heights variable, so fixed-height virtual lists don't work, and
    pages avoid estimating heights. The scrollbar then reflects the loaded
    window, as in a chat app, not the whole history; jumping to an arbitrary
    old position is out of scope.
  - Give `ScrollbackBuffer` a monotonically increasing absolute position
    (bytes trimmed so far plus the offset), raise its cap well above what the
    renderer draws (raw text is far cheaper than page elements), and add IPC
    (`ipc-channels.ts`, `preload.ts`, `main.ts`): `getHistoryPage(beforePosition,
    maxBytes)` returning `{ bytes, times, nextPosition | null }`, with the
    initial replay carrying its own start position. Pages are strictly older
    than the replay, so `LiveReplay`'s sequence de-duplication is unaffected.
  - Page backward by bytes and cut forward to the first line feed (LF never
    occurs inside UTF-8 or an escape sequence, the same argument as
    `ScrollbackBuffer.trim`), counting line feeds with `countLineFeeds` and
    taking the matching times by counting from the end. Past the memory cap,
    read from the file tail the same way (the sidecar's fixed-width records
    make a line's time an O(1) lookup from the end).
  - The seam is `LineStream` (`src/line-stream.ts`): lines already carry a
    `time` and a stable `id`. Add a `loadOlder(): Promise<Page | null>` source
    and a `prepend` on `LineBuilder` that doesn't touch the open line.

  Caveats: the SGR state at a page start is unknown going backward, so older
  pages start in the default style (wrong only for a colour opened on a
  previous line and never reset). Find and select-all only cover loaded
  lines, unless search moves to main, which would also find all history.
  Main's memory grows with the raised cap. Check whether the log file is
  size-capped or rotated, and note `session-log.ts`'s reads are synchronous,
  so page reads should be small and async.
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
