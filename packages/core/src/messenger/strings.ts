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
  linkDown: 'The messenger connection is down; retrying in {seconds} s.',
} as const;
