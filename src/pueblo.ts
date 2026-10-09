// Pueblo, the HTML-flavoured protocol some MUSHes and MOOs speak: after the
// server's greeting, the text carries a few tags for clickable links, line
// breaks and clearing the screen. Only those are supported; every other tag is
// dropped and its content shown as plain text.
//
// The parser works on text that has already been split at line feeds (see
// ScrollbackView), and it keeps one invariant: LF, VT and FF characters in its
// output come only from the input outside tags, and each one that is swallowed
// is reported (as a "skip" token), so the arrival time kept per line feed
// stays lined up with the lines.

export interface PuebloLink {
  // Unique per link opened, so the pieces of one link can be told apart from
  // an adjacent one.
  id: number;
  // The command to send when clicked. "" means the link's own text is the
  // command (a bare <send>); null means it isn't a command link.
  cmd: string | null;
  // The address to open when clicked (a link with no command).
  href: string | null;
}

export type PuebloToken =
  | { kind: "text"; text: string }
  // <br>: a line break that has no line feed byte behind it.
  | { kind: "break" }
  // A line feed that was swallowed (so it makes no second break): directly
  // after a <br> when `afterBreak`, which then takes that line feed's time.
  | { kind: "skip"; afterBreak: boolean }
  // A link opens (given), or the open one closes (null).
  | { kind: "link"; link: PuebloLink | null }
  | { kind: "clear" };

const GREETING = /This world is Pueblo/i;
const GREETING_TAIL = 64;

// Finds the server's greeting ("This world is Pueblo 1.0 Enhanced"), even when
// it arrives split across chunks. Also used by main, which answers it.
export class GreetingDetector {
  private tail = "";

  reset(): void {
    this.tail = "";
  }

  // Whether `text` (continuing what came before) would complete the greeting,
  // without remembering it.
  test(text: string): boolean {
    return GREETING.test(this.tail + text);
  }

  // Remembers `text` and returns the index just past the greeting within it,
  // or -1 if it hasn't been seen.
  feed(text: string): number {
    const joined = this.tail + text;
    const match = GREETING.exec(joined);
    this.tail = joined.slice(-GREETING_TAIL);
    if (!match) return -1;
    this.tail = "";
    return Math.max(0, match.index + match[0].length - (joined.length - text.length));
  }
}

// Whether `text` contains the greeting whole.
export function hasGreeting(text: string): boolean {
  return GREETING.test(text);
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

// Decodes character references. One for a control character (which could be a
// line feed, or an escape that starts a sequence) is dropped instead.
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code =
      name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const surrogate = code >= 0xd800 && code <= 0xdfff;
    return control || surrogate || code > 0x10ffff ? "" : String.fromCodePoint(code);
  });
}

// The tags HTML and Pueblo have, which are markup when they appear. Anything
// else in angle brackets is just text that happens to look like a tag — a
// "<name>" in a help message, or an exit called "<O>" — and is shown as sent,
// since servers don't always escape the "<" in what they print. Names starting
// "xch_" are Pueblo's own.
const KNOWN_TAGS = new Set(
  (
    "a abbr address area b base big blockquote body br button caption center cite code col colgroup dd del dfn " +
    "dir div dl dt em embed fieldset font form frame frameset h1 h2 h3 h4 h5 h6 head hr html i iframe img input ins " +
    "kbd label legend li link map menu meta noframes noscript object ol optgroup option p param pre q s samp " +
    "script select send small span strike strong style sub sup table tbody td textarea tfoot th thead title tr tt " +
    "u ul var"
  ).split(" "),
);

function isKnownTag(name: string): boolean {
  return KNOWN_TAGS.has(name) || name.startsWith("xch_");
}

// A tag has no line break inside it, so splitting text at line feeds can't cut one.
const TAG = /<(\/?)([a-z][\w-]*)((?:"[^"\r\n]*"|'[^'\r\n]*'|[^>"'\r\n])*)>/gi;
const PARTIAL_TAG = /<\/?[a-z][^<>\r\n]*$/i;
const ATTRIBUTE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
// A tag that has not closed after this much is text, not a tag.
const MAX_TAG_LENGTH = 4096;
// Only so many tag names are reported through `onNote`: a server can make up
// names (anything starting "xch_" counts as a tag), and each is remembered.
const MAX_NOTED = 200;

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

export class PuebloParser {
  enabled = false;
  // Whether the server's greeting still counts. It only does until the first
  // line is sent to the server (see ConnectionManager); after that, a player
  // saying the words can't switch Pueblo on and so make their text clickable.
  detecting = true;
  // Tag names already reported through `onNote`, so each is mentioned once.
  private readonly noted = new Set<string>();
  private readonly greeting = new GreetingDetector();
  // The start of a tag cut off by the end of the last chunk.
  private held = "";
  // The last thing was a <br>, so a line feed next is the same break again.
  private afterBreak = false;
  private nextLinkId = 1;

  // `onNote` is told, once per tag name, about tags that aren't acted on: for
  // diagnosing a server whose output looks wrong.
  constructor(private readonly onNote: (message: string) => void = () => {}) {}

  private note(name: string, message: string): void {
    if (this.noted.has(name) || this.noted.size >= MAX_NOTED) return;
    this.noted.add(name);
    this.onNote(message);
  }

  // Forgets everything, including that Pueblo was ever enabled.
  reset(): void {
    this.noted.clear();
    this.enabled = false;
    this.detecting = true;
    this.greeting.reset();
    this.held = "";
    this.afterBreak = false;
  }

  // Sets the mode directly (a replay says whether the connection is in it).
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.greeting.reset();
    this.held = "";
    this.afterBreak = false;
  }

  // Whether `text` would switch Pueblo on.
  wouldEnable(text: string): boolean {
    return !this.enabled && this.detecting && this.greeting.test(text);
  }

  // Notes text that passed through unparsed, so a greeting split across it and
  // the next chunk is still found.
  noteText(text: string): void {
    if (!this.enabled && this.detecting) this.greeting.feed(text);
  }

  parse(chunk: string): PuebloToken[] {
    if (!this.enabled) {
      if (!this.detecting) return [{ kind: "text", text: chunk }];
      const end = this.greeting.feed(chunk);
      if (end < 0) return [{ kind: "text", text: chunk }];
      // The greeting is shown as it came; what follows it is Pueblo.
      this.enabled = true;
      this.onNote("the server's greeting was seen, so its tags are now read");
      const rest = this.parseEnabled(chunk.slice(end));
      return end > 0 ? [{ kind: "text", text: chunk.slice(0, end) }, ...rest] : rest;
    }
    return this.parseEnabled(chunk);
  }

  private parseEnabled(chunk: string): PuebloToken[] {
    let source = this.held + chunk;
    this.held = "";
    const partial = PARTIAL_TAG.exec(source);
    if (partial && source.length - partial.index < MAX_TAG_LENGTH) {
      this.held = source.slice(partial.index);
      source = source.slice(0, partial.index);
    }

    const out: PuebloToken[] = [];
    const text = (raw: string) => {
      let rest = raw;
      if (this.afterBreak && rest !== "") {
        const feed = /^\r?\n/.exec(rest);
        if (feed) {
          out.push({ kind: "skip", afterBreak: true });
          rest = rest.slice(feed[0].length);
        }
      }
      if (rest !== "") {
        this.afterBreak = false;
        out.push({ kind: "text", text: decodeEntities(rest) });
      }
    };

    let last = 0;
    for (const match of source.matchAll(TAG)) {
      const name = match[2].toLowerCase();
      if (!isKnownTag(name)) {
        // Not markup: left in the text, to be shown as sent.
        this.note(name, `<${name}> is not a Pueblo or HTML tag, so it is shown as text`);
        continue;
      }
      text(source.slice(last, match.index));
      last = match.index + match[0].length;
      const closing = match[1] === "/";
      if (name === "br") {
        out.push({ kind: "break" });
        this.afterBreak = true;
      } else if (name === "xch_page") {
        const clear = attributes(match[3]).clear?.toLowerCase();
        if (clear === "text" || clear === "all") out.push({ kind: "clear" });
      } else if (name === "a" || name === "send") {
        out.push({ kind: "link", link: closing ? null : this.openLink(name, attributes(match[3])) });
      } else if (name !== "xch_mudtext") {
        // (Pueblo's wrapper around ordinary text; nothing to say about it.)
        this.note(name, `<${name}> is not supported, so it is dropped (its content is still shown)`);
      }
    }
    text(source.slice(last));
    return out;
  }

  private openLink(name: string, attrs: Record<string, string>): PuebloLink | null {
    const id = this.nextLinkId++;
    if (name === "send") return { id, cmd: attrs.href ?? attrs.xch_cmd ?? "", href: null };
    if (attrs.xch_cmd !== undefined) return { id, cmd: attrs.xch_cmd, href: null };
    if (attrs.href !== undefined) return { id, cmd: null, href: attrs.href };
    return null; // an anchor with a name, say: nothing to click
  }
}

// The commands a link offers: a command link may hold several, separated by
// "|", and a bare <send> sends its own text. Control characters are dropped,
// so a link can't smuggle in a second line.
export function linkCommands(cmd: string, text: string): string[] {
  return (cmd === "" ? text : cmd)
    .split("|")
    .map((command) => command.replace(/[\x00-\x1f\x7f]/g, "").trim())
    .filter((command) => command !== "");
}
