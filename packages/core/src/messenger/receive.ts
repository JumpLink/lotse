/**
 * The receive side of the messenger: long-poll the server's wait tool, read each reply as an answer.
 *
 * - **A cursor survives restarts** (`CursorStore`). First start: now, so an old conversation is not
 *   replayed as answers. It advances after each handled message — at least once: a crash between
 *   handling and writing re-reads the message, and the second `answerQuestion` is dropped as "answered".
 * - **The server may die.** Any failure drops the link and waits (5 s, doubling to 5 min) before a
 *   fresh start; a success resets the wait. An abort ends the loop wherever it is.
 * - **Only the questions the chat may see.** A task whose `channels` leave out the messenger never sent
 *   its question here, so a reply cannot answer it — not by plain text, not by its id.
 * - **Every answer is `answerQuestion`** — the same path as `lotse answer` and the dialog — so the
 *   first channel to answer wins and the other hears what the runner says: already answered.
 */

import { deliveryOf } from '../serve/config.ts';
import { answerQuestion, type AnswerResult, type ServeDeps } from '../serve/runner.ts';
import { formatQuestionId, openQuestions } from '../serve/questions.ts';
import { localDeadline, sendToPeer, type MessengerChannel } from './channel.ts';
import { McpLink } from './link.ts';
import { listIds, openIds, parseReply } from './reply.ts';
import type { MessengerSettings } from './settings.ts';
import { STRINGS, msg } from './strings.ts';

/**
 * What the chat hears of an outcome: the continuation's internals stay in the log. A `dropped` or
 * `expired` message carries the stored resolution, which can be a run's failure reason, so those two are
 * rebuilt from the question's status and deadline, never forwarded.
 */
export function chatSays(questionId: string, result: AnswerResult): string {
  const id = formatQuestionId(questionId);
  switch (result.mode) {
    case 'allowed':
    case 'declined':
    case 'loaded':
    case 'resumed':
    case 'follow-up':
      return msg(result.run?.outcome === 'failed' ? STRINGS.gotItRunFailed : STRINGS.gotIt, { id });
    case 'dropped': {
      const status = result.question?.status;
      return status && status !== 'open'
        ? msg(STRINGS.alreadySettled, { id, status })
        : msg(STRINGS.noLongerWaiting, { id });
    }
    case 'expired':
      return result.question
        ? msg(STRINGS.expiredAt, { id, time: localDeadline(result.question.expiresAt) })
        : msg(STRINGS.noLongerWaiting, { id });
    default:
      return result.message;
  }
}

export interface CursorStore {
  read(): string | null;
  write(cursor: string): void;
}

export interface ReceiveOptions {
  readonly link: McpLink;
  readonly settings: MessengerSettings;
  readonly serve: ServeDeps;
  readonly cursor: CursorStore;
  readonly signal: AbortSignal;
  /** When given, its unsent questions are retried before each poll while they are still open. */
  readonly channel?: MessengerChannel;
  /** A line for the person running serve. */
  readonly log?: (line: string) => void;
  /** Long-poll length the server is asked for. Default 60 s (curlew's maximum is 120). */
  readonly timeoutS?: number;
  /** A poll that returns sooner is followed by a pause up to this long. Default 1 s. */
  readonly minCycleMs?: number;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  /** Resolves after `ms`, or early on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface WaitMessage {
  readonly bodyText: string;
  /** `null` when the server could not say; the loop then moves the cursor by other means. */
  readonly sentAt: string | null;
  readonly fromSelf: boolean;
}

interface WaitResult {
  readonly messages: readonly WaitMessage[];
  readonly cursor: string | null;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the wait tool returned; a shape that is not a reply result is an error, not "no messages". */
export function parseWaitResult(value: unknown): WaitResult {
  if (!isRecord(value) || (value['status'] !== 'reply' && value['status'] !== 'timeout')) {
    throw new Error('the wait tool returned something other than {status: "reply" | "timeout"}');
  }
  const cursor = typeof value['cursor'] === 'string' ? value['cursor'] : null;
  const raw = Array.isArray(value['messages']) ? value['messages'] : [];
  const messages: WaitMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    messages.push({
      bodyText: typeof item['bodyText'] === 'string' ? item['bodyText'] : '',
      sentAt: typeof item['sentAt'] === 'string' ? item['sentAt'] : null,
      fromSelf: item['fromSelf'] === true,
    });
  }
  return { messages, cursor };
}

export async function runReceiveLoop(options: ReceiveOptions): Promise<void> {
  const { link, settings, serve, signal } = options;
  const log = options.log ?? (() => {});
  const timeoutS = options.timeoutS ?? 60;
  const minCycleMs = options.minCycleMs ?? 1000;
  const backoff = options.backoff ?? { initialMs: 5000, maxMs: 300_000 };
  const sleep = options.sleep ?? abortableSleep;

  let cursor = options.cursor.read();
  if (cursor === null) {
    cursor = serve.now().toISOString();
    options.cursor.write(cursor);
  }
  // Only forward: an older value (a message the server lists late) must not re-open what was read.
  const remember = (next: string) => {
    const [to, from] = [Date.parse(next), Date.parse(cursor ?? '')];
    if (next === cursor || (!Number.isNaN(to) && !Number.isNaN(from) && to <= from)) return;
    cursor = next;
    options.cursor.write(next);
  };

  const reply = async (text: string) => {
    try {
      await sendToPeer(link, settings, text);
    } catch (error) {
      log(`messenger: reply not sent (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  const inChat = (task: string) => {
    const { channels } = deliveryOf(serve.config, task);
    return !channels || channels.includes('messenger');
  };

  const handle = async (text: string) => {
    const book = serve.questions.read();
    const open = openQuestions(book, serve.now()).filter((question) => inChat(question.task));
    const intent = parseReply(text, openIds(open));
    switch (intent.kind) {
      case 'ignore':
        return;
      case 'nothing-open':
        return reply(msg(STRINGS.noQuestionOpen));
      case 'ambiguous': {
        const first = formatQuestionId(intent.open[0]!);
        return reply(msg(STRINGS.severalOpen, { ids: listIds(intent.open), example: `${first} yes` }));
      }
      case 'missing-text':
        return reply(
          msg(STRINGS.missingText, {
            id: formatQuestionId(intent.questionId),
            example: `${formatQuestionId(intent.questionId)} yes`,
          }),
        );
      case 'answer': {
        const hidden = book.some((question) => question.id === intent.questionId && !inChat(question.task));
        if (hidden) return reply(msg(STRINGS.notHere, { id: formatQuestionId(intent.questionId) }));
        const result = await answerQuestion(intent.questionId, intent.text, serve);
        log(`messenger: ${formatQuestionId(intent.questionId)}: ${result.message}`);
        return reply(chatSays(intent.questionId, result));
      }
    }
  };

  const retryUnsent = async () => {
    if (!options.channel) return;
    const open = new Set(
      openQuestions(serve.questions.read(), serve.now()).map((question) => `${question.user}/${question.id}`),
    );
    const delivered = await options.channel.retryUnsent(
      (user, id) => open.has(`${user}/${id}`),
      (id, error, gaveUp) => {
        const reason = error instanceof Error ? error.message : String(error);
        const text = msg(gaveUp ? STRINGS.retryGaveUp : STRINGS.retryFailed, {
          id: formatQuestionId(id),
          reason,
        });
        log(`messenger: ${text}`);
        serve.log?.({
          event: 'error',
          task: '-',
          detail: {
            channel: 'messenger',
            kind: error instanceof Error ? error.name : 'Error',
            retry: gaveUp ? 'gave up' : 'failed',
            question: id,
          },
        });
      },
    );
    for (const id of delivered)
      log(`messenger: ${msg(STRINGS.retryDelivered, { id: formatQuestionId(id) })}`);
  };

  let delay = backoff.initialMs;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await retryUnsent();
      const tools = await link.acquire();
      const value = await tools.call(
        settings.waitTool,
        {
          account: settings.account,
          peer: settings.peer,
          after: cursor,
          timeout_s: timeoutS,
          include_bodies: true,
        },
        { timeoutMs: (timeoutS + 20) * 1000, signal },
      );
      const result = parseWaitResult(value);
      for (const message of result.messages) {
        if (signal.aborted) return;
        if (!message.fromSelf) await handle(message.bodyText);
        // No `sentAt`: the server's cursor, else now. Assumes the message is not seen again — a
        // restart before the write re-reads it, and the second answer is dropped as already answered.
        remember(message.sentAt ?? result.cursor ?? serve.now().toISOString());
      }
      if (result.messages.length > 0 && result.cursor) remember(result.cursor);
      delay = backoff.initialMs;
      const spent = Date.now() - started;
      if (spent < minCycleMs) await sleep(minCycleMs - spent, signal);
    } catch (error) {
      if (signal.aborted) return;
      await link.drop();
      log(
        `messenger: ${error instanceof Error ? error.message : String(error)}. ${msg(STRINGS.linkDown, { seconds: String(Math.round(delay / 1000)) })}`,
      );
      await sleep(delay, signal);
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }
}
