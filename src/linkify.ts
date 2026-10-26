export interface Segment {
  text: string;
  // Set on the parts of the text that are a web address.
  url?: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

// Punctuation that ends a sentence rather than an address.
const TRAILING = /[.,;:!?'"]$/;

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

// Cuts trailing punctuation off a match, and a closing bracket only when it
// has no opener inside the address (so "(see http://x.com)" loses its ")" but
// "http://en.wikipedia.org/wiki/Foo_(bar)" keeps it).
function trimUrl(url: string): string {
  let end = url;
  for (;;) {
    const last = end[end.length - 1];
    if (TRAILING.test(end)) {
      end = end.slice(0, -1);
    } else if (last in PAIRS) {
      const opens = end.split(PAIRS[last]).length - 1;
      const closes = end.split(last).length - 1;
      if (closes <= opens) break;
      end = end.slice(0, -1);
    } else {
      break;
    }
  }
  return end;
}

// Splits text into plain parts and http(s) addresses. Always returns at least
// one segment for non-empty text.
export function linkify(text: string): Segment[] {
  if (!text.includes("://")) return [{ text }];
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (/^https?:\/\/$/i.test(url)) continue; // punctuation was all that followed the scheme
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    segments.push({ text: url, url });
    last = match.index + url.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.length > 0 ? segments : [{ text }];
}
