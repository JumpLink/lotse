/**
 * The fallback `QuestionChannel`: the message on stderr, which `journalctl --user -u lotsman-listen` shows.
 * Its own file, without GI, so `lotsman answer` and a session without a notification daemon can use it.
 */

import type { QuestionChannel } from '@lotsman/core';

export function stderrChannel(): QuestionChannel {
  return {
    name: 'stderr',
    send: (_user, message) => {
      process.stderr.write(`[${message.title}] ${message.body}\n`);
    },
  };
}
