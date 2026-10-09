// How many line breaks the scrollback makes for `data`: one per LF, VT or FF
// byte (the parser in ansi-parser.ts treats all three as a plain line feed,
// and CR as nothing).
//
// The timestamp machinery keeps one arrival time per line feed — in the
// scrollback buffer, the session log's sidecar and the renderer's lines — and
// lines them up by counting, so all three must count the same way. The parser
// makes a break for every such byte in whatever state it is in, even inside an
// escape sequence, so the count stays right without parsing here.
export function countLineFeeds(data: string | Uint8Array): number {
  let count = 0;
  if (typeof data === "string") {
    for (let i = 0; i < data.length; i++) if (isLineFeed(data.charCodeAt(i))) count++;
  } else {
    for (let i = 0; i < data.length; i++) if (isLineFeed(data[i])) count++;
  }
  return count;
}

function isLineFeed(code: number): boolean {
  return code === 0x0a || code === 0x0b || code === 0x0c;
}
