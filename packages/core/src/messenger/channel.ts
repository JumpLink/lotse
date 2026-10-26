/**
 * The messenger as a `QuestionChannel`: a question goes to the person as one chat message, through the
 * configured MCP server's send tool. The answers come back through `receive.ts`.
 *
 * The message carries the question id in its first line ("lotse · task · #A3") and says how to reply,
 * because the person answers in the chat and the id is how the reply finds its question.
 */

import type { QuestionChannel, QuestionMessage } from '../questions/channel.ts';
import type { Delivery } from '../profile/delivery.ts';
import type { User } from '../users/users.ts';
import { formatQuestionId } from '../questions/question.ts';
import type { McpLink } from './link.ts';
import { memoryRefs, recordRefs, type RefStore } from './refs.ts';
import type { ChannelName, MessengerSettings } from './settings.ts';
import { STRINGS, msg } from './strings.ts';

/** A deadline as the person's clock shows it ("Tue, 10/13, 18:14"); an unreadable one stays as it came. */
/** `locale` is for tests; people get the host's. */
export function localDeadline(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** The text of `message` as one chat message. */
export function messengerText(message: QuestionMessage): string {
  const parts = [message.title, message.text ?? message.body];
  if (message.asks && message.questionId) {
    const id = formatQuestionId(message.questionId);
    parts.push(
      msg(
        message.asks === 'permission'
          ? STRINGS.replyHintPermission
          : message.asks === 'person'
            ? STRINGS.replyHintPerson
            : STRINGS.replyHintReply,
        { id },
      ),
    );
    if (message.expiresAt) parts.push(msg(STRINGS.validUntil, { time: localDeadline(message.expiresAt) }));
  }
  return parts.join('\n\n');
}

/** The ids a send result names: `originIds` when the server split the text, else `originId`. */
function originIdsOf(result: unknown): string[] {
  const record = (result ?? {}) as { originIds?: unknown; originId?: unknown };
  const ids = Array.isArray(record.originIds) ? record.originIds : [record.originId];
  return ids.filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * Send `text` (Markdown) to the configured peer in one call. A server that meets the contract renders it
 * for its protocol, splits it and turns image lines into image messages (`format: "markdown"`); an older
 * one gets the same text as it is, unrendered (`contract.ts`). Lotse cuts and styles nothing itself.
 * The result is every message id the server reports, for replies to any part of the text.
 */
export async function sendToPeerWithIds(
  link: McpLink,
  settings: MessengerSettings,
  text: string,
): Promise<string[]> {
  return link.use(async (tools) => {
    const contract = await link.contractOf(tools, settings);
    const result = await tools.call(settings.sendTool, {
      account: settings.account,
      to: settings.peer,
      text,
      ...(contract.format === 'markdown' ? { format: 'markdown' } : {}),
    });
    return originIdsOf(result);
  });
}

export async function sendToPeer(link: McpLink, settings: MessengerSettings, text: string): Promise<void> {
  await sendToPeerWithIds(link, settings, text);
}

/** A question message that did not reach the chat, kept in memory until it does or stops being open. */
interface Unsent {
  readonly user: User;
  readonly message: QuestionMessage;
  attempts: number;
  due: number;
}

export interface MessengerChannelOptions {
  /** The clock for the retry delays. Default `Date.now`. */
  readonly now?: () => number;
  /** Delay before retry n (0-based); there are as many retries as entries. Default 30 s … 10 min. */
  readonly retryDelaysMs?: readonly number[];
  /** Where the ids of the sent question messages are kept, for replies to them. Default: in memory. */
  readonly refs?: RefStore;
}

export const RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000];

export interface MessengerChannel extends QuestionChannel {
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
  const refs = options.refs ?? memoryRefs();
  const sendQuestion = async (user: User, message: QuestionMessage) => {
    const ids = await sendToPeerWithIds(link, settings, messengerText(message));
    if (message.asks && message.questionId) recordRefs(refs, user.id, message.questionId, ids);
  };
  const unsent = new Map<string, Unsent>();
  const keyOf = (user: string, questionId: string) => `${user}/${questionId}`;
  return {
    name: 'messenger',
    async send(user: User, message: QuestionMessage) {
      try {
        await sendQuestion(user, message);
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
      // A snapshot: sends await, and an entry queued meanwhile waits for the next pass.
      for (const [key, entry] of Array.from(unsent)) {
        const questionId = entry.message.questionId!;
        if (!isOpen(entry.user.id, questionId)) {
          unsent.delete(key);
          continue;
        }
        if (entry.due > now()) continue;
        try {
          await sendQuestion(entry.user, entry.message);
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
export function combineChannels(
  channels: readonly QuestionChannel[],
  onFailure?: ChannelFailure,
): QuestionChannel {
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

/**
 * `message` with no question text and no run output: the title (task and id) stays, the body says a
 * message waits and where to read it. What the messenger gets for a profile with `messengerDetail: "notice"`.
 */
export function noticeOf(message: QuestionMessage): QuestionMessage {
  const task = message.task ?? 'lotse';
  const body = message.asks ? msg(STRINGS.noticeQuestion, { task }) : msg(STRINGS.noticeMessage, { task });
  return {
    title: message.title,
    body,
    questionId: message.questionId,
    ...(message.task !== undefined ? { task: message.task } : {}),
    ...(message.asks !== undefined ? { asks: message.asks, text: body } : {}),
    ...(message.expiresAt !== undefined ? { expiresAt: message.expiresAt } : {}),
  };
}

/** An opened channel and the name a task's `channels` list uses for it (the stderr fallback is `desktop`). */
export interface ChannelRoute {
  readonly name: ChannelName;
  readonly channel: QuestionChannel;
}

/**
 * The opened channels, each message sent only to those its task's profile allows (`delivery`), and
 * to the messenger as a notice when the profile asks for one. A message without a task — listen's own
 * news — goes to all of them. A task none of whose channels is open sends nothing: its question waits
 * in the store.
 */
export function routeChannels(
  routes: readonly ChannelRoute[],
  delivery: (task: string) => Delivery,
  onFailure?: ChannelFailure,
): QuestionChannel {
  return {
    name: routes.map((route) => route.channel.name).join(' + '),
    async send(user, message) {
      const where = message.task ? delivery(message.task) : null;
      const allowed = routes.filter((route) => !where?.channels || where.channels.includes(route.name));
      if (allowed.length === 0) return;
      const notice = where?.messengerDetail === 'notice' ? noticeOf(message) : null;
      const channels = allowed.map((route): QuestionChannel => {
        if (route.name !== 'messenger' || !notice) return route.channel;
        return { name: route.channel.name, send: (to) => route.channel.send(to, notice) };
      });
      await combineChannels(channels, onFailure).send(user, message);
    },
  };
}
