/**
 * Reading a chat reply as an answer to a question — pure, no model.
 *
 * A reply names its question or it does not:
 *
 * - `A3 ja`, `#A3 ja`, `a3: only the first one` → question `A3`, the rest is the answer.
 * - Plain text with exactly one question open → that question.
 * - Plain text with several open → ambiguous: nothing is answered and the person is asked to name one.
 *
 * **A bare `A3` or `#A3` followed by words is an id; `a3` inside a sentence is not.** The id is read only
 * at the start, and without `#` only in lotse's own spelling (`A` and digits), so "A4 paper please" is
 * the one spelling that reads as an id when it was meant as text — a reply that opens with an id-looking
 * word is the price of not asking for `#` every time. The question it would name is then reported as
 * unknown or answered, never silently applied somewhere else.
 *
 * The words `answerQuestion` reads as yes or no (ja, nein, yes, no, allow, decline…) are
 * `parseAnswer`'s; this file only finds *which question* the text belongs to.
 */

import { formatQuestionId, type Question } from '../serve/questions.ts';

export type ReplyIntent =
  /** Answer `questionId` with `text`. */
  | { readonly kind: 'answer'; readonly questionId: string; readonly text: string }
  /** The text named a question but said nothing more. */
  | { readonly kind: 'missing-text'; readonly questionId: string }
  /** Plain text, and more than one question is open. */
  | { readonly kind: 'ambiguous'; readonly open: readonly string[] }
  /** Plain text, and nothing is open. */
  | { readonly kind: 'nothing-open' }
  /** Empty after trimming. */
  | { readonly kind: 'ignore' };

const LEADING_ID = /^(?:#([a-z]\d{1,6})|(a\d{1,6}))(?![\p{L}\p{N}_])[\s:,.\-–—]*([\s\S]*)$/iu;

/**
 * `open` are the ids of the questions that can still be answered, oldest first. `replyTarget` is the
 * question a message-reply reference (XEP-0461) points at, already looked up; it settles a tagless
 * reply even when several are open.
 */
export function parseReply(
  text: string,
  open: readonly string[],
  replyTarget: string | null = null,
): ReplyIntent {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'ignore' };
  const lead = LEADING_ID.exec(trimmed);
  if (lead) {
    const questionId = (lead[1] ?? lead[2])!.toUpperCase().replace(/^([A-Z])0*(\d)/, '$1$2');
    const rest = (lead[3] ?? '').trim();
    return rest === '' ? { kind: 'missing-text', questionId } : { kind: 'answer', questionId, text: rest };
  }
  if (replyTarget !== null && open.includes(replyTarget))
    return { kind: 'answer', questionId: replyTarget, text: trimmed };
  if (open.length === 0) return { kind: 'nothing-open' };
  if (open.length === 1) return { kind: 'answer', questionId: open[0]!, text: trimmed };
  return { kind: 'ambiguous', open };
}

/** The open questions' ids in the order they were asked, for the clarifying message. */
export function openIds(questions: readonly Question[]): string[] {
  return [...questions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((q) => q.id);
}

/** `A1, A2` → `#A1, #A2`. */
export function listIds(ids: readonly string[]): string {
  return ids.map(formatQuestionId).join(', ');
}

/**
 * The text of a message-reply without the quote the client put in front of it (XEP-0428 fallback):
 * leading lines that start with `>`, and the blank line after them. curlew already removes the range
 * the fallback element marks; this covers a server that does not. Text without a leading quote is
 * returned as it came, and a message that is only a quote stays as it is.
 */
export function stripQuote(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i += 1;
  if (i === 0) return text;
  const rest = lines.slice(i).join('\n').replace(/^\s*\n/, '');
  return rest.trim() === '' ? text : rest;
}
