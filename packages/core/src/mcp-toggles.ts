/**
 * Per-conversation MCP server toggles, as data (ADR 0007 §2).
 *
 * A conversation starts with the host's or profile's server list, all of it on. The person may switch a
 * server off for this conversation only; the change applies from the NEXT turn, when the controller
 * puts the new list in front of the agent with `session/resume` (measured 2026-10-26: opencode 2.1.2
 * and claude-agent-acp 0.97.0 honour it; opencode leaves the old server running — an agent-side leak
 * Lotse does not work around).
 *
 * Everything decision-shaped is here so Node can test it: which list is active, whether a resume is
 * pending, and whether the toggles may be used at all. The widget draws the view and nothing else.
 *
 * **Servers are passed through, not known** (AGENTS.md): only `name` is read, to label a toggle and to
 * compare lists. Two servers with one name toggle together.
 */

import type { McpServer } from '@lotse/acp';

import { _, fmt } from './i18n.ts';

export interface McpToggle {
  readonly name: string;
  readonly on: boolean;
  /** The tooltip: what the toggle does, or why it cannot be used. */
  readonly tooltip: string;
  /** The accessible name: the server, not the sentence. */
  readonly label: string;
}

export interface McpTogglesView {
  /** False when the conversation has no MCP servers — no toggle, no gap. */
  readonly visible: boolean;
  readonly toggles: readonly McpToggle[];
  /** False when the agent holds this session and offers no `session/resume`. */
  readonly selectable: boolean;
}

/** The view of a conversation with no MCP servers. */
export function emptyMcpToggles(): McpTogglesView {
  return NO_MCP_TOGGLES;
}

export const NO_MCP_TOGGLES: McpTogglesView = { visible: false, toggles: [], selectable: true };

/** The servers a conversation runs with: the whole list minus the ones switched off. */
export function activeMcpServers(servers: readonly McpServer[], off: ReadonlySet<string>): McpServer[] {
  return servers.filter((server) => !off.has(server.name));
}

export function mcpServerNames(servers: readonly McpServer[]): string[] {
  return servers.map((server) => server.name);
}

/**
 * Whether the agent holds a different list than the toggles now say. Order-insensitive: a list is a
 * set of servers, and a resume for a reordering would be a round trip that changes nothing.
 * `null` — the agent holds no list for this session — is never pending: a later attach carries it.
 */
export function resumePending(held: readonly string[] | null, active: readonly McpServer[]): boolean {
  if (held === null) return false;
  const want = new Set(mcpServerNames(active));
  const have = new Set(held);
  if (want.size !== have.size) return true;
  for (const name of want) if (!have.has(name)) return true;
  return false;
}

export interface McpTogglesInput {
  readonly servers: readonly McpServer[];
  readonly off: ReadonlySet<string>;
  /** Whether the agent process already holds this conversation's session. */
  readonly agentHolds: boolean;
  /** `session/resume` offered by the agent; `null` while there is no agent to ask. */
  readonly resume: boolean | null;
}

/**
 * **No silent new session.** Once the agent holds the conversation, a changed list can only reach it
 * through `session/resume`; an agent that does not offer it gets disabled toggles with a sentence,
 * rather than a fresh session that would lose the conversation. Before the agent holds it (a new chat,
 * a stored session) the list simply goes out with `session/new` or the reattach, so toggles are free.
 */
export function mcpTogglesView(input: McpTogglesInput): McpTogglesView {
  const names = [...new Set(mcpServerNames(input.servers))];
  if (names.length === 0) return NO_MCP_TOGGLES;
  const selectable = !(input.agentHolds && input.resume === false);
  const blocked = _('This agent cannot change MCP servers in a running conversation.');
  return {
    visible: true,
    selectable,
    toggles: names.map((name) => ({
      name,
      on: !input.off.has(name),
      label: fmt(_('MCP server {name}'), { name }),
      tooltip: selectable
        ? fmt(_('MCP server {name}. A change applies from the next message.'), { name })
        : blocked,
    })),
  };
}

/** `off` with `name` switched. Unknown names are ignored, so a stale click cannot invent a server. */
export function toggleMcpServer(
  servers: readonly McpServer[],
  off: ReadonlySet<string>,
  name: string,
  on: boolean,
): Set<string> {
  const next = new Set(off);
  if (!servers.some((server) => server.name === name)) return next;
  if (on) next.delete(name);
  else next.add(name);
  return next;
}
