/**
 * Every sentence the messenger channel says to its person, in one place.
 *
 * lotse has no translation catalogue yet (every app of the suite is meant to be multilingual: gettext,
 * English msgids, a German catalogue). Until it does, a string that is written inline in a handler is a
 * string somebody has to find again — so these are all here, each through `msg`, and the English text is
 * the msgid. Switching on gettext is then this one function and a catalogue, not a hunt through the
 * channel. `{name}` marks a value to be filled in; the placeholder names are part of the msgid.
 */

/** The msgid is the English text; `values` fill its `{placeholders}`. Identity apart from that. */
export function msg(msgid: string, values: Readonly<Record<string, string>> = {}): string {
  return msgid.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export const STRINGS = {
  noQuestionOpen: 'No question is waiting for an answer.',
  severalOpen: 'Several questions are open: {ids}. Start your reply with the id, for example "{example}".',
  missingText: 'Say what to answer after {id}, for example "{example}".',
  answerFailed: 'Could not apply the answer: {reason}',
  replyHintPermission: 'Reply: {id} yes or {id} no',
  replyHintReply: 'Reply: {id} <your answer>',
  validUntil: 'Valid until {time}',
  gotIt: 'Got it, {id}.',
  gotItRunFailed: 'Got it, {id}, but the run failed. `lotse questions` and the serve log have the details.',
  alreadySettled: '{id} is already {status}.',
  noLongerWaiting: '{id} is no longer waiting for an answer.',
  expiredAt: '{id} expired at {time}.',
  retryDelivered: '{id} was not delivered at first; it is now.',
  retryFailed: '{id} still not delivered ({reason}); will try again.',
  retryGaveUp: '{id} not delivered ({reason}); giving up. `lotse questions` still lists it.',
  noticeQuestion:
    'A question is waiting in {task}. Its text is not sent to this chat: read it with `lotse questions` or on the desktop.',
  noticeMessage: '{task} has a message for you. Its text is not sent to this chat.',
  notHere: '{id} is not answered in this chat. Use `lotse answer` or the desktop.',
  linkDown: 'The messenger connection is down; retrying in {seconds} s.',
  askWhat: 'What should I do? Write it after {prefix}, for example "{prefix} what is on my calendar today".',
  requestQueued: 'Busy with another request; yours is queued (position {position}).',
  requestFailed: 'The request failed. The serve log has the details.',
  requestNoAnswer: 'Done, but the agent gave no answer.',
  followUpFresh: 'That conversation could not be continued; this is a new one.',
  followUpExpired: 'More than {minutes} min since the last answer, so this is a new conversation.',
  answerShortened: '[shortened, {count} more characters]',
  answerPart: '({part}/{parts})',
} as const;
