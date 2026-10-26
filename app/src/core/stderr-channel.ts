/**
 * The fallback `QuestionChannel`: the message on stderr, which `journalctl --user -u lotse-listen` shows.
 * Its own file, without GI, so `lotse answer` and a session without a notification daemon can use it.
 */

import type { QuestionChannel } from '@lotse/core';

export function stderrChannel(): QuestionChannel {
  return {
    name: 'stderr',
    send: (_user, message) => {
      process.stderr.write(`[${message.title}] ${message.body}\n`);
    },
  };
}
