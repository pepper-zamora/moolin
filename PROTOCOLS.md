# Telnet option negotiation and MUD protocol extensions

This is a developer-directed review of telnet option negotiation as Moolin
implements it, and of the MUD-specific protocols layered on top of telnet
that Moolin doesn't implement yet (GMCP, MSDP, MXP, MCCP, MSP), plus a
note on how vertical tab and form feed in world output are handled. For each
unimplemented one: what it's *for*, and why Moolin's codebase specifically
would benefit from it. This is not a wire-format reference — see the linked
specs for byte layouts.

## Telnet option negotiation, in general

Telnet options are negotiated with two-party haggling over four verbs:
`WILL`/`WONT` (sent by whichever side would *perform* the option) and
`DO`/`DONT` (sent by whichever side is *requesting* the other side perform
it). Either side can propose an option unprompted; the other side accepts or
refuses. Once an option is live, some options carry further data in a
*subnegotiation* (`IAC SB <option> ... IAC SE`) — e.g. NAWS's width/height,
TTYPE's terminal name.

Moolin's split mirrors this: [telnet-protocol.ts](src/telnet-protocol.ts) is
a pure byte-stream parser/encoder with no knowledge of what any option
*means* — it just turns bytes into `negotiation`/`sub`/`data`/`command`
events and back. [telnet.ts](src/telnet.ts)'s `buildOptionHandlers()` is a
small registry, one entry per option number. An entry's `local` side makes
it an option Moolin will perform when the server asks (`DO`/`DONT`), its
`remote` side one Moolin will let the server perform when it offers
(`WILL`/`WONT`), each with optional `onEnable`/`onDisable` callbacks, plus
an `onSub` for its subnegotiations. `dispatchNegotiation()` refuses a `DO`
with `WONT`, or a `WILL` with `DONT`, for an option without that side. This
default is deliberately conservative — Moolin never agrees to an option it
doesn't understand, and never proposes one unprompted either, so there's
no handler for the "we ask, server answers" direction at all right now;
every option Moolin supports today is one the *server* proposes and Moolin
accepts.

`TelnetSession` tracks which options are on at each end, and only answers a
request that changes one: a repeated `DO` or `WILL`, or a `DONT` or `WONT`
for an option that's already off, gets no reply. That's
[RFC 1143](https://www.rfc-editor.org/rfc/rfc1143)'s rule against
negotiation loops, where two peers that each acknowledge every request
would otherwise answer each other forever. A server can also turn an option
back off: `DONT NAWS` stops the window-size reports, and `WONT ECHO` brings
local echo back, each acknowledged once.

### Supported today

| Option | Number | Who proposes | What it does here |
| --- | --- | --- | --- |
| ECHO | 1 | server (`WILL`) | Server takes over echoing (password prompts); Moolin suppresses local echo of the input line for the duration. |
| SGA (Suppress Go-Ahead) | 3 | server (`WILL`) or Moolin (on the server's `DO`) | Historically turned off half-duplex turn-taking; on a modern full-duplex TCP connection it's a no-op Moolin just agrees to, since every real MUD expects it. |
| TTYPE (Terminal Type) | 24 | server (`DO`) | Moolin answers `SEND` subnegotiations with a fixed `XTERM` terminal-type string, so servers that branch on client capabilities (e.g. ANSI vs. not) see something sane. |
| NAWS (Negotiate About Window Size) | 31 | server (`DO`) | Moolin sends current columns/rows on negotiation and again via `resize()` whenever the window changes, so servers can word-wrap or lay out full-screen UI correctly. |

### A note on ECHO, and a separate thing that looks like it but isn't

Telnet ECHO (RFC 857) is about *remote character echo*: a party that says
`WILL ECHO` is offering to echo back, byte for byte, everything it receives
from the other side. On a classic line-mode terminal talking to a Unix
host, the server doing this is normal and expected. It's close to
meaningless for a MUD, though, since Moolin never streams keystrokes
char-by-char in the first place — `sendLine()` in [telnet.ts](src/telnet.ts)
always hands the server one complete line at a time. There's nothing for
the server to echo back character-by-character even if it wanted to, and
the input box already shows what's being typed the instant it's typed,
independent of any telnet negotiation. So in practice, for everything except password prompts, ECHO should be — and today effectively
is — off: Moolin never proposes it itself, and the only `WILL ECHO` a MUD
sends is the password-masking idiom (server takes over "echoing" by
deliberately echoing nothing, client stops showing typed characters for the
duration, server sends `WONT ECHO` once the prompt's done). The current
handler already implements exactly that idiom and nothing more, which is
the right amount of ECHO support — there's no deeper version of this option
worth adding.

What *is* configurable, and isn't related to the ECHO option at all, is
whether Moolin writes the command you typed into the scrollback after
sending it. That's synthetic: a few lines in the `telnetInput` handler in
[main.ts](src/main.ts) that print the typed text back into the scrollback
in cyan purely so a transcript/log shows what was typed, mirroring the
command next to the server's response, since most MUDs don't echo
commands back themselves on a full-duplex connection. It's gated on the same
`echoed` flag as real ECHO negotiation (suppressed during password entry),
but otherwise it's a display choice Moolin makes, not a protocol behavior.
Each world turns it on or off with **Echo typed commands into the
scrollback** (on by default; turn it off for a server that echoes input
itself). The setting is read from the world as it was at connect time, so
changing it takes effect in an already-connected window only on reconnect.

Everything else — including the protocols below — currently gets the
blanket refuse-and-ignore treatment, which is safe (no server-visible
breakage) but leaves real features on the table.

## Vertical tab and form feed in world output

Not a telnet option, but a related question about the byte stream: what to
do with VT (`\v`, 0x0B) and FF (`\f`, 0x0C) when a world sends them.
Moolin passes both through to its scrollback parser
([ansi-parser.ts](src/ansi-parser.ts)) unchanged, and treats each as a plain
line break, the same as LF. So a form feed starts a new line rather than clearing the screen or starting a
new "page", and a vertical tab starts a new line rather than moving to a
vertical tab stop. Both are kept as-is in the session log.

Since each one is a line, it also gets its own arrival time: the
timestamp code counts LF, VT and FF alike (`countLineFeeds` in
[line-feeds.ts](src/line-feeds.ts)), so the times stay lined up with
the scrollback's lines (see [GAPS.md](GAPS.md) §8).

This is a deliberate choice, but a provisional one: it's what terminals
do, kept because nothing yet calls for anything else. Revisit it if a real
world turns out to rely on another meaning, such as a form feed that's
meant to clear the screen.

## MCCP — MUD Client Compression Protocol

**What it's for:** a telnet option (86) that, once negotiated, switches the
*server→client* stream to zlib-compressed bytes. It exists purely to cut
bandwidth on busy MUDs with a lot of color/ANSI and combat spam, which was
meaningful on dial-up/early-broadband links and is still a meaningful win on
mobile connections or chatty servers today.

**Why Moolin might want it:** of the five, this is the easiest to justify on
pure self-interest grounds even without caring about any MUD-specific
feature — it's "make the pipe smaller," transparent to everything above it.
Practically, because telnet negotiation happens before any payload bytes,
supporting it means: accept the server's `WILL` (option 86) with `DO`, then
treat all subsequent server bytes as a zlib stream until disconnect (MCCP
has no "turn it back off" in practice). The parser boundary in
[telnet-protocol.ts](src/telnet-protocol.ts) would need to sit *after*
inflate rather than before — i.e. `TelnetSession` would decompress the raw
socket bytes before handing them to `TelnetParser.parse()`, since telnet
commands sent after MCCP is live are also compressed. This is the lowest-risk,
most mechanical protocol to add of the five; it changes nothing about
Moolin's UI or data model, just where decompression sits in the pipeline.

Spec: <https://www.gammon.com.au/mccp/>

## MSP — MUD Sound Protocol

**What it's for:** a simple in-band convention (not even real telnet
negotiation — it's a `!!SOUND(...)` / `!!MUSIC(...)` marker embedded in
normal text output, optionally wrapped in a telnet subnegotiation on option
90) letting the server tell the client "play this sound file" or "loop this
music," referencing a file by name/URL that the client fetches and caches.

**Why Moolin might want it:** lowest priority of the five. It's purely
cosmetic (ambient sound/music), used by a shrinking number of legacy MUDs,
and pulls in scope Moolin doesn't have yet at all — an HTTP fetcher, a local
sound-file cache, and audio playback in an Electron renderer (all doable,
but net-new surface area, not a small add to the telnet layer). Worth
revisiting only if a specific MUD a user cares about leans on it; not worth
building speculatively.

Spec: <https://www.zuggsoft.com/zmud/msp.htm>

## MXP — MUD eXtension Protocol

**What it's for:** a telnet option (91) that lets the server embed a subset
of HTML-like markup in its output — clickable links and commands
(`<send>`), font/color styling beyond ANSI's 16/256 colors, simple images,
and a "secure mode" fencing which tags the server is allowed to send
unprompted vs. only inside an explicit secure block (so untrusted user-
generated text on the MUD side can't inject client-side markup).

**Why Moolin might want it:** this is the protocol most entangled with
Moolin's rendering layer rather than its networking layer, since Moolin
renders scrollback itself
([scrollback-view.ts](src/scrollback-view.ts)), where the only clickable
inline spans are the auto-linkified URLs
mentioned in the README. Supporting MXP meaningfully would mean: parsing a
constrained HTML-like grammar out of the byte stream (a new layer above
`TelnetParser`, since MXP tags arrive as ordinary data bytes, not telnet
subnegotiations, except for the mode-switching option itself), mapping a few
of its tags (`<send>`, `<color>`, maybe `<a href>`) onto clickable spans
like the URL ones, and ignoring the rest. That's a reasonable amount of
work for a feature whose main payoff — clickable room exits/command links —
is also achievable per-MUD via triggers once Moolin has those (see
[GAPS.md](GAPS.md)). Worth it for the subset of MUDs that lean on MXP for
navigation, but triggers are the more general tool and should land first.

Spec: <https://www.zuggsoft.com/zmud/mxp.htm>

## MSDP — MUD Server Data Protocol

**What it's for:** a telnet option (69) carrying a flat key/value wire
format (its own compact encoding, not JSON) for structured game state —
health/mana/moves, room name/exits, character stats — pushed by the server
either on request or as a standing subscription ("REPORT" a variable, get
updates whenever it changes). It's deliberately minimal: no nesting beyond
simple arrays/tables, designed to be cheap to implement on the server side.

**Why Moolin might want it:** this is where "why implement it" stops being
about the wire format and starts being about what Moolin would *do* with
the data once decoded — and today, nothing, because Moolin has no variable
store, no status-bar/gauge UI, and no scripting layer to consume it (see
[GAPS.md](GAPS.md) sections 3 and 8). Implementing MSDP's negotiation and
decoder in isolation would be straightforward (a handler on option 69, a
small key/value parser for its subnegotiation payload) but the output would
have nowhere useful to go. This is a "build after" protocol: worth adding
once Moolin has variables for the decoded values to land in, at which point
MSDP is the lower-effort of the two structured-data protocols to parse.

Spec: <https://tintin.mudhalla.net/protocols/msdp/>

## GMCP — Generic MUD Communication Protocol

**What it's for:** the same problem MSDP solves (structured, out-of-band
game state — health bars, inventory, room/map data, server-to-client
`Char.Vitals`-style events) but encoded as JSON over telnet option 201,
organized into namespaced "packages" (`Core.Hello`, `Char.Vitals`,
`Room.Info`, etc.) that the client and server negotiate interest in by name.
It has become the de facto standard on actively-developed MUD codebases
(Evennia, many custom-built modern MUDs) specifically because JSON is easy
to produce and consume on both ends compared to MSDP's bespoke encoding.

**Why Moolin might want it:** same dependency as MSDP — the win is entirely
in what consumes the decoded data, not in the wire handling, which here is
even cheaper to add than MSDP's since the payload is just JSON
(`JSON.parse` on the subnegotiation bytes after the package-name prefix) and
Moolin already pulls in no special parsing infrastructure that would need
to change. The reason to prioritize GMCP over MSDP when the time comes is
coverage, not mechanics: it's the protocol modern/actively-maintained MUDs
are actually shipping, so it's the one that unlocks real servers for a
status-bar/variables feature once Moolin has one. The negotiation itself —
accept the server's `WILL` (201) with `DO`, then send a `Core.Hello`
subnegotiation identifying Moolin by name/version, then subscribe to
whichever packages a world's variables/UI care about — is a small, self-
contained addition to `buildOptionHandlers()`; the leverage comes from
pairing it with the variable/status-bar work in
[GAPS.md](GAPS.md).

Spec: <https://www.gammon.com.au/gmcp>

## Suggested sequencing

1. **MCCP** — self-contained, no dependency on other unbuilt features,
   pure win. Reasonable to do any time.
2. **GMCP**, then **MSDP** as a fallback for servers that only speak the
   older protocol — once Moolin has variables and *something* to show
   structured data in (even a simple status line), these become high-value;
   before that, decoding them has nowhere useful to put the result.
3. **MXP** — once triggers exist, re-evaluate whether MXP's clickable-link
   subset is still worth the parser/renderer work, or whether triggers cover
   the same ground per-MUD.
4. **MSP** — speculative; implement only in response to a specific MUD a
   user actually wants to play.
