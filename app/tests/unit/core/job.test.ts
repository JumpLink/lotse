/**
 * `runJob` — one headless job, ADR 0004.
 *
 * **What this suite is for.** A job has nobody watching it, so every promise the ADR makes has to be a
 * measurement here rather than something a person would notice: the answer is a value only in the two
 * accepted shapes, the model gate refuses before a prompt is on the wire, nobody is asked for a
 * permission, a stop sends `session/cancel` and then closes, the process is closed on every path, and
 * nothing the host logs carries the prompt or the answer.
 *
 * Both runtimes, no display, no process: the agent is `FixtureAgent` behind the `open` seam, the same
 * way `agent-session.test.ts` drives the widget's controller. All data is synthetic.
 */

import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import type { PermissionOption } from '@lotse/acp/types';

import {
  JobError,
  OPENCODE_COMMAND,
  jobPrompt,
  runJob,
  type JobLogEntry,
  type JobOptions,
  type ModelDecision,
} from '@lotse/core';
import { FixtureAgent, type FixtureAgentOptions } from '../../support/fixture-agent.ts';

/** A prompt nobody else would write, so "it never reached a log" is a substring check. */
const SECRET_PROMPT = 'Receipt 4711 from Synthetic Bakery, total 12.34 EUR';
const SECRET_ANSWER = 'synthetic-merchant-name';

const ONCE: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
];

const allowAll = (): ModelDecision => 'allow';

interface Receipt {
  readonly merchant: string;
}

function parseReceipt(value: unknown): Receipt {
  if (typeof value !== 'object' || value === null || typeof (value as Receipt).merchant !== 'string') {
    throw new Error('not a receipt');
  }
  return { merchant: (value as Receipt).merchant };
}

interface HarnessOptions extends FixtureAgentOptions {
  readonly failWith?: Error;
}

interface Harness {
  readonly agent: FixtureAgent;
  readonly logs: JobLogEntry[];
  readonly options: (patch?: Partial<JobOptions<Receipt>>) => JobOptions<Receipt>;
  readonly opened: () => number;
  readonly closed: () => number;
  readonly spawnCloserUsed: () => boolean;
}

function harness(fixture: HarnessOptions = {}): Harness {
  const agent = new FixtureAgent(fixture);
  const logs: JobLogEntry[] = [];
  let opened = 0;
  let closed = 0;
  let spawnCloserUsed = false;
  return {
    agent,
    logs,
    opened: () => opened,
    closed: () => closed,
    spawnCloserUsed: () => spawnCloserUsed,
    options: (patch = {}) => ({
      command: OPENCODE_COMMAND,
      cwd: '/fixture',
      prompt: SECRET_PROMPT,
      parse: parseReceipt,
      modelPolicy: allowAll,
      onLog: (entry) => logs.push(entry),
      // The gate `runJob` passes is the gate the client answers with, so a refusal is asserted on the
      // wire (`permissionOutcomes`) and not on a local flag.
      open: async (openOptions) => {
        opened += 1;
        let client: AcpClient | null = null;
        openOptions.onSpawn?.(() => {
          spawnCloserUsed = true;
          client?.close();
        });
        if (fixture.failWith) throw fixture.failWith;
        client = new AcpClient({ transport: agent.transport, gate: openOptions.gate });
        await client.initialize();
        const ready = client;
        return {
          client: ready,
          logLines: [],
          agentInfo: 'FixtureAgent 0.1.0',
          close: () => {
            closed += 1;
            ready.close();
          },
        };
      },
      ...patch,
    }),
  };
}

async function failure(job: Promise<unknown>): Promise<JobError> {
  try {
    await job;
  } catch (error) {
    if (error instanceof JobError) return error;
    throw error;
  }
  throw new Error('the job resolved, a JobError was expected');
}

async function waitUntil(seen: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !seen(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Every log entry as one string — the haystack for "no prompt, no answer". */
const logText = (logs: JobLogEntry[]): string => JSON.stringify(logs);

export default async function job(): Promise<void> {
  await describe('runJob: the answer', async () => {
    await it('takes the whole trimmed message as the value', async () => {
      const h = harness({ chunks: ['  {"merchant":', ` "${SECRET_ANSWER}"}\n`] });
      const result = await runJob(h.options());
      expect(result.value).toStrictEqual({ merchant: SECRET_ANSWER });
      expect(result.sessionId).toBe('ses_fixture_0001');
      expect(result.model).toBe('openrouter/openai/gpt-6.1-sol');
      expect(result.stopReason).toBe('end_turn');
      expect(h.closed()).toBe(1);
    });

    await it('takes the last fenced json block when the message is prose around it', async () => {
      const h = harness({
        chunks: [
          'First guess:\n```json\n{"merchant": "wrong"}\n```\n',
          `Corrected:\n\`\`\`json\n{"merchant": "${SECRET_ANSWER}"}\n\`\`\`\nDone.`,
        ],
      });
      const result = await runJob(h.options());
      expect(result.value.merchant).toBe(SECRET_ANSWER);
      expect(h.closed()).toBe(1);
    });

    await it('fails malformed when there is no JSON, with the raw answer on output', async () => {
      const h = harness({ chunks: ['The merchant is { probably a bakery.'] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('malformed');
      expect(error.output).toBe('The merchant is { probably a bakery.');
      expect(error.message).not.toContain('bakery');
      expect(h.closed()).toBe(1);
    });

    await it("fails invalid when the host's parse rejects, with the parse error as cause", async () => {
      const h = harness({ chunks: ['{"total": 12.34}'] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('invalid');
      expect((error.cause as Error).message).toBe('not a receipt');
      expect(error.output).toBe('{"total": 12.34}');
      expect(h.closed()).toBe(1);
    });

    await it('appends the schema with one fixed instruction, prompt first', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const schema = { type: 'object', required: ['merchant'] };
      await runJob(h.options({ schema }));
      const prompt = h.agent.calls('session/prompt')[0]?.params as { prompt: { text: string }[] };
      expect(prompt.prompt[0]?.text).toBe(jobPrompt(SECRET_PROMPT, schema));
      expect(jobPrompt(SECRET_PROMPT, schema).startsWith(SECRET_PROMPT)).toBe(true);
      expect(jobPrompt(SECRET_PROMPT)).toBe(SECRET_PROMPT);
    });

    await it('forwards mcpServers unchanged and defaults them to none', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      await runJob(h.options());
      const params = h.agent.calls('session/new')[0]?.params as { mcpServers: unknown[]; cwd: string };
      expect(params.mcpServers).toStrictEqual([]);
      expect(params.cwd).toBe('/fixture');
    });
  });

  await describe('runJob: hardening', async () => {
    await it('survives a throwing onLog on every event and still returns the value', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const result = await runJob(
        h.options({
          onLog: () => {
            throw new Error('host logger broke');
          },
        }),
      );
      expect(result.value.merchant).toBe(SECRET_ANSWER);
      expect(h.closed()).toBe(1);
    });

    await it('still fails refused when onLog throws on the gate entry and the turn ends normally', async () => {
      const h = harness({ permissionOptions: ONCE, chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const error = await failure(
        runJob(
          h.options({
            onLog: (entry) => {
              if (entry.source === 'job' && entry.event === 'gate') throw new Error('host logger broke');
            },
          }),
        ),
      );
      expect(error.kind).toBe('refused');
      expect(h.closed()).toBe(1);
    });

    await it('removes its abort listener on every path, even when onLog throws on start', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const controller = new AbortController();
      let removed = 0;
      const remove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
        removed += 1;
        remove(...args);
      }) as typeof remove;
      await runJob(
        h.options({
          signal: controller.signal,
          onLog: (entry) => {
            if (entry.source === 'job' && entry.event === 'start') throw new Error('host logger broke');
          },
        }),
      );
      expect(removed).toBe(1);
    });

    await it('answers with the text after the last tool call, not the narration before it', async () => {
      const h = harness({
        chunks: ['Let me check the receipt. ', `{"merchant":"${SECRET_ANSWER}"}`],
        toolCallAfterChunks: 1,
      });
      const result = await runJob(h.options());
      expect(result.value.merchant).toBe(SECRET_ANSWER);
    });

    await it('parses a huge message of unclosed json openers in linear time', async () => {
      const h = harness({ chunks: ['```json\n'.repeat(50_000)] });
      const started = Date.now();
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('malformed');
      expect(Date.now() - started < 2_000).toBe(true);
    });

    await it('keeps last-block-wins after many unclosed openers', async () => {
      const noise = '```json\n'.repeat(1_000);
      const h = harness({ chunks: [`${noise}\`\`\`json\n{"merchant":"${SECRET_ANSWER}"}\n\`\`\`\n`] });
      const result = await runJob(h.options());
      expect(result.value.merchant).toBe(SECRET_ANSWER);
    });

    await it('rejects a bad timeoutMs with a TypeError before anything starts', async () => {
      for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
        const h = harness();
        let thrown: unknown = null;
        try {
          await runJob(h.options({ timeoutMs }));
        } catch (error) {
          thrown = error;
        }
        expect(thrown instanceof TypeError).toBe(true);
        expect(h.opened()).toBe(0);
      }
    });
  });

  await describe('runJob: the model gate', async () => {
    await it('refuses a denied model before any prompt is sent', async () => {
      const h = harness({ chunks: ['{}'] });
      const error = await failure(runJob(h.options({ modelPolicy: () => 'deny' })));
      expect(error.kind).toBe('denied');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.closed()).toBe(1);
    });

    await it('refuses an explicitly requested denied model without touching the session option', async () => {
      const h = harness({ chunks: ['{}'] });
      const policy = (model: string): ModelDecision => (model.includes('claude') ? 'deny' : 'allow');
      const error = await failure(
        runJob(h.options({ modelPolicy: policy, model: 'openrouter/anthropic/claude-sonnet-5.5' })),
      );
      expect(error.kind).toBe('denied');
      expect(h.agent.configSets.length).toBe(0);
      expect(h.agent.calls('session/prompt').length).toBe(0);
    });

    await it('refuses an unknown model when the agent names none', async () => {
      const h = harness({ configOptions: [], chunks: ['{}'] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('unknown-model');
      expect(h.agent.calls('session/prompt').length).toBe(0);
      expect(h.closed()).toBe(1);
    });

    await it('refuses a requested model the agent does not offer, with no fallback', async () => {
      const h = harness({ chunks: ['{}'] });
      const error = await failure(runJob(h.options({ model: 'nowhere/not-a-model' })));
      expect(error.kind).toBe('unknown-model');
      expect(h.agent.configSets.length).toBe(0);
      expect(h.agent.calls('session/prompt').length).toBe(0);
    });

    await it('selects a requested model through the session option and reports it', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const model = 'openrouter/anthropic/claude-sonnet-5.5';
      const result = await runJob(h.options({ model }));
      expect(h.agent.configSets).toStrictEqual([{ configId: 'model', value: model }]);
      expect(result.model).toBe(model);
    });

    await it('treats the requested model as current when the set answer carries no option list', async () => {
      const h = harness({ bareConfigAnswer: true, chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const model = 'openrouter/anthropic/claude-sonnet-5.5';
      // The agent's default is denied; only the requested model is allowed.
      const policy = (id: string): ModelDecision => (id === model ? 'allow' : 'deny');
      const result = await runJob(h.options({ model, modelPolicy: policy }));
      expect(result.model).toBe(model);
    });

    await it('throws a TypeError when a JS caller passes no policy, before anything starts', async () => {
      const h = harness();
      const options = { ...h.options(), modelPolicy: undefined } as unknown as JobOptions<Receipt>;
      let thrown: unknown = null;
      try {
        await runJob(options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof TypeError).toBe(true);
      expect(h.opened()).toBe(0);
    });
  });

  await describe('runJob: permissions', async () => {
    await it('declines every permission by default and fails refused', async () => {
      const h = harness({ permissionOptions: ONCE, chunks: ['{}'] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('refused');
      expect(h.agent.permissionOutcomes[0]?.outcome.outcome).toBe('cancelled');
      expect(h.closed()).toBe(1);
    });

    await it("turns a host's always-grant into a decline", async () => {
      const h = harness({ permissionOptions: ONCE, chunks: ['{}'] });
      const error = await failure(runJob(h.options({ gate: async () => 'allow_always' })));
      expect(error.kind).toBe('refused');
      expect(h.agent.permissionOutcomes[0]?.outcome.outcome).toBe('cancelled');
    });

    await it('turns a throwing host gate into a decline', async () => {
      const h = harness({ permissionOptions: ONCE, chunks: ['{}'] });
      const error = await failure(
        runJob(
          h.options({
            gate: async () => {
              throw new Error('host gate broke');
            },
          }),
        ),
      );
      expect(error.kind).toBe('refused');
    });

    await it("lets a host's allow_once through", async () => {
      const h = harness({ permissionOptions: ONCE, chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      const result = await runJob(h.options({ gate: async () => 'allow_once' }));
      expect(result.value.merchant).toBe(SECRET_ANSWER);
      expect(h.agent.permissionOutcomes[0]).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });
    });
  });

  await describe('runJob: stopping', async () => {
    await it('times out a held turn: session/cancel, then close', async () => {
      const h = harness({ holdTurn: true, chunks: ['{}'] });
      const error = await failure(runJob(h.options({ timeoutMs: 30 })));
      expect(error.kind).toBe('timeout');
      expect(h.agent.calls('session/cancel').length).toBe(1);
      expect(h.closed()).toBe(1);
    });

    await it('times out a handshake that never ends through the spawn closer', async () => {
      const h = harness({ hangOnInitialize: true });
      const error = await failure(runJob(h.options({ timeoutMs: 30 })));
      expect(error.kind).toBe('timeout');
      expect(h.spawnCloserUsed()).toBe(true);
      expect(h.agent.calls('session/new').length).toBe(0);
    });

    await it('refuses an already aborted signal without opening an agent', async () => {
      const h = harness();
      const controller = new AbortController();
      controller.abort();
      const error = await failure(runJob(h.options({ signal: controller.signal })));
      expect(error.kind).toBe('cancelled');
      expect(h.opened()).toBe(0);
    });

    await it('cancels a running turn on abort: session/cancel, then close', async () => {
      const h = harness({ holdTurn: true, chunks: ['{}'] });
      const controller = new AbortController();
      const running = runJob(h.options({ signal: controller.signal }));
      await waitUntil(() => h.agent.calls('session/prompt').length > 0);
      controller.abort();
      const error = await failure(running);
      expect(error.kind).toBe('cancelled');
      expect(h.agent.calls('session/cancel').length).toBe(1);
      expect(h.closed()).toBe(1);
    });
  });

  await describe('runJob: the agent', async () => {
    await it('fails agent when the process cannot start', async () => {
      const h = harness({ failWith: new Error('spawn failed') });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('agent');
      expect(h.spawnCloserUsed()).toBe(true);
    });

    await it('fails agent when the process ends mid-turn, and still closes it', async () => {
      const h = harness({ holdTurn: true, chunks: ['{}'] });
      const running = runJob(h.options());
      await waitUntil(() => h.agent.calls('session/prompt').length > 0);
      h.agent.vanish();
      const error = await failure(running);
      expect(error.kind).toBe('agent');
      expect(h.closed()).toBe(1);
    });

    await it('fails auth when the provider refuses the account on the prompt', async () => {
      const h = harness({ promptAuth: true });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('auth');
      expect(h.closed()).toBe(1);
    });

    await it('fails refused when the turn ends with anything but end_turn', async () => {
      const h = harness({ stopReason: 'max_tokens', chunks: ['{"merchant":'] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('refused');
      expect(h.closed()).toBe(1);
    });
  });

  await describe('runJob: logging', async () => {
    await it('logs ids and kinds, never the prompt or the answer — on success', async () => {
      const h = harness({ chunks: [`{"merchant":"${SECRET_ANSWER}"}`] });
      await runJob(h.options({ schema: { type: 'object' } }));
      const text = logText(h.logs);
      expect(text).not.toContain('Receipt 4711');
      expect(text).not.toContain(SECRET_ANSWER);
      expect(h.logs.some((entry) => entry.source === 'job' && entry.event === 'end')).toBe(true);
    });

    await it('logs nothing of the prompt or answer on failures, and neither does the message', async () => {
      const h = harness({ chunks: [`{"merchant": 1, "note": "${SECRET_ANSWER}"}`] });
      const error = await failure(runJob(h.options()));
      expect(error.kind).toBe('invalid');
      const text = logText(h.logs);
      expect(text).not.toContain('Receipt 4711');
      expect(text).not.toContain(SECRET_ANSWER);
      expect(error.message).not.toContain(SECRET_ANSWER);
      expect(h.logs.at(-1)).toStrictEqual({
        source: 'job',
        event: 'error',
        detail: { kind: 'invalid', session: 'ses_fixture_0001' },
      });
    });
  });
}
