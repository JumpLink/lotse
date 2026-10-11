/**
 * How `serve` reaches its person — the seam ADR 0002 §9 asks for.
 *
 * A task names a profile, the profile a user, and `serve` hands every message for that user to the
 * `ServeChannel` it was started with — one, or several combined (`combineChannels`). A task or profile
 * may narrow that to some channels and keep the question text off the messenger (`channels`,
 * `messengerDetail`); `routeChannels` applies it, by the `task` a message carries. The first channel is a desktop notification (the app's `desktop-notifier.ts`);
 * the messenger channel (`messenger/`) is a second implementation and changes no task.
 *
 * The interface is `send` only. An answer comes back by whatever the channel offers — a button on the
 * desktop notification, a reply the messenger's receive loop reads, or `lotse answer` — and every one
 * of them ends in the same `answerQuestion`, so the first answer wins and the others hear "answered".
 */

import type { ServeUser } from './config.ts';
import type { QuestionKind } from './questions.ts';

export interface ServeMessage {
  readonly title: string;
  readonly body: string;
  /** The question this message asks, so a channel with replies can thread the answer to it. */
  readonly questionId: string | null;
  /** The task the message is about, so a router can apply its `channels`. Absent: serve's own news. */
  readonly task?: string;
  /**
   * Set only on the message that asks the question, not on one that reports about it (expired), so a
   * channel with buttons offers them where an answer is still possible.
   */
  readonly asks?: QuestionKind;
  /**
   * The question's text without the `lotse answer …` hint that `body` ends with — for a channel whose
   * person answers in the channel itself and wants its own hint. Set on the message that asks.
   */
  readonly text?: string;
  /** When the question stops taking answers (ISO). Set on the message that asks. */
  readonly expiresAt?: string;
}

export interface ServeChannel {
  /** For the log: `desktop`, `stderr`, later `curlew`. */
  readonly name: string;
  send(user: ServeUser, message: ServeMessage): Promise<void> | void;
}
