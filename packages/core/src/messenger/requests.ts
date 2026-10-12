/**
 * Requests from the chat: a message that answers no question starts an agent run, and its answer goes
 * back to the chat.
 *
 * - **Which message is a request** is decided by `receive.ts`, without a model: one that starts with the
 *   prefix always is; any other is read as an answer first, and becomes a request only when no question
 *   is open.
 * - **A follow-up continues the session.** For `followUpMinutes` after an answer reached the chat, a
 *   request without the prefix continues that session (`session/load`, else `session/resume`). Later, or
 *   with the prefix, a new session starts. The window is measured when the message arrives.
 * - **Runs never block the chat.** `submit` returns at once; at most `maxConcurrent` runs at a time, the
 *   rest wait in order and hear their place in the queue. Two follow-ups of one session never run at
 *   the same time — the second waits for the first.
 * - **The log gets ids and outcomes**, never what was asked or answered.
 */

import type { McpServer } from '@lotse/acp';

import {
  REQUEST_TASK,
  runRequest,
  type RequestRun,
  type RequestRunResult,
  type ServeDeps,
} from '../serve/runner.ts';
import type { RequestSettings } from './settings.ts';
import { STRINGS, msg } from './strings.ts';

/** The longest chat message an answer is cut into, in characters. */
export const PART_CHARS = 1500;
/** The most messages one answer becomes; the rest is cut off with a note. */
export const MAX_PARTS = 3;

/**
 * Requests that were accepted and not yet answered, kept on disk so a crash is not silent. It holds an id
 * and a time — never what was asked — and a restart only tells the person to send it again; a request is
 * never run again by itself, because it may have written something before it died.
 */
export interface PendingStore {
  read(): readonly PendingRequest[];
  write(list: readonly PendingRequest[]): void;
}

export interface PendingRequest {
  readonly id: string;
  readonly at: string;
}

/**
 * Tell the chat about the requests an earlier `serve` left unfinished, then forget them. One message
 * however many there were. Returns how many. A message that cannot be sent is logged and the list is
 * still cleared: the next start must not repeat it.
 */
export async function recoverPending(
  store: PendingStore,
  send: (text: string) => Promise<void>,
  log: (line: string) => void = () => {},
): Promise<number> {
  const left = store.read();
  if (left.length === 0) return 0;
  store.write([]);
  const text =
    left.length === 1
      ? msg(STRINGS.requestInterrupted)
      : msg(STRINGS.requestsInterrupted, { count: String(left.length) });
  try {
    await send(text);
  } catch (error) {
    log(`messenger: reply not sent (${error instanceof Error ? error.message : String(error)})`);
  }
  return left.length;
}

export interface ChatRequestsOptions {
  /** Where unanswered requests are noted. Absent: nothing is kept across a restart. */
  readonly pending?: PendingStore;
  readonly settings: RequestSettings;
  /** Read per run, so a reloaded tasks.json is seen. */
  readonly serve: ServeDeps;
  /** The working directory when `settings.cwd` is empty. */
  readonly defaultCwd: string;
  /** Send one message to the peer. A failure is logged here, never thrown at the caller. */
  readonly send: (text: string) => Promise<void>;
  /** A line for the person running serve. */
  readonly log?: (line: string) => void;
  /** The run itself; tests put a fake here. Default `runRequest`. */
  readonly run?: (request: RequestRun, deps: ServeDeps) => Promise<RequestRunResult>;
}

export interface ChatRequests {
  readonly prefix: string;
  /**
   * Queue a request. `fresh`: a new session even inside the follow-up window (the prefix was used).
   * Returns at once; the run, its answer and any queue notice happen in the background.
   */
  submit(text: string, fresh: boolean): void;
  /** Resolves when nothing runs and nothing waits. */
  idle(): Promise<void>;
}

/**
 * What follows `prefix` at the start of `text`, trimmed — `''` for the bare prefix — or `null` when the
 * text does not start with it. Case does not matter. A prefix ending in a letter or digit must be
 * followed by a space or the end, so `/ask` does not match `/asking`.
 */
export function matchPrefix(text: string, prefix: string): string | null {
  const start = text.trimStart();
  const wanted = prefix.trim();
  if (wanted === '' || start.slice(0, wanted.length).toLowerCase() !== wanted.toLowerCase()) return null;
  const rest = start.slice(wanted.length);
  if (/[\p{L}\p{N}]$/u.test(wanted) && rest !== '' && !/^\s/.test(rest)) return null;
  return rest.trim();
}

/** Where to cut `text` so the first piece has at most `limit` characters: a paragraph, a line, a space. */
function cutAt(text: string, limit: number): number {
  const head = text.slice(0, limit + 1);
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = head.lastIndexOf(boundary);
    if (at > limit / 2) return at;
  }
  return limit;
}

/**
 * An answer as chat messages of at most `max` characters, cut where a paragraph, a line or a word ends,
 * numbered `(1/3)` when there are several. More than `maxParts` and the last one is cut short with a
 * note saying how much is missing.
 */
export function splitForChat(text: string, max = PART_CHARS, maxParts = MAX_PARTS): string[] {
  const whole = text.trim();
  if (whole.length <= max) return [whole];
  // Room for the "(n/m) " in front and the shortening note behind.
  const budget = max - 60;
  const parts: string[] = [];
  let rest = whole;
  while (rest.length > budget && parts.length < maxParts - 1) {
    const cut = cutAt(rest, budget);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > budget) {
    const cut = cutAt(rest, budget);
    const missing = rest.length - cut;
    rest = `${rest.slice(0, cut).trimEnd()}\n\n${msg(STRINGS.answerShortened, { count: String(missing) })}`;
  }
  parts.push(rest);
  if (parts.length === 1) return parts;
  const total = String(parts.length);
  return parts.map(
    (part, index) => `${msg(STRINGS.answerPart, { part: String(index + 1), parts: total })} ${part}`,
  );
}

interface Pending {
  readonly n: number;
  /** The id in the pending store, unique across the instances a reload creates. */
  readonly key: string;
  readonly text: string;
  /** The session to continue, or `null` for a new one. */
  readonly sessionId: string | null;
  /** A note the answer starts with, e.g. that the window had closed. */
  readonly note: string | null;
}

function toMcpServers(settings: RequestSettings): McpServer[] {
  return settings.mcpServers.map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: (server.env ?? []).map(({ name, value }) => ({ name, value })),
  }));
}

export function chatRequests(options: ChatRequestsOptions): ChatRequests {
  const { settings, serve } = options;
  const log = options.log ?? (() => {});
  const run = options.run ?? runRequest;
  const maxConcurrent = Math.max(1, Math.floor(settings.maxConcurrent));
  const windowMs = Math.max(0, settings.followUpMinutes) * 60_000;
  const instance = `${serve.now().getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const queue: Pending[] = [];
  const running = new Set<Pending>();
  let counter = 0;
  /** The session the last delivered answer came from, and until when a plain message continues it. */
  let last: { sessionId: string; until: number } | null = null;
  let waiters: (() => void)[] = [];

  const record = (detail: Record<string, string>, event: 'request' | 'error' = 'request') =>
    serve.log?.({ event, task: REQUEST_TASK, detail });

  const say = async (text: string) => {
    try {
      await options.send(text);
    } catch (error) {
      log(`messenger: reply not sent (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  const note = (change: (list: readonly PendingRequest[]) => PendingRequest[]) => {
    if (!options.pending) return;
    try {
      options.pending.write(change(options.pending.read()));
    } catch (error) {
      log(
        `messenger: pending requests not saved (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  const settle = () => {
    if (running.size > 0 || queue.length > 0) return;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  const execute = async (item: Pending) => {
    const n = String(item.n);
    record({
      phase: 'start',
      request: n,
      profile: settings.profile,
      mode: item.sessionId ? 'follow-up' : 'new',
    });
    let reply: string;
    try {
      const result = await run(
        {
          profile: settings.profile,
          cwd: settings.cwd.trim() || options.defaultCwd,
          mcpServers: toMcpServers(settings),
          rights: settings.rights,
          preamble: settings.preamble,
          text: item.text,
          sessionId: item.sessionId,
        },
        serve,
      );
      const { run: outcome, how } = result;
      const notes = [item.note, how === 'fresh' ? msg(STRINGS.followUpFresh) : null].filter(
        (note): note is string => note !== null,
      );
      if (outcome.outcome === 'failed') reply = msg(STRINGS.requestFailed);
      else reply = outcome.reply ?? msg(STRINGS.requestNoAnswer);
      const parts = splitForChat([...notes, reply].join('\n\n'));
      for (const part of parts) await say(part);
      if (outcome.outcome !== 'failed' && outcome.sessionId && windowMs > 0)
        last = { sessionId: outcome.sessionId, until: serve.now().getTime() + windowMs };
      record({
        phase: 'end',
        request: n,
        mode: how,
        outcome: outcome.outcome,
        session: outcome.sessionId ?? '-',
        parts: String(parts.length),
      });
    } catch (error) {
      record({ phase: 'request', request: n, kind: error instanceof Error ? error.name : 'Error' }, 'error');
      log(`messenger: request ${n} failed (${error instanceof Error ? error.message : String(error)})`);
      await say(msg(STRINGS.requestFailed));
    }
  };

  const pump = () => {
    while (running.size < maxConcurrent) {
      const busySessions = new Set([...running].map((item) => item.sessionId).filter(Boolean));
      const index = queue.findIndex((item) => !item.sessionId || !busySessions.has(item.sessionId));
      if (index < 0) break;
      const [item] = queue.splice(index, 1);
      running.add(item!);
      void execute(item!).finally(() => {
        note((list) => list.filter((entry) => entry.id !== item!.key));
        running.delete(item!);
        pump();
        settle();
      });
    }
  };

  return {
    prefix: settings.prefix,
    submit(text, fresh) {
      counter += 1;
      const now = serve.now().getTime();
      const open = !fresh && last !== null && now < last.until;
      const hint =
        !fresh && !open && last !== null
          ? msg(STRINGS.followUpExpired, { minutes: String(settings.followUpMinutes) })
          : null;
      const item: Pending = {
        n: counter,
        key: `${instance}-${counter}`,
        text,
        sessionId: open ? last!.sessionId : null,
        note: hint,
      };
      note((list) => [...list, { id: item.key, at: serve.now().toISOString() }]);
      // Said once: the next plain message is simply a new request.
      if (hint) last = null;
      queue.push(item);
      pump();
      if (queue.includes(item)) {
        const position = String(queue.indexOf(item) + 1);
        record({ phase: 'queued', request: String(item.n), position });
        void say(msg(STRINGS.requestQueued, { position }));
      }
    },
    idle() {
      if (running.size === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
