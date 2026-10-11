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

export function messengerChannel(link: McpLink, settings: MessengerSettings): ServeChannel {
  return {
    name: 'messenger',
    async send(_user: ServeUser, message: ServeMessage) {
      await sendToPeer(link, settings, messengerText(message));
    },
  };
}

/**
 * Several channels as one: a message goes to all of them. It fails only when every channel failed —
 * one that is down must not hide the question from the other.
 */
export function combineChannels(channels: readonly ServeChannel[]): ServeChannel {
  if (channels.length === 1) return channels[0]!;
  return {
    name: channels.map((channel) => channel.name).join(' + '),
    async send(user, message) {
      const results = await Promise.allSettled(channels.map(async (channel) => channel.send(user, message)));
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed.length === results.length && failed.length > 0) throw failed[0]!.reason;
    },
  };
}
