/**
 * What a text-to-speech engine should be given of an agent's Markdown (ADR 0009).
 *
 * A reply is written for the eye: code blocks, tables, link targets, emphasis marks, emoji. Read aloud
 * they are noise or worse, so `speakableText` keeps what a person would say and drops the rest. It does
 * **not** spell numbers out: the engines Lotse uses for German read digits themselves, and a second
 * verbaliser here would be a second opinion about "1.234,56".
 *
 * The result is plain text, one paragraph per line. Every paragraph ends in sentence punctuation, so a
 * heading or a list item that had none still lands as a sentence of its own.
 *
 * **Pure and platform-free.** No `gi://`, no `node:*`: it runs on GJS and on Node alike. Lotse's own
 * code-block placeholder is *not* translated here — a surface that wants one passes it in
 * (`codePlaceholder: _('Code omitted')`), so this file stays free of the catalogue.
 *
 * For a streamed reply use `sentenceChunker` (`sentence-chunker.ts`), which runs this on one sentence at
 * a time.
 */

export interface SpeakableOptions {
  /**
   * Spoken once in place of each code block. Absent: code is dropped without a trace. Pass an already
   * translated sentence — core holds no catalogue entry for it.
   */
  readonly codePlaceholder?: string;
  /**
   * Keep the lines Lotse renders for a tool call (`<title> — <status>`, `core/transcript.ts`). They are
   * dropped by default: a tool line is something to look at, and announcing one is the surface's job.
   */
  readonly keepToolLines?: boolean;
}

/** One tool line as the transcript writes it, or a bare status line. */
const TOOL_LINE = /(?:^|\s)—\s(?:pending|in_progress|completed|failed)\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
/** A line that opens a block of its own, whatever came before it. Also true of a partial line. */
const BLOCK_START = /^\s{0,3}#{1,6}\s|^\s*(?:[-*+]|\d{1,3}[.)])\s|^\s*\||^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;

/** Whether `line` starts a heading, list item, table row or rule. */
export function startsBlock(line: string): boolean {
  return BLOCK_START.test(line);
}

/**
 * Line-by-line tracking of what is code. Fenced blocks (``` or ~~~, closed by the same character and at
 * least as long) and indented blocks (four spaces or a tab after a blank line, never inside a list).
 * One instance per document; feed it every line in order.
 */
export class BlockState {
  #fence: { char: string; length: number } | null = null;
  #inList = false;
  #prevBlank = true;
  #prevCode = false;

  /** True while inside an unclosed fence. */
  get inFence(): boolean {
    return this.#fence !== null;
  }

  /** `code`: the line belongs to a code block. `opens`: it is the first line of that block. */
  next(line: string): { code: boolean; opens: boolean } {
    if (this.#fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closing && closing[0] === this.#fence.char && closing.length >= this.#fence.length) {
        this.#fence = null;
        this.#prevCode = false;
        this.#prevBlank = false;
      }
      return { code: true, opens: false };
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      this.#fence = { char: open[1]![0]!, length: open[1]!.length };
      return { code: true, opens: true };
    }
    if (line.trim() === '') {
      this.#prevBlank = true;
      return { code: false, opens: false };
    }
    const indented = /^(?: {4}|\t)/.test(line);
    if (indented && !this.#inList && (this.#prevBlank || this.#prevCode)) {
      const opens = !this.#prevCode;
      this.#prevCode = true;
      this.#prevBlank = false;
      return { code: true, opens };
    }
    this.#prevCode = false;
    this.#prevBlank = false;
    if (ITEM.test(line)) this.#inList = true;
    else if (!indented) this.#inList = false;
    return { code: false, opens: false };
  }
}

/** The text of one paragraph with Markdown's inline syntax taken out. */
function inline(text: string): string {
  return text
    .replace(/<https?:[^>\s]*>/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, '')
    .replace(/\bwww\.[^\s)>\]]+/g, '')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/(\*{1,3})(?=\S)([^*]*?\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([^_]*?\S)\1(?![\p{L}\p{N}_])/gu, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\]\([^)]*\)/g, '')
    .replace(/\*{1,3}|~~/g, '')
    .replace(EMOJI, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** Clean one paragraph, and make sure it ends like a sentence. Empty when nothing speakable is left. */
export function finishSentence(paragraph: string): string {
  const text = inline(paragraph);
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  return /[.!?…:;]["'”’»)\]]*$/u.test(text) ? text : `${text}.`;
}

/**
 * What one Markdown line (not code) is: `break` ends the paragraph and says nothing, `block` is a
 * one-line block of its own (heading, list item, table row — `text` is its content without the
 * marker), `text` continues the running paragraph.
 */
export type LineKind =
  | { readonly kind: 'break' }
  | { readonly kind: 'block'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

export function classifyLine(line: string, keepToolLines = false): LineKind {
  if (!keepToolLines && TOOL_LINE.test(line)) return { kind: 'break' };
  if (line.trim() === '' || RULE.test(line) || TABLE_RULE.test(line)) return { kind: 'break' };
  const heading = HEADING.exec(line);
  if (heading) return { kind: 'block', text: heading[1]! };
  if (TABLE_ROW.test(line)) {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '');
    return { kind: 'block', text: cells.join(', ') };
  }
  const item = ITEM.exec(line);
  if (item) return { kind: 'block', text: item[1]!.replace(/^\[[ xX]\]\s+/, '') };
  return { kind: 'text', text: line.replace(/^\s{0,3}(?:>\s?)+/, '') };
}

/**
 * Markdown lines (none of them code) as speakable paragraphs. Shared by `speakableText` and the
 * chunker, which has already decided what is code.
 */
export function speakParagraphs(lines: readonly string[], opts: SpeakableOptions = {}): string[] {
  const paragraphs: string[] = [];
  let run: string[] = [];
  const close = () => {
    if (run.length > 0) paragraphs.push(run.join(' '));
    run = [];
  };
  for (const line of lines) {
    const kind = classifyLine(line, opts.keepToolLines);
    if (kind.kind === 'break') close();
    else if (kind.kind === 'block') {
      close();
      paragraphs.push(kind.text);
    } else run.push(kind.text);
  }
  close();
  return paragraphs.map(finishSentence).filter((paragraph) => paragraph !== '');
}

/**
 * Markdown in, plain text for a TTS out.
 *
 * - fenced and indented code blocks are dropped (or replaced by `codePlaceholder`);
 * - tool lines are dropped (`keepToolLines`);
 * - links keep their text and lose the URL, bare URLs go, images keep their alt text;
 * - headings, list markers, quotes, emphasis and inline-code ticks are removed, a table row becomes its
 *   cells joined by commas, rules and table separators disappear;
 * - emoji go, whitespace collapses; paragraphs are separated by one newline.
 */
export function speakableText(markdown: string, opts: SpeakableOptions = {}): string {
  const blocks = new BlockState();
  const out: string[] = [];
  let run: string[] = [];
  const close = () => {
    out.push(...speakParagraphs(run, opts));
    run = [];
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const { code, opens } = blocks.next(line);
    if (!code) {
      run.push(line);
      continue;
    }
    if (opens) {
      close();
      if (opts.codePlaceholder) out.push(...speakParagraphs([opts.codePlaceholder]));
    }
  }
  close();
  return out.join('\n');
}
