# Feature gaps vs. other MUD/MOO/MUSH/MUCK clients

Moolin today (per [README.md](README.md)) is a connection/worlds manager with
telnet negotiation, scrollback, logging and a multi-line input box. It has
**no scripting layer at all**: no triggers, no aliases, no timers, no
variables, no macros, no mapper, no out-of-band protocol support. Every
client surveyed below — from the long-established Windows/Mac clients to the
newest terminal client — treats those as the baseline feature set, not as
extras. This document lists what they have that Moolin doesn't, roughly
ordered by how commonly a MU* player would expect it.

Clients reviewed: [MUSHclient](https://www.gammon.com.au/mushclient/doc/general/features.html),
[Mudlet](https://wiki.mudlet.org/w/Manual:Trigger_Engine),
[TinTin++](https://en.wikipedia.org/wiki/List_of_MUD_clients),
[Potato](http://www.potatomushclient.com/),
[Atlantis](https://gdb.armageddon.org/index.php?topic=53346.0),
[Blightmud](https://github.com/Blightmud/Blightmud/blob/dev/resources/help/scripting.md).

## 1. Triggers

A trigger matches a line (or lines) of incoming text and fires an action.
Moolin has none of this; every other client's trigger system supports most
of the following:

- **Match types**: plain substring, start/exact match, wildcards (`*`,
  `%1`/`%2` capture groups in MUSHclient-style clients), and full Perl-style
  regex with capture groups (Mudlet `matches[]`, Blightmust capture tables).
- **Actions beyond "send a command"**:
  - **Highlight/recolor** the matched text or whole line (the gap you
    already knew about).
  - **Gag**: delete the matching line from the display (and optionally from
    the log) entirely — used to hide noisy spam.
  - **Substitute/rewrite** the line's text before it's displayed.
  - **Play a sound** on match.
  - **Run a script/function**, not just a canned command string.
  - Flash the taskbar/window, or other "needs attention" signaling.
  - **Tag the line**: Blightmud can attach an arbitrary tag to a matched
    line — in its case surfaced as a small colored mark in a margin next to
    the line — and separately supports filtering the scrollback to isolate
    or hide lines carrying a given tag. Worth calling out on its own: it's
    naturally "just another trigger action" (the match logic is identical to
    highlight/gag, it only differs in what gets attached to the line), but
    it also implies a second feature — a tag-aware scrollback view — to be
    useful (see §8).
- **Match on color**, not just text (MUSHclient can trigger on the ANSI
  color of incoming text, useful for servers that color-code message types
  without clean text markers).
- **Multi-line triggers**: match a pattern spanning several consecutive
  lines (Mudlet's "multi-line AND" with line delta; MUSHclient's multi-line
  triggers).
- **Trigger groups/classes**: enable/disable whole categories of triggers at
  once (e.g. turn off all combat triggers while not fighting).
- **One-shot / temporary triggers**: fire once then self-delete (Mudlet
  `tempTrigger`).
- **Sequence/priority**: control which trigger runs first when several
  match the same line, and whether later ones still run ("keep evaluating").

## 2. Aliases

Aliases transform what the *user* types before it's sent, as opposed to
triggers which act on what the *server* sends. Moolin has no alias system;
input is sent verbatim. Common features elsewhere:

- Wildcard/regex aliases with captured arguments (e.g. `gf %1` → `get %1 from
  floor`).
- Multi-command expansion (one alias sends several commands, often
  semicolon- or newline-separated).
- Aliases that run a script instead of (or in addition to) sending text.
- Per-world/per-class alias sets, enabled and disabled together.

## 3. Variables

Moolin stores nothing about session state beyond what's on screen. Every
scripting-capable client provides:

- **User variables**: named slots a script or trigger/alias can read and
  write (MUSHclient `%variable_name%`/`SetVariable`, Mudlet Lua globals or
  `setVariable`, Blightmud Lua tables), used for things like tracking HP,
  current target, or toggles.
- **Capture variables**: the wildcard/regex groups matched by the trigger or
  alias that fired (`%1`, `matches[2]`, etc.), usable in the resulting
  send/script.
- Persisting variables across reconnects/restarts (saved with the
  world/profile).

## 4. Timers

Scheduled or recurring actions independent of server output — e.g. "send
`eat bread` every 60s" or "wait 2s then send `stand`". Present in every
client surveyed (Mudlet `tempTimer`/permanent timers, MUSHclient timers,
Blightmud `timer` module, TinTin++ `#ticker`). Moolin has no scheduling
primitive at all.

## 5. Scripting language

Beyond the declarative trigger/alias/timer config, most clients expose a
real scripting language for anything more complex:

- MUSHclient: Lua, VBScript, JScript, PerlScript, Python (pluggable via
  Windows Scripting Host / embedded interpreters).
- Mudlet: Lua, with a large built-in API (`matches`, `tempTimer`,
  `selectString`, GUI label/mapper functions, etc.).
- Blightmud: Lua, with typed API stubs for editor autocomplete.
- Atlantis: Perl scripting plus a GUI event editor for simpler cases.
- TinTin++: its own scripting/macro language (`#if`, `#math`, `#function`,
  session variables) without embedding an external interpreter.

Moolin has no embedded or pluggable scripting of any kind.

Blightmud also ships a **plugin system** (a package manager layered on its
Lua scripts, letting users install/share trigger/alias bundles rather than
hand-copying script files) — a reasonable follow-on once a scripting
language exists, not a prerequisite for one.

## 6. Out-of-band / modern MUD protocols

Moolin's telnet layer (`src/telnet-protocol.ts`) negotiates only ECHO, NAWS,
TTYPE and SGA, refusing everything else. Other clients negotiate additional
protocols that let the server drive client UI directly:

- **MCCP** (MUD Client Compression Protocol) — transparent stream
  compression. Supported by Mudlet, MUSHclient, TinTin++, Atlantis.
- **GMCP** (Generic MUD Communication Protocol) — structured JSON-ish
  out-of-band messages for things like health bars, room data, maps.
  Supported natively by Mudlet and Blightmud; considered a baseline
  expectation on modern MUDs.
- **MSDP** (MUD Server Data Protocol) — similar structured-data channel,
  supported by Mudlet and Blightmud.
- **MXP** (MUD eXtension Protocol) — lets the server send clickable links,
  custom colors/fonts, and simple embedded UI. Supported by MUSHclient and
  Mudlet.
- **MSP** (MUD Sound Protocol) — server-triggered sound/music playback.
  Supported by MUSHclient, Mudlet.
- **MCP** — supported by Atlantis (MOO/MUCK-oriented out-of-band protocol).

Without any of these, a Moolin user connecting to a modern GMCP/MSDP-aware
game sees only plain text where other clients would show gauges, maps or
clickable exits.

Two smaller telnet-level gaps worth a separate mention, since they're not
MUD-specific add-on protocols but plain telnet options Moolin's parser
currently discards or never negotiates:

- **EOR/GA-based prompt detection**: many MUD servers mark the end of a
  prompt (a line with no trailing newline, e.g. `HP: 100>`) with a telnet
  `GA` (Go-Ahead) command, or with the dedicated EOR (End-of-Record, option
  25) if negotiated. `telnet-protocol.ts` already surfaces `GA` as a
  `command` event, but `telnet.ts` just drops it (`case "command": break;
  // GA, NOP, etc. — nothing to do.`), and EOR isn't negotiated at all.
  Blightmud, MUSHclient and TinTin++ all use this signal to know a prompt
  line is "done" without a newline, which matters for anything that wants to
  reason about where a prompt starts (status-bar overlays, "don't treat the
  prompt as a trigger-able line twice" logic, Blightmud's dedicated
  `prompt`/`prompt_mask` scripting modules). Currently Moolin just displays
  whatever arrives, newline or not, and has no notion of "this was a prompt."
- **CHARSET** (option 42, RFC 2066) — negotiated character-set agreement,
  letting a server confirm/switch to UTF-8 explicitly instead of a client
  guessing the byte encoding. Supported by Blightmud. Lower priority: most
  MUDs that care just send UTF-8 or Latin-1 unnegotiated and clients guess,
  which is what Moolin already does implicitly by decoding as UTF-8.
- **MSSP** (MUD Server Status Protocol) — lets a server report metadata
  (player count, uptime, codebase) mainly for listing-site crawlers rather
  than interactive play. Blightmud supports it; low priority for Moolin
  since it has no server-browsing/listing feature for it to feed.

## 7. Mapping / navigation

- **Automapper**: Mudlet has a full 2D/3D mapper built from room data (GMCP
  or trigger-parsed), with click-to-walk. TinTin++ has an ASCII `#map`
  automapper. MUSHclient supports speedwalking and keypad-direction
  shortcuts.
- Moolin has no mapping or speedwalking of any kind; movement is typed
  command-by-command.

## 8. UI/workspace features common elsewhere

- **Multiple capture/spawn windows**: Potato's secondary input windows and
  Atlantis's "spawn" windows let output matching a pattern (e.g. a tell
  channel) be split into its own pane. Moolin is strictly one scrollback per
  connection window.
- **Status bars / gauges**: configurable HP/mana/custom gauges driven by
  variables or GMCP, standard in Mudlet and MUSHclient.
- **Buttons / custom toolbars**: clickable buttons that send commands or run
  scripts (Mudlet, MUSHclient).
- **Built-in script/trigger editor UI**: a dedicated dialog for managing
  triggers/aliases/timers/variables as a tree (every scripting client above);
  Moolin would need some UI surface for this once scripting lands.
- **Chat/comms system**: MUSHclient has a built-in inter-client chat
  protocol; not common elsewhere and lower priority.
- **Spell checking** of outgoing text (MUSHclient).
- **Searchable/filterable scrollback** beyond plain text search (Mudlet
  logs are searchable; Blightmud has a text-search mode in its TUI). Moolin's
  scrollback has no search at all currently.
- **Tag-aware scrollback filtering**: the view-side counterpart to
  Blightmud's trigger-tagging (§1) — once lines can be tagged, being able to
  show-only or hide-by-tag turns tags into a lightweight "channel" view
  (e.g. isolate just combat lines, or just tells) without needing full
  spawn/capture windows.
- **Tab completion**: completing a partial word against recent scrollback
  output or command history (Blightmud; also common in Mudlet/MUSHclient).
  Moolin's input box has history recall (Up/Down) but no completion.
- **Split-view scrolling**: scrolling back through history opens a split so
  new server output keeps arriving below while old output stays pinned above
  (Blightmud's `scroll_split`; similar in Mudlet/TinTin++). Not a quick win
  for Moolin specifically: xterm.js (`src/renderer.ts`) is a single
  `Terminal` instance with one viewport over one scrollback buffer, and
  ships no split/pinned-pane addon the way it ships search (`addon-search`)
  or gets spellcheck for free from Chromium — there's nothing to "turn on."
  Getting this would mean building it: most plausibly a second, read-only
  `Terminal` instance frozen at a scroll position, fed from the same replay
  data Moolin already keeps per window in `scrollback-buffer.ts`, rendered
  alongside the live-tailing primary instance. That's real layout and
  state-sync work, not a config flag — treat it as closer in cost to a
  mapper or status-bar feature than to scrollback search.

## 9. Accessibility

- **Screen-reader-friendly mode**: Blightmud has a `reader_mode` setting
  that switches its TUI to a layout a screen reader can follow (dropping the
  status-area overlay that would otherwise confuse one).
- **Built-in text-to-speech**: Blightmud can optionally speak output itself,
  independent of OS-level screen reader software, and exposes a `tts`
  scripting module so triggers can speak specific text.
- Moolin, being a standard Electron/Chromium window, inherits whatever
  OS-level screen reader support Chromium's accessibility tree provides for
  free, but has nothing MUD-aware layered on top (e.g. no way to have a
  trigger speak a specific event, no reduced-overlay mode).

## Suggested priority if closing these gaps

1. **Scrollback search** and **spell checking**. Both are self-contained —
   neither depends on triggers, variables, or any other scripting
   primitive — and both are largely "wire up an existing library/platform
   API" work (xterm.js has a search addon; Electron/Chromium's spellchecker
   is available for free in any text input) rather than new design surface.
   Low-hanging fruit, worth doing first regardless of where the rest of
   this list goes.
2. **Triggers** (match + highlight/gag/send/script actions) and **aliases**
   — the two most-depended-on features; almost nothing else in this list is
   useful without them.
3. **Variables** and **capture groups**, since triggers/aliases are far less
   useful without a place to store what they matched.
4. **Timers**, a small primitive that unlocks a lot of common automation
   once triggers/aliases exist.
5. **GMCP/MSDP support**, since an increasing share of actively-developed
   MUDs assume a GMCP-aware client for health bars/maps/inventory.
6. **Line tagging and tag-filtered scrollback views**, once triggers exist —
   cheap to add as another trigger action (§1) since the match machinery is
   already built, and it immediately pays for itself as a lightweight
   channel/filter feature (§8) without the cost of full spawn windows.
7. Scripting language, mapper, status bars, accessibility features
   (screen-reader mode, TTS), plugin system, EOR/CHARSET/MSSP, and the rest
   — larger or more speculative investments best sequenced after the above
   land and real usage patterns emerge.
