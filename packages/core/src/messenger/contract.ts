/**
 * What a messenger MCP server can do, learned once per connection from `tools/list` and, when the
 * server offers it, its capability tool. The contract is `docs/messenger-contract.md`.
 *
 * Lotse sends Markdown and lets the server render it for its protocol, split it and strip quotes from
 * replies. A server that cannot (older Curlew, another messenger) is not refused: Lotse sends the same
 * text as `plain`, keeps a fixed wait timeout and strips nothing, and says so once.
 */

import type { McpTools, McpToolInfo } from './mcp-client.ts';
import type { MessengerSettings } from './settings.ts';

/** The tool that describes the server, `capabilitiesTool` of the settings when they name none. */
export const DEFAULT_CAPABILITIES_TOOL = 'messaging_capabilities';

/** Long-poll length when the server states no limit. */
export const FALLBACK_WAIT_S = 60;

/** What Lotse does against one server. */
export interface MessengerContract {
  /** `markdown`: the send tool renders and splits. `plain`: the text goes out as written, unrendered. */
  readonly format: 'markdown' | 'plain';
  /** Ask the wait tool to drop the quoted fallback text (XEP-0428) from a reply. */
  readonly stripQuotes: boolean;
  /** The longest wait the server accepts, in seconds; `null` when it did not say. */
  readonly maxWaitS: number | null;
  /** The server's own answer to the capability tool, `null` when it has none. */
  readonly capabilities: ProtocolCapabilities | null;
  /** Why Lotse falls back, or `null` when the server meets the whole contract. */
  readonly notice: string | null;
}

/** One entry of the capability tool's `protocols` list, as far as Lotse reads it. */
export interface ProtocolCapabilities {
  readonly protocol: string;
  readonly maxMessageChars: number | null;
  readonly waitTimeoutS: { readonly default: number | null; readonly max: number | null } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The capability tool's result: `{protocols: [{protocol, accounts, waitTimeoutS, …}]}`. The entry that
 * lists `account` is the one that counts, else the only entry. `null` when nothing in it is usable.
 */
export function parseCapabilities(value: unknown, account: string): ProtocolCapabilities | null {
  if (!isRecord(value) || !Array.isArray(value['protocols'])) return null;
  const entries = value['protocols'].filter(isRecord);
  const listed = entries.find(
    (entry) => Array.isArray(entry['accounts']) && (entry['accounts'] as unknown[]).includes(account),
  );
  const entry = listed ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) return null;
  const timeout = isRecord(entry['waitTimeoutS']) ? entry['waitTimeoutS'] : null;
  return {
    protocol: typeof entry['protocol'] === 'string' ? entry['protocol'] : '',
    maxMessageChars: positive(entry['maxMessageChars']),
    waitTimeoutS: timeout ? { default: positive(timeout['default']), max: positive(timeout['max']) } : null,
  };
}

/** Whether the tool `name` lists `input` among its inputs. */
function hasInput(tools: readonly McpToolInfo[], name: string, input: string): boolean {
  return tools.find((tool) => tool.name === name)?.inputs.includes(input) ?? false;
}

/**
 * Settle the contract against `tools`. A server whose `send_message` has no `format` input gets plain
 * text; one without the capability tool gets the fixed wait timeout. Never throws on a missing
 * capability — only a broken connection does.
 */
export async function negotiateContract(
  tools: McpTools,
  settings: MessengerSettings,
): Promise<MessengerContract> {
  const listed = await tools.describeTools();
  const capabilitiesTool = settings.capabilitiesTool ?? DEFAULT_CAPABILITIES_TOOL;
  const markdown = hasInput(listed, settings.sendTool, 'format');
  const quotes = hasInput(listed, settings.waitTool, 'strip_quotes');
  const offersCapabilities = listed.some((tool) => tool.name === capabilitiesTool);

  let capabilities: ProtocolCapabilities | null = null;
  if (offersCapabilities) {
    try {
      capabilities = parseCapabilities(await tools.call(capabilitiesTool, {}), settings.account);
    } catch {
      // A capability tool that fails is as good as none: the fixed timeout is safe on any server.
    }
  }

  const missing: string[] = [];
  if (!markdown) missing.push(`${settings.sendTool} has no "format" input, so text goes out as plain`);
  if (!quotes) missing.push(`${settings.waitTool} has no "strip_quotes" input, so quotes stay in replies`);
  if (!capabilities) missing.push(`no ${capabilitiesTool}, so waits last ${FALLBACK_WAIT_S} s`);
  return {
    format: markdown ? 'markdown' : 'plain',
    stripQuotes: quotes,
    maxWaitS: capabilities?.waitTimeoutS?.max ?? null,
    capabilities,
    notice:
      missing.length === 0 ? null : `messenger server is older than the contract: ${missing.join('; ')}`,
  };
}

/** The long-poll length to ask for: `wanted`, kept under what the server accepts. */
export function waitSeconds(contract: MessengerContract, wanted: number | undefined): number {
  const asked = wanted ?? FALLBACK_WAIT_S;
  return contract.maxWaitS === null ? asked : Math.min(asked, contract.maxWaitS);
}
