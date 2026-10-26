/**
 * Streamed Markdown in, speakable sentences out (ADR 0009).
 *
 * An agent streams a reply as small text deltas; a TTS wants whole sentences, spoken as soon as they
 * are complete. `sentenceChunker()` is the bridge, and it is the **whole pipeline**, not a piece of
 * one:
 *
 * ```ts
 * const chunker = sentenceChunker();
 * for await (const delta of agentMessageChunks) for (const sentence of chunker.feed(delta)) speak(sentence);
 * for (const sentence of chunker.flush()) speak(sentence);
 * ```
 *
 * Every string it returns has already been through the same cleaning as `speakableText`, so a surface
 * never calls both on one reply: `speakableText` for a finished text, the chunker for a stream.
 *
 * What it will not do:
 *
 * - **Split inside an unfinished code fence.** Lines are classified only once complete, a fence that
 *   is still open swallows everything up to its closing line, and a partial line that might become
 *   a fence is held back.
 * - **Split on a period that is not a sentence end.** Abbreviations (`z. B.`, `ca.`, `Nr.`), ordinals
 *   (`15. März`, `3. um 10 Uhr`), versions (`0.5.1`), decimals and paths (`1.234,56`,
 *   `docs/voice/a.md`) stay in one sentence. A period at the very end of the buffer is not confirmed
 *   until the next word has arrived, because `1.` may still become `1.234`.
 * - **Wait forever.** A sentence that runs past `maxLength` without a boundary is cut at its last
 *   comma or space.
 *
 * Pure and platform-free, like `speakable.ts` whose line rules it shares.
 */

import {
  BlockState,
  classifyLine,
  finishSentence,
  speakParagraphs,
  type SpeakableOptions,
} from './speakable.ts';

export interface SentenceChunkerOptions extends SpeakableOptions {
  /** A sentence without a boundary is cut at a comma or space once it is this long. Default 300. */
  readonly maxLength?: number;
}

const TERMINATORS = '.!?…';
const CLOSERS = '"\'”’»)]';

/** Lowercase, without the period. German first; the English ones turn up in agent replies too. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'ca',
  'nr',
  'bzw',
  'usw',
  'etc',
  'vgl',
  'evtl',
  'ggf',
  'dr',
  'prof',
  'abb',
  'tel',
  'std',
  'max',
  'min',
  'inkl',
  'zzgl',
  'mio',
  'mrd',
  'bspw',
  'sog',
  'str',
  'ebd',
  'vs',
  'approx',
  'cf',
  'mr',
  'mrs',
  'ms',
  'fig',
  'no',
  'jh',
  'ff',
  'anm',
  'bd',
  'hrsg',
  'kap',
  'abs',
  'art',
  'ca',
  'engl',
  'dt',
  'ev',
  'geb',
]);

const MONTHS: ReadonlySet<string> = new Set([
  'januar',
  'februar',
  'märz',
  'maerz',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'dezember',
]);

/** A word the period belongs to is not a sentence end when the word is one of these. */
function isNotAnEnd(word: string, next: string): boolean {
  const bare = word.replace(/^[("'„“«[]+/u, '');
  if (bare === '') return false;
  if (/^\p{L}$/u.test(bare)) return true;
  if (ABBREVIATIONS.has(bare.toLowerCase())) return true;
  if (/^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u.test(bare)) return true;
  if (/^\d{1,2}(?:\.\d{1,2})?$/.test(bare)) {
    const first = next.replace(/^[("'„“«[]+/u, '');
    return MONTHS.has(first.toLowerCase()) || /^\p{Ll}/u.test(first);
  }
  return false;
}

/**
 * The index just after the first confirmed sentence end in `text`, or -1. `final` says no more text is
 * coming, so an end that touches the end of `text` counts.
 */
function findBoundary(text: string, final: boolean): number {
  for (let i = 0; i < text.length; i++) {
    if (!TERMINATORS.includes(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && (TERMINATORS.includes(text[end]!) || CLOSERS.includes(text[end]!))) end++;
    if (end >= text.length) return final ? text.length : -1;
    if (!/\s/.test(text[end]!)) {
      i = end - 1;
      continue;
    }
    if (text[i] === '.' && end === i + 1) {
      let rest = end;
      while (rest < text.length && /\s/.test(text[rest]!)) rest++;
      let nextEnd = rest;
      while (nextEnd < text.length && !/\s/.test(text[nextEnd]!)) nextEnd++;
      const wordStart = Math.max(text.lastIndexOf(' ', i), text.lastIndexOf('\n', i)) + 1;
      const word = text.slice(wordStart, i);
      // Only an ordinal ("15. März") depends on the word after it; wait for that one to be whole.
      if (
        nextEnd >= text.length &&
        !final &&
        /^\d{1,2}(?:\.\d{1,2})?$/.test(word.replace(/^[("'„“«[]+/u, ''))
      ) {
        return -1;
      }
      if (isNotAnEnd(word, text.slice(rest, nextEnd))) {
        i = end - 1;
        continue;
      }
    }
    return end;
  }
  return -1;
}

export class SentenceChunker {
  readonly #opts: SentenceChunkerOptions;
  readonly #max: number;
  #blocks = new BlockState();
  /** Text of the current paragraph, block markers already taken off, not yet spoken. */
  #segment = '';
  /** The unfinished last line. */
  #partial = '';
  /** The line in progress was committed to `#segment` in part; its rest is appended as it comes. */
  #midLine = false;
  #out: string[] = [];

  constructor(opts: SentenceChunkerOptions = {}) {
    this.#opts = opts;
    this.#max = opts.maxLength ?? 300;
  }

  /** Add streamed text; get back the sentences that are now complete, in order. */
  feed(delta: string): string[] {
    let text = delta.replace(/\r\n?/g, '\n');
    if (this.#midLine) {
      const newline = text.indexOf('\n');
      if (newline < 0) {
        this.#segment += text;
        this.#ready(false);
        return this.#take();
      }
      this.#segment += text.slice(0, newline);
      this.#midLine = false;
      text = text.slice(newline + 1);
      this.#ready(false);
    }
    const lines = (this.#partial + text).split('\n');
    this.#partial = lines.pop()!;
    for (const line of lines) this.#line(line);
    this.#provisional();
    return this.#take();
  }

  /** The text is over: speak whatever is left, and start fresh. */
  flush(): string[] {
    if (this.#partial !== '' && !this.#blocks.inFence) this.#line(this.#partial);
    this.#partial = '';
    this.#midLine = false;
    this.#close();
    this.#blocks = new BlockState();
    return this.#take();
  }

  #take(): string[] {
    const out = this.#out;
    this.#out = [];
    return out;
  }

  /** One complete line. */
  #line(line: string): void {
    const { code, opens } = this.#blocks.next(line);
    if (code) {
      if (opens) {
        this.#close();
        if (this.#opts.codePlaceholder) this.#out.push(...speakParagraphs([this.#opts.codePlaceholder]));
      }
      return;
    }
    const kind = classifyLine(line, this.#opts.keepToolLines);
    if (kind.kind === 'break') {
      this.#close();
    } else if (kind.kind === 'block') {
      this.#close();
      this.#segment = kind.text;
      this.#close();
    } else {
      this.#segment = this.#segment === '' ? kind.text : `${this.#segment} ${kind.text}`;
      this.#ready(false);
    }
  }

  /** The unfinished line may already hold a whole sentence: speak it, and carry on mid-line. */
  #provisional(): void {
    const partial = this.#partial;
    if (this.#blocks.inFence || partial.trim() === '') return;
    if (/^(?: {4}|\t)/.test(partial) || /^\s{0,3}(?:`{3,}|~{3,})/.test(partial)) return;
    if (/^\s{0,3}(?:`{1,2}|~{1,2})$/.test(partial)) return;
    const kind = classifyLine(partial, this.#opts.keepToolLines);
    if (kind.kind !== 'text') return;
    const joined = this.#segment === '' ? kind.text : `${this.#segment} ${kind.text}`;
    if (findBoundary(joined, false) < 0) return;
    this.#segment = joined;
    this.#partial = '';
    this.#midLine = true;
    this.#ready(false);
  }

  /** Speak every confirmed sentence of the segment. */
  #ready(final: boolean): void {
    for (;;) {
      const end = findBoundary(this.#segment, final);
      if (end < 0) break;
      this.#push(this.#segment.slice(0, end));
      this.#segment = this.#segment.slice(end).trimStart();
    }
    while (!final && this.#segment.length > this.#max) {
      const cut = this.#cutPoint();
      this.#push(this.#segment.slice(0, cut));
      this.#segment = this.#segment.slice(cut).trimStart();
    }
  }

  /** End of paragraph: nothing more will join the segment. */
  #close(): void {
    this.#ready(true);
    if (this.#segment !== '') this.#push(this.#segment);
    this.#segment = '';
  }

  #cutPoint(): number {
    const head = this.#segment.slice(0, this.#max);
    const comma = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (comma > this.#max / 3) return comma + 1;
    const space = head.lastIndexOf(' ');
    return space > 0 ? space : this.#max;
  }

  #push(raw: string): void {
    const sentence = finishSentence(raw);
    if (sentence !== '') this.#out.push(sentence);
  }
}

/** A chunker for one reply. `feed` the deltas, `flush` at the end; see the file comment. */
export function sentenceChunker(opts: SentenceChunkerOptions = {}): SentenceChunker {
  return new SentenceChunker(opts);
}
