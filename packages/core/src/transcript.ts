/**
 * A `session/update` stream turned into transcript lines.
 *
 * Two things are deliberately not done here:
 *
 * - **Tool output is not kept.** A `tool_call` carries `rawOutput` and `content` in whatever shape
 *   the agent's tool used; they are the tool's result and the agent's to keep, and a copy here would
 *   be a second, wrong model of somebody else's tool. The *input* is kept since issue #43, capped at
 *   `TOOL_INPUT_MAX`: an app embedding lotse has to recognise its own MCP call in a transcript (an
 *   order it was asked to place, with the arguments), and the title alone — `execute` for every
 *   code-mode call — cannot say which call that was. Earlier versions stored the title and status
 *   only; `text` is still written exactly as they wrote it.
 * - **Nothing is filtered for privacy.** The transcript is the conversation, and the file it lands
 *   in is `0600` outside the repository. A filter here would be a policy with no gate behind it —
 *   exactly the shape the plan forbids.
 */

import type { SessionNotification, SessionUpdate, ToolCall, ToolCallUpdate } from '@lotse/acp/types';
import { TOOL_INPUT_MAX, type McpCall, type ToolCallRecord, type TranscriptEntry } from '@lotse/session';

import { chunkToText } from './policy.ts';
import { describeUsage } from './usage.ts';

/** One notification becomes zero or more lines; a `plan` update is several. */
export function toTranscript(notification: SessionNotification, at: string): TranscriptEntry[] {
  const update = notification.update;
  const base = { at, sessionId: notification.sessionId };
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return textEntry('user', chunkToText(update.content), base);
    case 'agent_message_chunk':
      return textEntry('agent', chunkToText(update.content), base);
    case 'agent_thought_chunk':
      return textEntry('thought', chunkToText(update.content), base);
    case 'tool_call':
      return [
        {
          ...base,
          kind: 'tool',
          toolCallId: update.toolCallId,
          text: `${update.title}${update.status ? ` — ${update.status}` : ''}`,
          tool: toolRecordOf(update),
        },
      ];
    case 'tool_call_update': {
      const status = update.status ? ` — ${update.status}` : '';
      const title = update.title ? `${update.title}${status}` : status.trim();
      // Still dropped when there is no line to read, as before the structured record existed: every
      // agent measured so far sends a status with each update, and a line with an empty `text` is
      // one `toTranscriptItems` and `lotse sessions` would both have to learn to skip.
      if (!title) return [];
      return [
        { ...base, kind: 'tool', toolCallId: update.toolCallId, text: title, tool: toolRecordOf(update) },
      ];
    }
    case 'plan':
      return update.entries.map((entry) => ({
        ...base,
        kind: 'system' as const,
        text: `plan: [${entry.status ?? 'pending'}] ${entry.content}`,
      }));
    case 'current_mode_update':
      return [{ ...base, kind: 'system', text: `mode: ${update.currentModeId}` }];
    case 'session_info_update':
      return update.title ? [{ ...base, kind: 'system', text: `title: ${update.title}` }] : [];
    case 'usage_update':
      // **The clause is `core/usage.ts`'s, not a template literal here.** A cost arrives as an IEEE
      // double and printing it raw put `0.0014555100000000001 USD` into a person's transcript — a
      // rounding artefact recorded as a price. See that file for the digits and the `<0.0001` case.
      return [{ ...base, kind: 'system', text: `usage: ${describeUsage(update)}` }];
    case 'available_commands_update':
    case 'config_option_update':
      // Bookkeeping the user did not ask for. The commands are still available from
      // `session/new`'s answer, where the protocol says they belong.
      return [];
    default:
      // An update variant from a newer ACP. Recorded as one opaque line: the turn's shape stays
      // visible, and dropping it would make lotse's record disagree with the agent's.
      return [{ ...base, kind: 'system', text: `(${describeUnknown(update)})` }];
  }
}

function textEntry(
  kind: TranscriptEntry['kind'],
  text: string,
  base: { at: string; sessionId: string },
): TranscriptEntry[] {
  return text ? [{ ...base, kind, text }] : [];
}

function describeUnknown(update: SessionUpdate): string {
  const name = String((update as { sessionUpdate?: unknown }).sessionUpdate ?? 'unknown');
  return `update the client does not know: ${name}`;
}

/** The structured half of a tool line: only what this one line carried. See `ToolCallRecord`. */
function toolRecordOf(update: ToolCall | ToolCallUpdate): ToolCallRecord {
  const record: ToolCallRecord = {};
  if (update.kind !== undefined) record.kind = update.kind;
  if (update.title !== undefined) record.title = update.title;
  if (update.status !== undefined) record.status = update.status;
  if (update.rawInput !== undefined) {
    if (fitsInputCap(update.rawInput)) record.rawInput = update.rawInput;
    else record.rawInputOmitted = true;
  }
  const mcp = mcpCallsOf(update.rawInput, update.rawOutput);
  if (mcp.length > 0) record.mcp = mcp;
  return record;
}

/**
 * Whether a value is small enough to keep — `TOOL_INPUT_MAX` UTF-8 bytes of JSON.
 *
 * Bytes, not string length: the cap is about the file on disk, and a non-Latin argument is two to
 * four bytes a character there. A value `JSON.stringify` cannot write (a cycle, a BigInt) cannot be
 * stored either and counts as over.
 */
export function fitsInputCap(value: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  if (json === undefined) return false;
  return new TextEncoder().encode(json).length <= TOOL_INPUT_MAX;
}

/**
 * Whether a value is JSON all the way down and survives a write to the store unchanged.
 *
 * `JSON.stringify` alone is too forgiving: it silently drops a function or an `undefined` member,
 * turns a `Map` into `{}` and a `Date` into a string — the stored value then differs from the one the
 * caller handed over. So this walks the value and accepts only `null`, booleans, strings, finite
 * numbers, arrays and plain objects, and refuses a cycle.
 */
export function isJsonValue(value: unknown, ancestors: object[] = []): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.includes(value)) return false;
  const next = [...ancestors, value];
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, next));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((member) => isJsonValue(member, next));
}

/**
 * `tools.<server>.<tool>(`, with either segment in dot or bracket form.
 *
 * The lookbehind keeps `mytools.a.b(` and `x.tools.a.b(` out: those are some other object's
 * `tools`, and code-mode exposes the catalog as a bare global.
 */
const CODE_CALL =
  /(?<![\w$.])tools((?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:"[^"\n]*"|'[^'\n]*')\s*\])){2})\s*\(/g;
const CODE_SEGMENT = /\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"\n]*)"|'([^'\n]*)')\s*\]/g;

/**
 * The MCP tools a tool call reached, as far as the line says.
 *
 * Exported and pure because it is a reading of one agent's conventions and will be wrong for the
 * next one — a test pins what it reads today. Two sources, in order of trust:
 *
 * - **`reported`**: `rawOutput.metadata.toolCalls[]`, opencode's own account of a code-mode run
 *   (measured 2026-10-11, `refs/acp/SOURCE.md`). Each `tool` is `"<server>.<tool>"` and is split at
 *   the FIRST dot — a server name has none in opencode's catalog, a tool name may. Anything that is
 *   not that shape is skipped rather than guessed at.
 * - **`code`**: matches in `rawInput.code`, the code-mode source, while the call is still running and
 *   nothing is reported yet. It names what the code *mentions*, so no input and no status, and each
 *   tool once.
 *
 * When the agent reported anything, the code reading is left out: it is the weaker claim about the
 * same call, and listing both would show one MCP call twice.
 */
export function mcpCallsOf(rawInput: unknown, rawOutput: unknown): McpCall[] {
  const reported = reportedCalls(rawOutput);
  return reported.length > 0 ? reported : codeCalls(rawInput);
}

function reportedCalls(rawOutput: unknown): McpCall[] {
  const metadata = isObject(rawOutput) ? rawOutput.metadata : undefined;
  const toolCalls = isObject(metadata) ? metadata.toolCalls : undefined;
  if (!Array.isArray(toolCalls)) return [];
  const calls: McpCall[] = [];
  for (const entry of toolCalls) {
    if (!isObject(entry) || typeof entry.tool !== 'string') continue;
    const dot = entry.tool.indexOf('.');
    if (dot <= 0 || dot === entry.tool.length - 1) continue;
    const call: McpCall = {
      server: entry.tool.slice(0, dot),
      tool: entry.tool.slice(dot + 1),
      source: 'reported',
    };
    if (entry.input !== undefined && fitsInputCap(entry.input)) call.input = entry.input;
    if (typeof entry.status === 'string') call.status = entry.status;
    calls.push(call);
  }
  return calls;
}

function codeCalls(rawInput: unknown): McpCall[] {
  const code = isObject(rawInput) ? rawInput.code : undefined;
  if (typeof code !== 'string') return [];
  const calls: McpCall[] = [];
  const seen = new Set<string>();
  for (const match of code.matchAll(CODE_CALL)) {
    const names = [...(match[1] ?? '').matchAll(CODE_SEGMENT)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    const [server, tool] = names;
    if (!server || !tool) continue;
    const key = `${server}\u0000${tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ server, tool, source: 'code' });
  }
  return calls;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
