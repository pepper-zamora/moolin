// Streaming parser from server text to styled runs and line breaks. It is not a
// terminal emulator: only SGR (colour and attributes) is acted on. Cursor
// movement, erase, modes, OSC strings and charset selects are consumed and
// dropped, so none of their payload leaks into the text.

// -1 is the default colour, 0-15 the palette, and 0x1000000 | 0xRRGGBB a
// 24-bit colour (256-colour indexes above 15 are converted to that).
const RGB_FLAG = 0x1000000;

export interface Style {
  readonly fg: number;
  readonly bg: number;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly inverse: boolean;
  // Equal styles have equal keys, so adjacent runs can be merged cheaply.
  readonly key: string;
}

type StyleFields = Omit<Style, "key">;

function makeStyle(fields: StyleFields): Style {
  const flags =
    (fields.bold ? 1 : 0) |
    (fields.dim ? 2 : 0) |
    (fields.italic ? 4 : 0) |
    (fields.underline ? 8 : 0) |
    (fields.strike ? 16 : 0) |
    (fields.inverse ? 32 : 0);
  return { ...fields, key: `${fields.fg}.${fields.bg}.${flags}` };
}

export const DEFAULT_STYLE: Style = makeStyle({
  fg: -1,
  bg: -1,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

export type Token = { kind: "text"; text: string; style: Style } | { kind: "newline" };

// The same bytes countLineFeeds counts (LF, VT, FF), and in every parser state,
// so the arrival time kept per line feed lines up with the lines however the
// escape sequences fall.
function isLineFeed(code: number): boolean {
  return code === 0x0a || code === 0x0b || code === 0x0c;
}

// An unterminated OSC/DCS string would otherwise swallow the output after it.
const MAX_STRING_LENGTH = 4096;
// Real colour sequences are a few dozen characters; a CSI that goes on past
// this is junk (or hostile), and is given up on rather than held in memory
// while it swallows everything after it.
const MAX_CSI_LENGTH = 256;

type State = "ground" | "esc" | "escIntermediate" | "csi" | "string" | "stringEsc";

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

function rgb(r: number, g: number, b: number): number {
  return RGB_FLAG | (clamp(r, 255) << 16) | (clamp(g, 255) << 8) | clamp(b, 255);
}

// xterm's 256-colour table past the 16 palette entries: a 6x6x6 cube, then greys.
function palette256(n: number): number {
  const index = clamp(n, 255);
  if (index < 16) return index;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgb(level, level, level);
  }
  const cube = index - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return rgb(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
}

export class AnsiParser {
  private style = DEFAULT_STYLE;
  private state: State = "ground";
  private csi = "";
  private stringLength = 0;
  private decoder = new TextDecoder();

  // Forgets style and any half-received sequence, e.g. on a new connection.
  reset(): void {
    this.style = DEFAULT_STYLE;
    this.state = "ground";
    this.csi = "";
    this.stringLength = 0;
    this.decoder = new TextDecoder();
  }

  // Bytes are decoded as a stream, so a multi-byte character split across
  // chunks comes out whole. Sequences split across chunks are held over.
  parse(data: string | Uint8Array): Token[] {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    const tokens: Token[] = [];
    let runStart = 0;
    const endRun = (end: number) => {
      if (end > runStart) tokens.push({ kind: "text", text: text.slice(runStart, end), style: this.style });
    };

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (isLineFeed(code)) {
        if (this.state === "ground") endRun(i);
        tokens.push({ kind: "newline" });
        runStart = i + 1;
        continue;
      }
      switch (this.state) {
        case "ground":
          if (code === 0x1b) {
            endRun(i);
            this.state = "esc";
            runStart = i + 1;
          } else if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
            // CR, BEL, BS and the other controls have nothing to do in a scrollback.
            endRun(i);
            runStart = i + 1;
          }
          break;
        case "esc":
          if (code === 0x5b) {
            this.state = "csi";
            this.csi = "";
          } else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
            this.state = "string"; // OSC, DCS, SOS, PM, APC
            this.stringLength = 0;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.state = "escIntermediate";
          } else if (code !== 0x1b) {
            this.state = "ground";
          }
          runStart = i + 1;
          break;
        case "escIntermediate":
          if (code >= 0x30 && code <= 0x7e) this.state = "ground";
          else if (code === 0x1b) this.state = "esc";
          runStart = i + 1;
          break;
        case "csi":
          if (code === 0x1b) {
            this.state = "esc";
          } else if (code >= 0x40 && code <= 0x7e) {
            if (code === 0x6d) this.sgr(this.csi);
            this.state = "ground";
          } else if (code >= 0x20 && code <= 0x3f) {
            this.csi += text[i];
            if (this.csi.length > MAX_CSI_LENGTH) this.state = "ground";
          }
          runStart = i + 1;
          break;
        case "string":
          if (code === 0x07) this.state = "ground";
          else if (code === 0x1b) this.state = "stringEsc";
          else if (++this.stringLength > MAX_STRING_LENGTH) this.state = "ground";
          runStart = i + 1;
          break;
        case "stringEsc":
          if (code === 0x5c)
            this.state = "ground"; // ST
          else if (code === 0x1b) this.state = "stringEsc";
          else this.state = "esc"; // a new sequence started instead; reprocess as its introducer
          if (this.state === "esc") i--;
          runStart = i + 1;
          break;
      }
    }
    if (this.state === "ground") endRun(text.length);
    return tokens;
  }

  private sgr(params: string): void {
    if (!/^[\d;:]*$/.test(params)) return; // a private-mode or intermediate form, not SGR
    const groups = params === "" ? [[0]] : params.split(";").map((g) => g.split(":").map((n) => Number(n) || 0));
    const next: { -readonly [K in keyof StyleFields]: StyleFields[K] } = { ...this.style };
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const n = group[0];
      if (n === 0) Object.assign(next, DEFAULT_STYLE);
      else if (n === 1) next.bold = true;
      else if (n === 2) next.dim = true;
      else if (n === 3) next.italic = true;
      else if (n === 4)
        next.underline = group[1] !== 0; // 4:0 is "no underline"
      else if (n === 7) next.inverse = true;
      else if (n === 9) next.strike = true;
      else if (n === 21) next.underline = true;
      else if (n === 22) next.bold = next.dim = false;
      else if (n === 23) next.italic = false;
      else if (n === 24) next.underline = false;
      else if (n === 27) next.inverse = false;
      else if (n === 29) next.strike = false;
      else if (n >= 30 && n <= 37) next.fg = n - 30;
      else if (n === 39) next.fg = -1;
      else if (n >= 40 && n <= 47) next.bg = n - 40;
      else if (n === 49) next.bg = -1;
      else if (n >= 90 && n <= 97) next.fg = n - 90 + 8;
      else if (n >= 100 && n <= 107) next.bg = n - 100 + 8;
      else if (n === 38 || n === 48) {
        let color: number | null = null;
        if (group.length > 1) {
          // Colon form: 38:5:n, 38:2:r:g:b, or 38:2:colourspace:r:g:b.
          if (group[1] === 5) color = palette256(group[2] ?? 0);
          else if (group[1] === 2) {
            const c = group.length >= 6 ? group.slice(3, 6) : group.slice(2, 5);
            color = rgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
          }
        } else {
          const mode = groups[i + 1]?.[0];
          if (mode === 5) {
            color = palette256(groups[i + 2]?.[0] ?? 0);
            i += 2;
          } else if (mode === 2) {
            color = rgb(groups[i + 2]?.[0] ?? 0, groups[i + 3]?.[0] ?? 0, groups[i + 4]?.[0] ?? 0);
            i += 4;
          }
        }
        if (color !== null) {
          if (n === 38) next.fg = color;
          else next.bg = color;
        }
      }
    }
    this.style = makeStyle(next);
  }
}

export interface Appearance {
  // Space-separated CSS classes (see styles.css) for the palette colours and attributes.
  className: string;
  // Inline CSS for 24-bit colours, which have no class.
  css: string;
}

// Keyed by style, and a style can carry any 24-bit colour, so a server could
// otherwise make this grow without end; past the cap it starts over.
const MAX_CACHED_APPEARANCES = 2048;
const appearances = new Map<string, Appearance>();

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

// How a style should look. Bold brightens the eight base foreground colours
// (as xterm did), and inverse swaps the two, with a default colour becoming
// the terminal's opposite one.
export function appearance(style: Style): Appearance {
  const cached = appearances.get(style.key);
  if (cached) return cached;
  let fg = style.fg;
  let bg = style.bg;
  if (style.bold && fg >= 0 && fg < 8) fg += 8;
  const classes: string[] = [];
  let css = "";
  const paint = (color: number, prefix: "f" | "b", defaultClass: string) => {
    if (color === -1) {
      if (style.inverse) classes.push(defaultClass);
    } else if (color & RGB_FLAG) {
      css += `${prefix === "f" ? "color" : "background-color"}:${hex(color)};`;
    } else {
      classes.push(`${prefix}${color}`);
    }
  };
  if (style.inverse) [fg, bg] = [bg, fg];
  paint(fg, "f", "fbg");
  paint(bg, "b", "bfg");
  if (style.bold) classes.push("bd");
  if (style.dim) classes.push("dm");
  if (style.italic) classes.push("it");
  if (style.underline) classes.push("ul");
  if (style.strike) classes.push("st");
  const result = { className: classes.join(" "), css };
  if (appearances.size >= MAX_CACHED_APPEARANCES) appearances.clear();
  appearances.set(style.key, result);
  return result;
}
