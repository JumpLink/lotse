/**
 * Markdown as an XMPP chat shows it: XEP-0393 message styling, and images as their own messages.
 *
 * An agent answers in Markdown; a chat client renders none of it. XEP-0393 is what Conversations,
 * Gajim and Monocles understand: `*bold*`, `_italic_`, `` `code` ``, `> quote`, ``` fences. So
 * headings and `**x**` become `*x*`, `*x*` becomes `_x_`, list markers become "• ", and a link
 * `[t](url)` becomes "t: url" — the URL stays complete, because the client makes it clickable.
 *
 * A line that is only `![alt](https://…)` splits the message: the text before it, then the image,
 * then the rest, in order. The image is sent by the MCP server as its own message (curlew's
 * `image_url`); this module only cuts the text. Pure: no I/O, so it is tested without a server.
 */

export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly url: string; readonly alt: string };

/** Longest text chunk; curlew refuses more than 8000 characters per message. */
export const MAX_CHUNK_CHARS = 7000;

/** Images per message; further ones stay as plain links. */
export const MAX_IMAGES = 8;

const IMAGE_LINE = /^\s*!\[([^\]]*)\]\((https:\/\/(?:[^\s()]|\([^\s()]*\))+)\)\s*$/;
const IMAGE_INLINE = /!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;
/** Stands in for a finished bold marker, so the italic pass does not read it as `*x*`. */
const BOLD = '\uE000';
const LINK = /\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;

function linkText(label: string, url: string): string {
  const text = label.trim();
  return text === '' || text === url ? url : `${text}: ${url}`;
}

/** The inline Markdown of one line, outside code spans. */
function inline(line: string): string {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(IMAGE_INLINE, (_all, alt: string, url: string) => linkText(alt, url))
        .replace(LINK, (_all, label: string, url: string) => linkText(label, url))
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`)
        .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '_$1_')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~')
        .replaceAll(BOLD, '*');
    })
    .join('');
}

function styleLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    const title = inline(heading[1]!).replace(/^\*(.+)\*$/, '$1');
    return title === '' ? '' : `*${title}*`;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2]!)}`;
  const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
  if (quote) return `> ${inline(quote[1]!)}`;
  return inline(line);
}

/** Break `text` into chunks of at most `max` characters, preferably at blank lines, then newlines. */
function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') out.push(rest);
  return out.filter((part) => part !== '');
}

/** `markdown` as the messages to send, in order. `maxImages` is the cap per call. */
export function renderForXmpp(markdown: string, maxImages: number = MAX_IMAGES): Segment[] {
  const segments: Segment[] = [];
  let pending: string[] = [];
  let images = 0;
  let fence = false;

  const flush = () => {
    const text = pending
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    pending = [];
    for (const part of chunk(text, MAX_CHUNK_CHARS)) segments.push({ kind: 'text', text: part });
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      pending.push(line.trim());
      continue;
    }
    if (fence) {
      pending.push(line);
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      if (images < maxImages) {
        images += 1;
        flush();
        segments.push({ kind: 'image', url: image[2]!, alt: image[1]! });
      } else {
        pending.push(linkText(image[1]!, image[2]!));
      }
      continue;
    }
    pending.push(styleLine(line));
  }
  flush();
  return segments;
}
