/**
 * Where incoming chat messages come from — the one seam of the receive side.
 *
 * `receive.ts` reads messages through `MessageSource` and knows nothing of how they arrive. Today the
 * only implementation is `longPollSource`: the messenger server's wait tool, one held tool call per
 * wait. The second will be MCP's `subscriptions/listen` (spec 2026-07-28), which needs MCP SDK v2 to
 * run on GJS (https://github.com/gjsify/gjsify/issues/2389); it replaces this file's implementation
 * and touches no caller. docs/messenger-contract.md has the outlook.
 */

import { waitSeconds } from './contract.ts';
import type { McpLink } from './link.ts';
import type { MessengerSettings } from './settings.ts';

/** One message of the peer, as a source reports it. */
export interface IncomingMessage {
  /** The server's message id; `null` when it gives none. */
  readonly id: string | null;
  readonly bodyText: string;
  /** `null` when the server could not say; the loop then moves the cursor by other means. */
  readonly sentAt: string | null;
  readonly fromSelf: boolean;
  /** The id of the message this one replies to (XEP-0461), if it is a reply. */
  readonly replyToId: string | null;
}

/** What one `next` returned: the messages after the cursor, and the source's own cursor if it has one. */
export interface MessagePage {
  readonly messages: readonly IncomingMessage[];
  readonly cursor: string | null;
}

export interface NextOptions {
  /** How long to wait for a message when none is there; 0 looks once and returns. */
  readonly waitS: number;
  readonly signal: AbortSignal;
}

export interface MessageSource {
  /**
   * The messages sent strictly after `after` (an ISO 8601 time), waiting up to `waitS` for one. An empty
   * page is a timeout, not an error. A failed connection rejects; the caller then calls `reset`.
   */
  next(after: string, options: NextOptions): Promise<MessagePage>;
  /** The source failed or is stuck: drop what it holds so the next `next` starts fresh. */
  reset(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the wait tool returned; a shape that is not a reply result is an error, not "no messages". */
export function parseWaitResult(value: unknown): MessagePage {
  if (!isRecord(value) || (value['status'] !== 'reply' && value['status'] !== 'timeout')) {
    throw new Error('the wait tool returned something other than {status: "reply" | "timeout"}');
  }
  const cursor = typeof value['cursor'] === 'string' ? value['cursor'] : null;
  const raw = Array.isArray(value['messages']) ? value['messages'] : [];
  const messages: IncomingMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    messages.push({
      id: typeof item['id'] === 'string' && item['id'] !== '' ? item['id'] : null,
      bodyText: typeof item['bodyText'] === 'string' ? item['bodyText'] : '',
      sentAt: typeof item['sentAt'] === 'string' ? item['sentAt'] : null,
      fromSelf: item['fromSelf'] === true,
      replyToId: typeof item['replyToId'] === 'string' && item['replyToId'] !== '' ? item['replyToId'] : null,
    });
  }
  return { messages, cursor };
}

/**
 * The wait tool as a `MessageSource`. A server that meets the contract is asked to strip the quoted
 * fallback text (`strip_quotes`) and its wait limit caps `waitS`; any other gets neither, and the reply
 * is read as it came.
 */
export function longPollSource(link: McpLink, settings: MessengerSettings): MessageSource {
  return {
    async next(after, { waitS, signal }) {
      const tools = await link.acquire();
      const contract = await link.contractOf(tools, settings);
      const wait = waitSeconds(contract, waitS);
      return parseWaitResult(
        await tools.call(
          settings.waitTool,
          {
            account: settings.account,
            peer: settings.peer,
            after,
            timeout_s: wait,
            include_bodies: true,
            ...(contract.stripQuotes ? { strip_quotes: true } : {}),
          },
          { timeoutMs: (wait + 20) * 1000, signal },
        ),
      );
    },
    reset: () => link.drop(),
  };
}
