# Known server types

Server software (codebases, engines and drivers) that a world might report
in [MSSP](https://tintin.mudhalla.net/protocols/mssp/)'s `CODEBASE`
variable, grouped by family. See GAPS.md §6 for MSSP itself.

`CODEBASE` is free text, so servers report these inconsistently: with or
without a version ("PennMUSH 1.8.8", "SmaugFUSS 1.9"), with a lineage
("ROM 2.4b6 / QuickMUD"), or with the game's own name. Match names
case-insensitively and by substring rather than exactly, and treat an
unrecognized value as normal. This list was compiled from memory of the
MUD-client and MUD-listing landscape. It isn't exhaustive, and the "Notes"
column gives lineage only roughly.

## MOO

| Codebase   | Notes                                                        |
| ---------- | ------------------------------------------------------------ |
| LambdaMOO  | The original MOO server (Pavel Curtis, Xerox PARC); 1.8.x    |
| Stunt      | LambdaMOO fork adding maps, WAIFs, tasks and more            |
| ToastStunt | Actively maintained Stunt fork; the common modern MOO server |
| mooR       | A from-scratch rewrite in Rust, compatible with LambdaMOO    |
| CoolMUD    | Early object-oriented server in the MOO tradition            |
| ColdMUD    | Object-oriented server with the ColdC language               |
| Genesis    | ColdMUD's successor (ColdC driver), usually run with ColdCore |

### MOO cores

A MOO is a server plus a core: the starting database that defines its
built-in commands, objects and in-world programs. Two MOOs on the same
server can behave very differently depending on their core, so a MOO is
really identified by the pair, for example "ToastStunt / JHCore". The core
decides things a client may care about, such as which commands exist (and
their names), how paging and channels work, and whether out-of-band
protocols like MCP are offered.

MSSP has no separate variable for the core, so it shows up, if at all,
inside `CODEBASE` (alongside the server or in place of it), or only in the
MOO's welcome banner or its in-world version command. Over time each MOO's
database drifts from its core, so a core name is a starting point, not a
guarantee.

| Core       | Notes                                                           |
| ---------- | --------------------------------------------------------------- |
| LambdaCore | Extracted from LambdaMOO itself; the classic default core       |
| JHCore     | From Jay's House MOO; LambdaCore-based, with its own commands    |
| enCore     | Educational core (enCore Xpress) with a web interface; LambdaCore-based |
| ToastCore  | The core distributed with ToastStunt                            |
| MinimalDB  | A bare database with almost nothing in it, for building from scratch |
| ColdCore   | Genesis's core (ColdC, not MOO code, but the same server/core split) |

There are others: many MOOs started from a local or community core, or
from a snapshot of another MOO's database, and report it under that name.

## MUSH, MUX and MUSE

| Codebase   | Notes                                                     |
| ---------- | --------------------------------------------------------- |
| TinyMUD    | The 1989 ancestor of the whole MUSH/MUCK/MOO "Tiny" family |
| TinyMUSH   | 2.x and the merged 3.x line                               |
| PennMUSH   | TinyMUSH 2.0 descendant; one of the most widely run today |
| TinyMUX    | TinyMUSH 2.x descendant; often reported as "MUX" or "MUX2" |
| RhostMUSH  | TinyMUSH 2.x descendant                                   |
| TinyMUSE   | Educational MUSE line ("MUSE")                            |
| TinyMARE   | "Tiny" family server of the MUSE era                      |
| AresMUSH   | Modern MUSH-style server in Ruby, with a web portal       |

## MUCK

| Codebase  | Notes                                                    |
| --------- | -------------------------------------------------------- |
| TinyMUCK  | TinyMUD descendant that added the MUF language           |
| Fuzzball  | The dominant MUCK server (FB6, FB7); also "fbmuck"       |
| ProtoMUCK | Fuzzball fork                                            |
| GlowMUCK  | Fuzzball fork                                            |

## DikuMUD family

| Codebase       | Notes                                                  |
| -------------- | ------------------------------------------------------ |
| DikuMUD        | The 1990 ancestor of the largest MUD family            |
| CircleMUD      | DikuMUD Gamma descendant                               |
| tbaMUD         | CircleMUD's maintained successor (The Builder Academy) |
| LuminariMUD    | tbaMUD descendant, D&D 3.5-style rules                 |
| SillyMUD       | Early DikuMUD descendant                               |
| Merc           | DikuMUD descendant (2.x); parent of ROM and Envy       |
| Envy           | Merc descendant                                        |
| ROM            | "Rivers of MUD", Merc descendant (2.4); very common    |
| QuickMUD       | Maintained ROM 2.4 distribution                        |
| ROT            | ROM descendant                                         |
| Dawn of Time   | ROM descendant                                         |
| 1stMUD         | ROM descendant                                         |
| Ack!MUD        | Merc descendant                                        |
| GodWars        | Merc descendant, player-versus-player focused          |
| Dystopia       | GodWars descendant                                     |
| EmberMUD       | Merc/ROM descendant                                    |
| SMAUG          | Merc descendant (from Realms of Despair)               |
| SmaugFUSS      | Maintained SMAUG ("Fixed Up SMAUG Source")             |
| AFKMud         | SMAUG descendant                                       |
| SWR            | "Star Wars Reality", SMAUG descendant                  |
| SWFOTE         | "Star Wars: Fall of the Empire", SWR descendant        |

## LPMud family

LP servers split into a driver (the server) and a mudlib (the game
framework), so `CODEBASE` may name either or both ("FluffOS / Dead Souls").

| Codebase    | Notes                                                  |
| ----------- | ------------------------------------------------------ |
| LPMud       | The original (Lars Pensjö); LPC language               |
| MudOS       | LPMud driver                                           |
| FluffOS     | MudOS descendant; the common modern LP driver          |
| LDMud       | Amylaar LPMud descendant ("Amylaar" is also seen)      |
| DGD         | Dworkin's Game Driver, a separate LPC driver           |
| Dead Souls  | Mudlib (Nightmare descendant)                          |
| Nightmare   | Mudlib                                                 |
| Lima        | Mudlib                                                 |
| TMI-2       | Mudlib                                                 |
| Discworld   | Mudlib (from the Discworld MUD)                        |

## AberMUD family

| Codebase       | Notes                                   |
| -------------- | --------------------------------------- |
| AberMUD        | The 1987 ancestor of this family        |
| DIRT           | AberMUD descendant                      |
| iDiRT          | DIRT descendant                         |

## Other and independent servers

| Codebase   | Notes                                                       |
| ---------- | ----------------------------------------------------------- |
| MUD1, MUD2 | The original Essex MUD and its successor (British Legends)  |
| Evennia    | Python framework for MUDs and MUSH-style games              |
| CoffeeMUD  | Java server                                                 |
| Ranvier    | Node.js server                                              |
| NakedMud   | C server with Python scripting                              |
| SocketMUD  | Minimal C base for building a server from scratch           |
| Mordor     | Independent C server from the early 1990s                   |
| Rapture    | Iron Realms Entertainment's proprietary engine (Achaea etc.) |
| SkotOS     | Skotos's game platform, built on DGD                        |
