/**
 * Every sentence the messenger channel says to its person, in one place.
 *
 * Each is marked `N_` for extraction and translated by `msg` (the `lotse` gettext domain), so a handler
 * never writes a sentence inline; the English text is the msgid. `{name}` marks a value to be filled in; the placeholder names are part of the msgid.
 */

import { _, N_ } from '../i18n.ts';

/** The msgid is the English text, translated when a translator is registered; `values` fill its `{placeholders}`. */
export function msg(msgid: string, values: Readonly<Record<string, string>> = {}): string {
  return _(msgid).replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export const STRINGS = {
  noQuestionOpen: N_('No question is waiting for an answer.'),
  severalOpen: N_(
    'Several questions are open: {ids}. Start your reply with the id, for example "{example}".',
  ),
  missingText: N_('Say what to answer after {id}, for example "{example}".'),
  commandFailed: N_('The command failed: {reason}'),
  answerFailed: N_('Could not apply the answer: {reason}'),
  replyHintPermission: N_('Reply: {id} yes or {id} no'),
  replyHintPerson: N_('Reply: {id} done'),
  replyHintReply: N_('Reply: {id} <your answer>'),
  validUntil: N_('Valid until {time}'),
  gotIt: N_('Got it, {id}.'),
  gotItRunFailed: N_(
    'Got it, {id}, but the run failed. `lotse questions` and the listen log have the details.',
  ),
  alreadySettled: N_('{id} is already {status}.'),
  noLongerWaiting: N_('{id} is no longer waiting for an answer.'),
  expiredAt: N_('{id} expired at {time}.'),
  retryDelivered: N_('{id} was not delivered at first; it is now.'),
  retryFailed: N_('{id} still not delivered ({reason}); will try again.'),
  retryGaveUp: N_('{id} not delivered ({reason}); giving up. `lotse questions` still lists it.'),
  noticeQuestion: N_(
    'A question is waiting in {task}. Its text is not sent to this chat: read it with `lotse questions` or on the desktop.',
  ),
  noticeMessage: N_('{task} has a message for you. Its text is not sent to this chat.'),
  notHere: N_('{id} is not answered in this chat. Use `lotse answer` or the desktop.'),
  linkDown: N_('The messenger connection is down; retrying in {seconds} s.'),
  askWhat: N_(
    'What should I do? Write it after {prefix}, for example "{prefix} what is on my calendar today".',
  ),
  requestQueued: N_('Busy with another request; yours is queued (position {position}).'),
  requestFailed: N_('The request failed. The listen log has the details.'),
  requestNoAnswer: N_('Done, but the agent gave no answer.'),
  followUpFresh: N_('That conversation could not be continued; this is a new one.'),
  followUpExpired: N_('More than {minutes} min since the last answer, so this is a new conversation.'),
  requestInterrupted: N_('Your last request was not completed (listen restarted). Please send it again.'),
  requestsInterrupted: N_('{count} requests were not completed (listen restarted). Please send them again.'),
  answerShortened: N_('[shortened, {count} more characters]'),
  answerPart: N_('({part}/{parts})'),
  personAsk: N_('I need you: {origin} wants {kind}.'),
  personLink: N_('Open or scan this: {link}'),
  personReplyCode: N_(
    'Reply "done" when you have done it yourself, or reply with the code and I will enter it.',
  ),
  personReplyDone: N_('Reply "done" when you are through.'),
  personCodeRefused: N_('{id} is no longer waiting for a code; reply "done" once you have done it yourself.'),
  personNeedsAnswer: N_('{id} needs "done"{orCode}.'),
} as const;
