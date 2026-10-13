/**
 * What the answer window shows for one question, decided without a widget — the window
 * (`frontends/gui/answer-window.ts`) renders it. Fixed English, no `Intl`, like the rest of the app.
 *
 * A permission question gets its two quick replies and no text field: `answerQuestion` takes only yes
 * or no for it. A reply question gets the text field, because its answer is the person's own words.
 * A question that is not open shows why, and nothing that sends.
 */

import { _, fmt } from '../i18n.ts';
import { formatQuestionId, isOpen, normalizeQuestionId, quickReplies, type Question } from '@lotse/core';

import { quickReplyLabel, type QuickReply } from './question-actions.ts';

export interface AnswerButton {
  readonly text: QuickReply;
  readonly label: string;
  /** Styled as the suggested action. Never the focus: the window focuses the question. */
  readonly suggested: boolean;
}

export interface AnswerView {
  readonly title: string;
  readonly subtitle: string;
  readonly text: string;
  readonly expiry: string;
  /** A text field and a Send button. */
  readonly entry: boolean;
  readonly quickReplies: readonly AnswerButton[];
  /** Why there is nothing to answer; `null` while the question is open. */
  readonly closed: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `18:40`, or `2026-10-12 18:40` when it is not today — local time. */
function clock(at: Date, now: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** `in 3 h 20 min`, `in 5 min`, `in under a minute`. */
export function timeLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return _('in under a minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return fmt(_('in {minutes} min'), { minutes: rest });
  return rest === 0
    ? fmt(_('in {hours} h'), { hours })
    : fmt(_('in {hours} h {minutes} min'), { hours, minutes: rest });
}

/** `Expires at 18:40, in 3 h 20 min`, or when it expired. */
export function describeExpiry(expiresAt: string, now: Date): string {
  const at = new Date(expiresAt);
  const left = at.getTime() - now.getTime();
  if (Number.isNaN(left)) return _('Expiry unknown');
  return left <= 0
    ? fmt(_('Expired at {time}'), { time: clock(at, now) })
    : fmt(_('Expires at {time}, {left}'), { time: clock(at, now), left: timeLeft(left) });
}

function closedReason(question: Question): string {
  const label = formatQuestionId(question.id);
  if (question.status === 'open')
    return fmt(_('{label} has expired; nothing waits for an answer any more.'), { label });
  const how = question.resolution ? ` (${question.resolution})` : '';
  return fmt(_('{label} is {status}{how}; nothing waits for an answer any more.'), {
    label,
    status: question.status,
    how,
  });
}

export function answerView(question: Question | null, idText: string, now: Date): AnswerView {
  if (!question) {
    const label = formatQuestionId(normalizeQuestionId(idText) ?? idText.replace(/^#/, ''));
    return {
      title: fmt(_('Question {label}'), { label }),
      subtitle: '',
      text: '',
      expiry: '',
      entry: false,
      quickReplies: [],
      closed: fmt(_('There is no question {label}. `lotse questions` lists the open ones.'), { label }),
    };
  }
  const open = isOpen(question, now);
  return {
    title: fmt(_('Question {label}'), { label: formatQuestionId(question.id) }),
    subtitle: fmt(_('from task {task}'), { task: question.task }),
    text: question.text,
    expiry: describeExpiry(question.expiresAt, now),
    entry: open && question.kind === 'reply',
    // The suggested button last: GNOME puts the affirmative action at the end of a row.
    quickReplies: open
      ? quickReplies(question.kind)
          .map((text) => ({
            text,
            label: quickReplyLabel(text, question.kind),
            suggested: question.kind === 'permission' && text === 'yes',
          }))
          .sort((a, b) => Number(a.suggested) - Number(b.suggested))
      : [],
    closed: open ? null : closedReason(question),
  };
}
