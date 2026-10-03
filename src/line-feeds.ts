// How many line feeds xterm will perform for `data`: one per LF, VT or FF
// byte, which its parser all treat as a plain line feed (InputHandler maps
// C0.LF, C0.VT and C0.FF to lineFeed()), each firing onLineFeed exactly once.
//
// The timestamp machinery keeps one arrival time per line feed — in the
// scrollback buffer, the session log's sidecar and the renderer's stamp queue
// — and lines them up by counting, so all three must count the same way.
// (Bytes inside an OSC/DCS payload are counted too though xterm won't feed a
// line for them; MU* servers don't send those, so it isn't worth parsing for.)
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
