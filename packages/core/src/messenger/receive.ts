/**
 * The receive side of the messenger: read each message from a `MessageSource` as an answer or a request.
 * Where the messages come from is the source's business (`source.ts`); today it is the wait tool's long-poll.
 *
 * - **A cursor survives restarts** (`CursorStore`). First start: now, so an old conversation is not
 *   replayed as answers. It advances after each handled message — at least once: a crash between
 *   handling and writing re-reads the message, and the second `answerQuestion` is dropped as "answered".
 *   It holds the ids seen at its millisecond too, so two messages sent in the same one are both read.
 * - **Handling never waits for an agent.** An answer that continues a session and a request from the
 *   chat both run beside the loop; the cursor moves when they start, so a crash mid-run loses that run.
 * - **Request or answer** (with `requests`): a message starting with the prefix is a request; any other
 *   is read as an answer (`parseReply`) and becomes a request only when no question is open — unless it
 *   is a bare yes or no, which then hears that nothing is waiting.
 * - **The server may die.** Any failure resets the source and waits (5 s, doubling to 5 min) before a
 *   fresh start; a success resets the wait. An abort ends the loop wherever it is.
 * - **A reply to a question's message binds to that question** (XEP-0461: the wait tool's `replyToId`
 *   is the id the send tool returned, kept in `refs`). It beats reading the text — a single open question,
 *   several open ones — but not an id the text names itself. A question that is no longer open is said
 *   so, never replaced by another one. The quote the client put before the text is already gone: the
 *   wait tool is asked for that (`strip_quotes`), Lotse strips nothing itself.
 * - **Only the questions the chat may see.** A task whose `channels` leave out the messenger never sent
 *   its question here, so a reply cannot answer it — not by plain text, not by its id.
 * - **Every answer is `answerQuestion`** — the same path as `lotse answer` and the dialog — so the
 *   first channel to answer wins and the other hears what the runner says: already answered.
 */

import { createHash } from 'node:crypto';

import { deliveryOf } from '../serve/config.ts';
import { answerQuestion, type AnswerResult, type ServeDeps } from '../serve/runner.ts';
import { formatQuestionId, openQuestions, parseAnswer } from '../serve/questions.ts';
import { localDeadline, sendToPeer, type MessengerChannel } from './channel.ts';
import type { McpLink } from './link.ts';
import { listIds, openIds, parseReply } from './reply.ts';
import { findRef, memoryRefs, type RefStore } from './refs.ts';
import { matchPrefix, type ChatRequests } from './requests.ts';
import type { MessengerSettings } from './settings.ts';
import { longPollSource, type IncomingMessage, type MessagePage, type MessageSource } from './source.ts';
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

/**
 * How far the chat has been read: the newest `sentAt` handled, and the keys of the messages handled at
 * exactly that time. A message the server lists late with the same millisecond is then still read, and
 * one already read is not read twice.
 */
export interface Cursor {
  readonly at: string;
  readonly seen: readonly string[];
}

export interface CursorStore {
  read(): Cursor | null;
  write(cursor: Cursor): void;
}

/** The chat commands `/run`, `/tasks`, `/status`: no model call, each returns the text to reply with. */
export interface ChatCommands {
  /** `args` is what follows `/run`: a task id and `k=v` pairs. */
  run(args: string): Promise<string>;
  tasks(): string;
  status(): string;
}

export interface ReceiveOptions {
  /** Sends the replies; also what `source` reads from unless it is given. */
  readonly link: McpLink;
  readonly settings: MessengerSettings;
  /** Where messages come from. Default: the wait tool's long-poll on `link`. */
  readonly source?: MessageSource;
  readonly deps: ServeDeps;
  readonly cursor: CursorStore;
  readonly signal: AbortSignal;
  /** When given, its unsent questions are retried before each poll while they are still open. */
  readonly channel?: MessengerChannel;
  /** A line for the person running listen. */
  readonly log?: (line: string) => void;
  /** How long one wait lasts. Default 60 s, kept under the server's own limit when it states one. */
  readonly timeoutS?: number;
  /** A poll that returns sooner is followed by a pause up to this long. Default 1 s. */
  readonly minCycleMs?: number;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  /** Resolves after `ms`, or early on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** When given, a message that answers nothing is a request (`requests.ts`). Absent: requests are off. */
  readonly requests?: ChatRequests | (() => ChatRequests | undefined);
  /**
   * One pass instead of a loop: poll once for `timeoutS` (a poll that waits no longer than that), handle
   * what is there, return. For `listen --once`, which must end.
   */
  readonly once?: boolean;
  /** The sent question messages (`messengerChannel`'s `refs`); absent: replies are read by their text. */
  readonly refs?: RefStore;
  /** When given, `/run`, `/tasks` and `/status` are answered from it, before any other reading of a message. */
  readonly commands?: ChatCommands | (() => ChatCommands | undefined);
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

/** What tells two messages of one millisecond apart: the server's id, else a hash — never the text. */
export function messageKey(message: {
  readonly id: string | null;
  readonly sentAt: string | null;
  readonly bodyText: string;
}): string {
  if (message.id !== null) return message.id;
  return `#${createHash('sha256')
    .update(`${message.sentAt ?? ''}\n${message.bodyText}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export async function runReceiveLoop(options: ReceiveOptions): Promise<void> {
  const { link, settings, deps, signal } = options;
  const source = options.source ?? longPollSource(link, settings);
  const log = options.log ?? (() => {});
  const timeoutS = options.timeoutS ?? 60;
  const minCycleMs = options.minCycleMs ?? 1000;
  const backoff = options.backoff ?? { initialMs: 5000, maxMs: 300_000 };
  const sleep = options.sleep ?? abortableSleep;

  const stored = options.cursor.read();
  let cursor: Cursor = stored ?? { at: deps.now().toISOString(), seen: [] };
  if (stored === null) options.cursor.write(cursor);
  const save = (next: Cursor) => {
    cursor = next;
    options.cursor.write(next);
  };
  // Only forward: an older time (a message the server lists late) must not re-open what was read. The
  // same time adds the message to `seen`; a later one starts a new `seen`.
  const remember = (at: string, key: string | null) => {
    const [to, from] = [Date.parse(at), Date.parse(cursor.at)];
    const same = at === cursor.at || (!Number.isNaN(to) && to === from);
    if (same) {
      if (key !== null && !cursor.seen.includes(key)) save({ at: cursor.at, seen: [...cursor.seen, key] });
      return;
    }
    if (!Number.isNaN(to) && !Number.isNaN(from) && to < from) return;
    save({ at, seen: key === null ? [] : [key] });
  };
  const isSeen = (message: IncomingMessage) =>
    message.sentAt !== null &&
    Date.parse(message.sentAt) === Date.parse(cursor.at) &&
    cursor.seen.includes(messageKey(message));

  const reply = async (text: string) => {
    try {
      await sendToPeer(link, settings, text);
    } catch (error) {
      log(`messenger: reply not sent (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  const inChat = (task: string) => {
    const { channels } = deliveryOf(deps.config, task);
    return !channels || channels.includes('messenger');
  };

  // An answer can continue a whole session: it runs beside the loop. `answerQuestion` marks the
  // question answered before its first await, so a second reply to it already reads "answered".
  const answer = (questionId: string, text: string) => {
    void answerQuestion(questionId, text, deps)
      .then((result) => {
        log(`messenger: ${formatQuestionId(questionId)}: ${result.message}`);
        return reply(chatSays(questionId, result));
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`messenger: ${formatQuestionId(questionId)}: ${reason}`);
        return reply(msg(STRINGS.answerFailed, { reason }));
      });
  };

  // A run can take long: it goes beside the loop, like an answer, and its result is the reply.
  const command = (text: string): boolean => {
    const commands = typeof options.commands === 'function' ? options.commands() : options.commands;
    const word = /^\s*(\/run|\/tasks|\/status)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!commands || !word) return false;
    const name = word[1]!.toLowerCase();
    const args = (word[2] ?? '').trim();
    const said = async () => {
      if (name === '/tasks') return commands.tasks();
      if (name === '/status') return commands.status();
      return commands.run(args);
    };
    void said()
      .then((text) => reply(text))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`messenger: ${name}: ${reason}`);
        return reply(msg(STRINGS.commandFailed, { reason }));
      });
    return true;
  };

  const refs = options.refs ?? memoryRefs();

  const handle = async (text: string, replyToId: string | null) => {
    if (command(text)) return;
    const requests = typeof options.requests === 'function' ? options.requests() : options.requests;
    if (requests) {
      const asked = matchPrefix(text, requests.prefix);
      if (asked === '') return reply(msg(STRINGS.askWhat, { prefix: requests.prefix }));
      if (asked !== null) return requests.submit(asked, true);
    }
    const book = deps.questions.read();
    const open = openQuestions(book, deps.now()).filter((question) => inChat(question.task));
    const ref = replyToId === null ? null : findRef(refs, replyToId);
    const target =
      ref && open.find((question) => question.id === ref.questionId && question.user === ref.user);
    // Closed or kept off the chat: say so (unless the text names an id itself) instead of letting the
    // text answer whatever else is open.
    if (ref && !target && parseReply(text, []).kind === 'nothing-open') {
      const settled = book.find((question) => question.id === ref.questionId && question.user === ref.user);
      return reply(
        settled && settled.status !== 'open'
          ? msg(STRINGS.alreadySettled, { id: formatQuestionId(ref.questionId), status: settled.status })
          : msg(STRINGS.noLongerWaiting, { id: formatQuestionId(ref.questionId) }),
      );
    }
    const intent = parseReply(text, openIds(open), target ? target.id : null);
    switch (intent.kind) {
      case 'ignore':
        return;
      case 'nothing-open':
        // A bare yes or no has nothing to say to an agent: it was meant for a question that is gone.
        if (requests && parseAnswer(text).kind === 'text') return requests.submit(text.trim(), false);
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
        return answer(intent.questionId, intent.text);
      }
    }
  };

  const retryUnsent = async () => {
    if (!options.channel) return;
    const open = new Set(
      openQuestions(deps.questions.read(), deps.now()).map((question) => `${question.user}/${question.id}`),
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
        deps.log?.({
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
      const poll = (after: string, waitS: number) => source.next(after, { waitS, signal });
      // The source reads `after` strictly. With messages seen at the cursor's millisecond, a look one
      // millisecond earlier, without waiting, finds one that shares it and was listed late; only when
      // that finds nothing new does the long wait start.
      let result: MessagePage | null = null;
      const earlier = new Date(Date.parse(cursor.at) - 1).toISOString();
      if (cursor.seen.length > 0 && !Number.isNaN(Date.parse(cursor.at))) {
        const quick = await poll(earlier, 0);
        if (quick.messages.some((message) => !isSeen(message))) result = quick;
      }
      result ??= await poll(cursor.at, timeoutS);
      for (const message of result.messages) {
        if (signal.aborted) return;
        if (isSeen(message)) continue;
        if (!message.fromSelf) await handle(message.bodyText, message.replyToId);
        // No `sentAt`: the server's cursor, else now. Assumes the message is not seen again — a
        // restart before the write re-reads it, and the second answer is dropped as already answered.
        remember(message.sentAt ?? result.cursor ?? deps.now().toISOString(), messageKey(message));
      }
      if (result.messages.length > 0 && result.cursor) remember(result.cursor, null);
      delay = backoff.initialMs;
      if (options.once) return;
      const spent = Date.now() - started;
      if (spent < minCycleMs) await sleep(minCycleMs - spent, signal);
    } catch (error) {
      if (signal.aborted) return;
      await source.reset();
      if (options.once) {
        log(`messenger: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      log(
        `messenger: ${error instanceof Error ? error.message : String(error)}. ${msg(STRINGS.linkDown, { seconds: String(Math.round(delay / 1000)) })}`,
      );
      await sleep(delay, signal);
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }
}
