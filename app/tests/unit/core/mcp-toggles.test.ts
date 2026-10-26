import { describe, expect, it } from '@gjsify/unit';

import {
  NO_MCP_TOGGLES,
  activeMcpServers,
  mcpTogglesView,
  resumePending,
  toggleMcpServer,
  type McpServer,
} from '@lotse/core';

const SERVERS: McpServer[] = [
  { name: 'steuer', command: '/app/bin/steuer', args: ['mcp'], env: [] },
  { type: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [] },
];

export default async () => {
  await describe('mcp-toggles — which servers a conversation runs with', async () => {
    await it('keeps everything while nothing is off, and drops what is', async () => {
      expect(activeMcpServers(SERVERS, new Set())).toStrictEqual(SERVERS);
      expect(activeMcpServers(SERVERS, new Set(['remote'])).map((s) => s.name)).toEqualArray(['steuer']);
    });

    await it('toggles by name and ignores a name that is not a server', async () => {
      const off = toggleMcpServer(SERVERS, new Set(), 'steuer', false);
      expect([...off]).toEqualArray(['steuer']);
      expect([...toggleMcpServer(SERVERS, off, 'steuer', true)]).toEqualArray([]);
      expect([...toggleMcpServer(SERVERS, new Set(), 'ghost', false)]).toEqualArray([]);
    });

    await it('does not mutate the set it was given', async () => {
      const off = new Set<string>();
      toggleMcpServer(SERVERS, off, 'steuer', false);
      expect(off.size).toBe(0);
    });
  });

  await describe('mcp-toggles — when a resume is pending', async () => {
    await it('is never pending while the agent holds no list', async () => {
      expect(resumePending(null, [])).toBe(false);
    });

    await it('is pending exactly when the held names differ from the active ones', async () => {
      expect(resumePending(['steuer', 'remote'], SERVERS)).toBe(false);
      expect(resumePending(['remote', 'steuer'], SERVERS)).toBe(false);
      expect(resumePending(['steuer', 'remote'], [SERVERS[0]!])).toBe(true);
      expect(resumePending(['steuer'], SERVERS)).toBe(true);
      expect(resumePending(['steuer', 'other'], SERVERS)).toBe(true);
    });
  });

  await describe('mcp-toggles — the view', async () => {
    await it('is hidden with no servers', async () => {
      const view = mcpTogglesView({ servers: [], off: new Set(), agentHolds: false, resume: null });
      expect(view).toStrictEqual(NO_MCP_TOGGLES);
    });

    await it('lists one toggle per server name, all on by default, named for a screen reader', async () => {
      const view = mcpTogglesView({ servers: SERVERS, off: new Set(), agentHolds: false, resume: null });
      expect(view.visible).toBe(true);
      expect(view.selectable).toBe(true);
      expect(view.toggles.map((t) => t.name)).toEqualArray(['steuer', 'remote']);
      expect(view.toggles.every((t) => t.on)).toBe(true);
      expect(view.toggles[0]?.label).toBe('MCP server steuer');
    });

    await it('collapses duplicate names into one toggle', async () => {
      const view = mcpTogglesView({
        servers: [...SERVERS, SERVERS[0]!],
        off: new Set(),
        agentHolds: false,
        resume: null,
      });
      expect(view.toggles.length).toBe(2);
    });

    await it('disables the toggles only when the agent holds the session and offers no resume', async () => {
      const input = { servers: SERVERS, off: new Set(['remote']) };
      expect(mcpTogglesView({ ...input, agentHolds: true, resume: false }).selectable).toBe(false);
      expect(mcpTogglesView({ ...input, agentHolds: true, resume: true }).selectable).toBe(true);
      expect(mcpTogglesView({ ...input, agentHolds: false, resume: false }).selectable).toBe(true);
      const blocked = mcpTogglesView({ ...input, agentHolds: true, resume: false });
      expect(blocked.toggles[1]?.on).toBe(false);
      expect(blocked.toggles[0]?.tooltip).toBe(
        'This agent cannot change MCP servers in a running conversation.',
      );
    });
  });
};
