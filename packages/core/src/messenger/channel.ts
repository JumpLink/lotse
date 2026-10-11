/**
 * The messenger as a `ServeChannel`: a question goes to the person as one chat message, through the
 * configured MCP server's send tool. The answers come back through `receive.ts`.
 *
 * The message carries the question id in its first line ("lotse · task · #A3") and says how to reply,
 * because the person answers in the chat and the id is how the reply finds its question.
 */

import type { ServeChannel, ServeMessage } from '../serve/channel.ts';
import type { ServeUser } from '../serve/config.ts';
import { formatQuestionId } from '../serve/questions.ts';
import { McpLink } from './link.ts';
import type { MessengerSettings } from './settings.ts';
import { STRINGS, msg } from './strings.ts';

/** The text of `message` as one chat message. */
export function messengerText(message: ServeMessage): string {
  const parts = [message.title, message.text ?? message.body];
  if (message.asks && message.questionId) {
    const id = formatQuestionId(message.questionId);
    parts.push(
      msg(message.asks === 'permission' ? STRINGS.replyHintPermission : STRINGS.replyHintReply, { id }),
    );
    if (message.expiresAt) parts.push(msg(STRINGS.validUntil, { time: message.expiresAt }));
  }
  return parts.join('\n\n');
}

/** Send `text` to the configured peer. */
export async function sendToPeer(link: McpLink, settings: MessengerSettings, text: string): Promise<void> {
  await link.use((tools) =>
    tools.call(settings.sendTool, { account: settings.account, to: settings.peer, text }),
  );
}

/** A question message that did not reach the chat, kept in memory until it does or stops being open. */
interface Unsent {
  readonly user: ServeUser;
  readonly message: ServeMessage;
  attempts: number;
  due: number;
}

export interface MessengerChannelOptions {
  /** The clock for the retry delays. Default `Date.now`. */
  readonly now?: () => number;
  /** Delay before retry n (0-based); there are as many retries as entries. Default 30 s … 10 min. */
  readonly retryDelaysMs?: readonly number[];
}

export const RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];

export interface MessengerChannel extends ServeChannel {
  /**
   * Send again the questions that failed before, if they are due and `isOpen` still says nobody has
   * answered them. A message that was delivered is never in the list, so nothing goes out twice.
   * `onFailure` hears each failed retry; `gaveUp` is true when it was the last one.
   */
  retryUnsent(
    isOpen: (user: string, questionId: string) => boolean,
    onFailure: (questionId: string, error: unknown, gaveUp: boolean) => void,
  ): Promise<string[]>;
}

export function messengerChannel(
  link: McpLink,
  settings: MessengerSettings,
  options: MessengerChannelOptions = {},
): MessengerChannel {
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const unsent = new Map<string, Unsent>();
  const keyOf = (user: string, questionId: string) => `${user}/${questionId}`;
  return {
    name: 'messenger',
    async send(user: ServeUser, message: ServeMessage) {
      try {
        await sendToPeer(link, settings, messengerText(message));
      } catch (error) {
        // Only the message that asks is worth a retry; a report about a question is not.
        if (message.asks && message.questionId && delays.length > 0)
          unsent.set(keyOf(user.id, message.questionId), {
            user,
            message,
            attempts: 0,
            due: now() + delays[0]!,
          });
        throw error;
      }
    },
    async retryUnsent(isOpen, onFailure) {
      const delivered: string[] = [];
      for (const [key, entry] of [...unsent]) {
        const questionId = entry.message.questionId!;
        if (!isOpen(entry.user.id, questionId)) {
          unsent.delete(key);
          continue;
        }
        if (entry.due > now()) continue;
        try {
          await sendToPeer(link, settings, messengerText(entry.message));
          unsent.delete(key);
          delivered.push(questionId);
        } catch (error) {
          entry.attempts += 1;
          const gaveUp = entry.attempts >= delays.length;
          if (gaveUp) unsent.delete(key);
          else entry.due = now() + delays[entry.attempts]!;
          onFailure(questionId, error, gaveUp);
        }
      }
      return delivered;
    },
  };
}

/** A failed channel, as `combineChannels` reports it. */
export type ChannelFailure = (channel: string, error: unknown) => void;

/**
 * Several channels as one: a message goes to all of them. It fails only when every channel failed —
 * one that is down must not hide the question from the other. But a channel that failed is never
 * silent: `onFailure` hears each one, even when another channel got the message through.
 */
export function combineChannels(channels: readonly ServeChannel[], onFailure?: ChannelFailure): ServeChannel {
  if (channels.length === 1) return channels[0]!;
  return {
    name: channels.map((channel) => channel.name).join(' + '),
    async send(user, message) {
      const results = await Promise.allSettled(channels.map(async (channel) => channel.send(user, message)));
      let failures = 0;
      let first: unknown;
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        if (failures++ === 0) first = result.reason;
        try {
          onFailure?.(channels[index]!.name, result.reason);
        } catch {
          // Reporting must not turn a delivered message into a failure.
        }
      });
      if (failures === results.length && failures > 0) throw first;
    },
  };
}
