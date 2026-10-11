import { describe, expect, it } from '@gjsify/unit';

import type { SessionNotification, SessionUpdate } from '@lotse/acp/types';

import { fitsInputCap, mcpCallsOf, toTranscript } from '@lotse/core';

const AT = '2026-09-30T10:00:00.000Z';

function notification(update: SessionUpdate): SessionNotification {
  return { sessionId: 's1', update };
}

export default async () => {
  await describe('toTranscript — chunk kinds', async () => {
    await it('user_message_chunk keeps its text as kind "user"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
        AT,
      );
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('user');
      expect(entries[0]?.text).toBe('hi');
    });

    await it('agent_message_chunk keeps its text as kind "agent"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }),
        AT,
      );
      expect(entries[0]?.kind).toBe('agent');
      expect(entries[0]?.text).toBe('answer');
    });

    await it('agent_thought_chunk keeps its text as kind "thought"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } }),
        AT,
      );
      expect(entries[0]?.kind).toBe('thought');
      expect(entries[0]?.text).toBe('thinking…');
    });
  });

  await describe('toTranscript — tool calls', async () => {
    await it('tool_call records title + status and the toolCallId', async () => {
      const entries = toTranscript(
        notification({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'read a file',
          status: 'pending',
        }),
        AT,
      );
      expect(entries[0]?.kind).toBe('tool');
      expect(entries[0]?.toolCallId).toBe('call_1');
      expect(entries[0]?.text).toBe('read a file — pending');
    });

    await it('tool_call_update with only a status still records', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
        AT,
      );
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('tool');
      expect(entries[0]?.toolCallId).toBe('call_1');
      // No title, so the status string's own leading space is trimmed but the "— " marker stays.
      expect(entries[0]?.text).toBe('— completed');
    });

    await it('tool_call_update with neither title nor status produces nothing', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1' }),
        AT,
      );
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — plan', async () => {
    await it('becomes one line per entry', async () => {
      const entries = toTranscript(
        notification({
          sessionUpdate: 'plan',
          entries: [
            { content: 'read the file', status: 'completed' },
            { content: 'write the fix', status: 'in_progress' },
          ],
        }),
        AT,
      );
      expect(entries.length).toBe(2);
      expect(entries[0]?.text).toBe('plan: [completed] read the file');
      expect(entries[1]?.text).toBe('plan: [in_progress] write the fix');
      expect(entries.every((e) => e.kind === 'system')).toBe(true);
    });
  });

  await describe('toTranscript — bookkeeping updates that produce nothing', async () => {
    await it('available_commands_update produces no lines', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] }),
        AT,
      );
      expect(entries).toStrictEqual([]);
    });

    await it('config_option_update produces no lines', async () => {
      // Carries three real options, because a `config_option_update` without them is not a thing
      // the protocol allows and a test that used one was asserting on an input no agent sends.
      const entries = toTranscript(
        notification({
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              category: 'model',
              currentValue: 'a/b',
              options: [{ value: 'a/b', name: 'b' }],
            },
            {
              id: 'effort',
              name: 'Effort',
              type: 'select',
              category: 'thought_level',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            },
          ],
        }),
        AT,
      );
      // Configuration is surface state, not conversation: the transcript is a record of what
      // happened in the session, and picking a model is not something that happened in it.
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — usage_update', async () => {
    await it('becomes "usage: in N, out M"', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'usage_update', inputTokens: 120, outputTokens: 45 }),
        AT,
      );
      expect(entries[0]?.kind).toBe('system');
      expect(entries[0]?.text).toBe('usage: in 120, out 45');
    });

    await it('rounds the cost through core/usage, so a float never reaches a transcript line', async () => {
      // The wiring this pins is `toTranscript` calling the shared formatter rather than building its own
      // clause: the value is the one opencode reports, and the old inline `${cost.amount}` printed all
      // seventeen digits of the double into a person's history.
      const entries = toTranscript(
        notification({
          sessionUpdate: 'usage_update',
          inputTokens: 120,
          outputTokens: 45,
          cost: { amount: 0.0014555100000000001, currency: 'USD' },
        }),
        AT,
      );
      expect(entries[0]?.text).toBe('usage: in 120, out 45, 0.0015 USD');
    });
  });

  await describe('toTranscript — session_info_update (title)', async () => {
    await it('records a line when there is a title', async () => {
      const entries = toTranscript(
        notification({ sessionUpdate: 'session_info_update', title: 'New title' }),
        AT,
      );
      expect(entries[0]?.text).toBe('title: New title');
    });

    await it('produces nothing when there is no title', async () => {
      const entries = toTranscript(notification({ sessionUpdate: 'session_info_update' }), AT);
      expect(entries).toStrictEqual([]);
    });
  });

  await describe('toTranscript — an update variant this client does not know', async () => {
    await it('is recorded as one opaque system line rather than dropped or thrown', async () => {
      const update = { sessionUpdate: 'diff_preview', path: '/tmp/x' } as unknown as SessionUpdate;
      const entries = toTranscript(notification(update), AT);
      expect(entries.length).toBe(1);
      expect(entries[0]?.kind).toBe('system');
      expect(entries[0]?.text).toContain('diff_preview');
    });
  });

  // The opencode shapes below are the ones measured on 2026-10-11 (refs/acp/SOURCE.md): a code-mode
  // `execute` call that starts empty, runs with the code as input and completes with its own report.
  await describe('toTranscript — the structured tool record (#43)', async () => {
    await it('keeps only what each line carried', async () => {
      const [first] = toTranscript(
        notification({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'execute',
          kind: 'other',
          status: 'pending',
          rawInput: {},
        }),
        AT,
      );
      expect(first?.text).toBe('execute — pending');
      expect(first?.tool).toStrictEqual({ kind: 'other', title: 'execute', status: 'pending', rawInput: {} });

      const [update] = toTranscript(
        notification({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' }),
        AT,
      );
      expect(update?.tool).toStrictEqual({ status: 'in_progress' });
    });

    await it('reads the code-mode source while the call runs', async () => {
      const [entry] = toTranscript(
        notification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'in_progress',
          rawInput: { code: 'return await tools.probe.probe_echo({ text: "hello" })' },
        }),
        AT,
      );
      expect(entry?.tool?.mcp).toStrictEqual([{ server: 'probe', tool: 'probe_echo', source: 'code' }]);
    });

    await it("prefers opencode's own report once the call completed", async () => {
      const [entry] = toTranscript(
        notification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          rawInput: { code: 'return await tools.probe.probe_echo({ text: "hello" })' },
          rawOutput: {
            output: 'echo: hello',
            metadata: {
              toolCalls: [{ tool: 'probe.probe_echo', status: 'completed', input: { text: 'hello' } }],
              truncated: false,
            },
          },
        }),
        AT,
      );
      expect(entry?.tool?.mcp).toStrictEqual([
        {
          server: 'probe',
          tool: 'probe_echo',
          source: 'reported',
          input: { text: 'hello' },
          status: 'completed',
        },
      ]);
      // The output itself is still not kept — only the input and the report's names.
      expect(JSON.stringify(entry)).not.toContain('echo: hello');
    });

    await it('replaces an input over the 8 KiB cap with a marker', async () => {
      const [entry] = toTranscript(
        notification({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_2',
          title: 'write',
          rawInput: { content: 'x'.repeat(9000) },
        }),
        AT,
      );
      expect(entry?.tool?.rawInput).toBe(undefined);
      expect(entry?.tool?.rawInputOmitted).toBe(true);
    });
  });

  await describe('fitsInputCap', async () => {
    await it('counts UTF-8 bytes of the JSON, not characters', async () => {
      // 3000 × "€" is 3000 characters but 9000 bytes.
      expect(fitsInputCap({ text: 'a'.repeat(3000) })).toBe(true);
      expect(fitsInputCap({ text: '€'.repeat(3000) })).toBe(false);
    });

    await it('counts a value JSON cannot write as over the cap', async () => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      expect(fitsInputCap(cycle)).toBe(false);
      expect(fitsInputCap(undefined)).toBe(false);
    });
  });

  await describe('mcpCallsOf', async () => {
    await it('reads bracket form, dedupes, and ignores some other object\'s "tools"', async () => {
      const code = [
        'await tools["my-server"]["a.b"]({})',
        'await tools.probe.echo(1)',
        'await tools.probe.echo(2)',
        'await mytools.x.y()',
        'await ctx.tools.x.y()',
      ].join('\n');
      expect(mcpCallsOf({ code }, undefined)).toStrictEqual([
        { server: 'my-server', tool: 'a.b', source: 'code' },
        { server: 'probe', tool: 'echo', source: 'code' },
      ]);
    });

    await it('splits a reported name at the first dot', async () => {
      expect(mcpCallsOf(undefined, { metadata: { toolCalls: [{ tool: 'srv.ns.tool' }] } })).toStrictEqual([
        { server: 'srv', tool: 'ns.tool', source: 'reported' },
      ]);
    });

    await it('skips malformed metadata instead of guessing or throwing', async () => {
      const malformed: unknown[] = [
        null,
        'text',
        { metadata: null },
        { metadata: { toolCalls: 'nope' } },
        {
          metadata: { toolCalls: [null, 7, { tool: 3 }, { tool: 'nodot' }, { tool: '.x' }, { tool: 'x.' }] },
        },
      ];
      for (const rawOutput of malformed) expect(mcpCallsOf(undefined, rawOutput)).toStrictEqual([]);
      // A bad report does not hide the code reading.
      expect(
        mcpCallsOf({ code: 'tools.a.b()' }, { metadata: { toolCalls: [{ tool: 'bad' }] } }),
      ).toStrictEqual([{ server: 'a', tool: 'b', source: 'code' }]);
    });

    await it('keeps the call but drops a reported input over the cap', async () => {
      const [call] = mcpCallsOf(undefined, {
        metadata: { toolCalls: [{ tool: 'a.b', status: 7, input: { blob: 'x'.repeat(9000) } }] },
      });
      expect(call).toStrictEqual({ server: 'a', tool: 'b', source: 'reported' });
    });
  });
};
