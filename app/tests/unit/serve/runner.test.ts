import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import type { PermissionOption } from '@lotse/acp/types';

import {
  OPENCODE_COMMAND,
  answerQuestion,
  cancelOrphanedPermissions,
  attemptClock,
  dueTasks,
  nextWakeMs,
  parseServeConfig,
  parseVerdict,
  precheckText,
  runTask,
  type Question,
  type ServeConfig,
  type ServeDeps,
  type ServeLogEntry,
  type ServeMessage,
} from '@lotse/core';
import { FixtureAgent, type FixtureAgentOptions } from '../../support/fixture-agent.ts';

const START = Date.parse('2026-10-10T12:00:00.000Z');

const ONCE: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
];

function config(
  patch: {
    profile?: Record<string, unknown>;
    task?: Record<string, unknown>;
    extraProfiles?: Record<string, unknown>[];
  } = {},
): ServeConfig {
  return parseServeConfig(
    JSON.stringify({
      version: 1,
      users: [{ id: 'me' }],
      profiles: [{ id: 'p', user: 'me', data: 'public', ...patch.profile }, ...(patch.extraProfiles ?? [])],
      tasks: [
        {
          id: 't',
          profile: 'p',
          schedule: { every: '1h' },
          prompt: 'Do the thing.',
          cwd: '/fixture',
          ...patch.task,
        },
      ],
    }),
  );
}

interface Harness {
  readonly deps: ServeDeps;
  readonly agents: FixtureAgent[];
  readonly sent: ServeMessage[];
  readonly log: ServeLogEntry[];
  book: Question[];
  /** Runs on every poll of a waiting permission request — where a test plays the person. */
  onSleep: () => Promise<void> | void;
  /** Advance the clock by this much per poll. */
  step: number;
}

function harness(serveConfig: ServeConfig, agentOptions: FixtureAgentOptions = {}): Harness {
  let at = START;
  const h: Harness = {
    agents: [],
    sent: [],
    log: [],
    book: [],
    onSleep: () => {},
    step: 2_000,
    deps: undefined as unknown as ServeDeps,
  };
  (h as { deps: ServeDeps }).deps = {
    config: serveConfig,
    open: async (options) => {
      const agent = new FixtureAgent(agentOptions);
      h.agents.push(agent);
      const client = new AcpClient({ transport: agent.transport, gate: options.gate });
      await client.initialize();
      return { client, logLines: [], agentInfo: 'FixtureAgent 0.1.0', close: () => client.close() };
    },
    commandFor: () => OPENCODE_COMMAND,
    promptFor: (task) => task.prompt ?? '',
    channel: { name: 'fake', send: (_user, message) => void h.sent.push(message) },
    questions: {
      read: () => h.book.map((question) => ({ ...question })),
      write: (next) => void (h.book = [...next]),
    },
    now: () => new Date(at),
    sleep: async () => {
      at += h.step;
      await h.onSleep();
    },
    log: (entry) => void h.log.push(entry),
  };
  return h;
}

export default async () => {
  await describe('runTask', async () => {
    await it('a plain run ends done and hands the reply to the caller', async () => {
      const h = harness(config());
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(run.reply).toBe('answer');
      expect(run.sessionId).toBe('ses_fixture_0001');
      expect(h.sent.length).toBe(0);
      expect(h.agents[0]!.calls('session/new').length).toBe(1);
    });

    await it('notify "always" sends the reply', async () => {
      const h = harness(config({ task: { notify: 'always' } }));
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(h.sent[0]!.body).toBe('answer');
    });

    await it('a final message ending in "?" becomes a reply question and a notification', async () => {
      const h = harness(config(), { chunks: ['Found two. Shall I archive them?'] });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('asked');
      expect(run.questionId).toBe('A1');
      expect(h.book[0]!.kind).toBe('reply');
      expect(h.book[0]!.sessionId).toBe('ses_fixture_0001');
      expect(h.sent[0]!.questionId).toBe('A1');
      expect(h.sent[0]!.body).toContain('lotse answer A1');
    });

    await it('a permission request waits for `answer yes`, then allows once', async () => {
      const h = harness(config(), { permissionOptions: ONCE });
      h.onSleep = async () => {
        if (h.book[0]?.status === 'open') {
          const answered = await answerQuestion('#A1', 'ja', h.deps);
          expect(answered.mode).toBe('allowed');
        }
      };
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(h.book[0]!.kind).toBe('permission');
      expect(h.agents[0]!.permissionAsked[0]!.map((option) => option.kind)).toContain('allow_always');
      const outcome = h.agents[0]!.permissionOutcomes[0]!.outcome;
      expect(outcome.outcome === 'selected' ? outcome.optionId : null).toBe('allow_once');
    });

    await it('a permission nobody answers expires, is cancelled, and the run is declined', async () => {
      const h = harness(config({ task: { questions: { expiresIn: '30m' } } }), { permissionOptions: ONCE });
      h.step = 3_600_000;
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('declined');
      expect(h.book[0]!.status).toBe('expired');
      expect(h.agents[0]!.permissionOutcomes[0]!.outcome.outcome).toBe('cancelled');
      expect(h.sent.some((message) => message.title.includes('expired'))).toBe(true);
    });

    await it('read rights decline without a question', async () => {
      const h = harness(config({ task: { rights: 'read' } }), { permissionOptions: ONCE });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('declined');
      expect(h.book.length).toBe(0);
    });

    await it('the open-question ceiling skips the run before any agent starts', async () => {
      const h = harness(config({ task: { questions: { maxOpen: 1 } } }), { chunks: ['Shall I?'] });
      await runTask(h.deps.config.tasks[0]!, h.deps);
      const second = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(second.outcome).toBe('skipped');
      expect(h.agents.length).toBe(1);
    });

    await it('a pinned model the agent does not offer fails the run and tells the person', async () => {
      const h = harness(config({ profile: { data: 'private', model: 'provider/not-offered' } }));
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('failed');
      expect(run.reason).toContain('provider/not-offered');
      expect(h.sent[0]!.title).toContain('stopped');
    });

    await it('a pinned model the agent offers is set on the session', async () => {
      const h = harness(config({ profile: { data: 'private', model: 'github-copilot/gpt-5.5-codex' } }));
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(h.agents[0]!.configSets[0]).toStrictEqual({
        configId: 'model',
        value: 'github-copilot/gpt-5.5-codex',
      });
    });

    await it('a run held by another process is skipped', async () => {
      const h = harness(config());
      const run = await runTask(h.deps.config.tasks[0]!, { ...h.deps, lock: () => null });
      expect(run.outcome).toBe('skipped');
      expect(h.agents.length).toBe(0);
    });
  });

  await describe('precheck', async () => {
    const PRECHECK = { precheck: { prompt: 'Anything new?' } };

    await it('reads the verdict off the last line, and nothing else', async () => {
      expect(parseVerdict('Two new mails.\nWORK')).toBe('work');
      expect(parseVerdict('Nothing since the last run.\n\n**NOTHING.**\n')).toBe('nothing');
      expect(parseVerdict('WORK\nbut maybe not')).toBe(null);
      expect(parseVerdict('')).toBe(null);
    });

    await it('puts the last run in front of the prompt', async () => {
      expect(precheckText('Anything new?', null)).toBe('This task has not run before.\n\nAnything new?');
      expect(
        precheckText('Anything new?', { startedAt: '2026-10-11T05:00:00.000Z', outcome: 'failed' }),
      ).toBe('Last run of this task: 2026-10-11T05:00:00.000Z (outcome: failed).\n\nAnything new?');
    });

    await it('NOTHING ends the run as "nothing" and never starts the task', async () => {
      const h = harness(config({ task: PRECHECK }), { chunks: ['No new messages.\nNOTHING'] });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('nothing');
      expect(run.precheck).toBe('nothing');
      expect(h.agents.length).toBe(1);
      expect(JSON.stringify(h.agents[0]!.calls('session/prompt')[0]!.params)).toContain('Anything new?');
      expect(h.log.some((entry) => entry.event === 'precheck')).toBe(true);
    });

    await it('WORK starts the task in a fresh agent', async () => {
      const h = harness(config({ task: PRECHECK }), { chunks: ['One new mail.\nWORK'] });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(run.precheck).toBe('work');
      expect(h.agents.length).toBe(2);
      expect(JSON.stringify(h.agents[1]!.calls('session/prompt')[0]!.params)).toContain('Do the thing.');
    });

    await it('no verdict fails the run and the task does not start', async () => {
      const h = harness(config({ task: PRECHECK }), { chunks: ['I am not sure.'] });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('failed');
      expect(run.reason).toContain('WORK or NOTHING');
      expect(h.agents.length).toBe(1);
    });

    await it('declines every permission request without a question, and asks nothing', async () => {
      const h = harness(config({ task: PRECHECK }), {
        chunks: ['Shall I?\nNOTHING'],
        permissionOptions: ONCE,
      });
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('nothing');
      expect(h.book.length).toBe(0);
      const outcome = h.agents[0]!.permissionOutcomes[0]!.outcome;
      expect(outcome.outcome === 'selected' ? outcome.optionId : null).toBe('reject_once');
    });

    await it("gets the first turn's servers, never the answer turn's", async () => {
      const h = harness(
        config({
          task: {
            ...PRECHECK,
            mcpServers: [{ name: 'read-only', command: 'x', args: [], env: [] }],
            answerMcpServers: [{ name: 'writing', command: 'x', args: [], env: [] }],
          },
        }),
        { chunks: ['NOTHING'] },
      );
      await runTask(h.deps.config.tasks[0]!, h.deps);
      const params = JSON.stringify(h.agents[0]!.calls('session/new')[0]!.params);
      expect(params).toContain('read-only');
      expect(params).not.toContain('writing');
    });

    await it("runs on its own profile's model, or sends no model at all", async () => {
      const own = harness(
        config({
          task: { precheck: { profile: 'cheap', prompt: 'Anything new?' } },
          extraProfiles: [
            { id: 'cheap', user: 'me', data: 'private', model: 'github-copilot/gpt-5.5-codex' },
          ],
        }),
        { chunks: ['NOTHING'] },
      );
      await runTask(own.deps.config.tasks[0]!, own.deps);
      expect(own.agents[0]!.configSets[0]).toStrictEqual({
        configId: 'model',
        value: 'github-copilot/gpt-5.5-codex',
      });

      const fallback = harness(
        config({ profile: { model: 'github-copilot/gpt-5.5-codex' }, task: PRECHECK }),
        { chunks: ['WORK'] },
      );
      await runTask(fallback.deps.config.tasks[0]!, fallback.deps);
      expect(fallback.agents[0]!.configSets.length).toBe(0);
      expect(fallback.agents[1]!.configSets.length).toBe(1);
    });

    await it('a profile without a model sends none', async () => {
      const h = harness(config({ profile: { data: 'private' } }));
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(h.agents[0]!.configSets.length).toBe(0);
    });
  });

  await describe('answerQuestion', async () => {
    const asked = async (agentOptions: FixtureAgentOptions) => {
      const h = harness(config(), { chunks: ['Shall I?'] });
      await runTask(h.deps.config.tasks[0]!, h.deps);
      const next = harness(h.deps.config, agentOptions);
      next.book = h.book;
      return next;
    };

    await it('continues the session with session/load when the agent offers it', async () => {
      const h = await asked({});
      const result = await answerQuestion('A1', 'archive the older one', h.deps);
      expect(result.mode).toBe('loaded');
      expect(result.message).toContain('session/load');
      expect(h.agents[0]!.calls('session/load').length).toBe(1);
      expect(h.book[0]!.status).toBe('answered');
      expect(h.book[0]!.answer).toBe('text');
      expect(JSON.stringify(h.book)).not.toContain('archive the older one');
    });

    await it('hands the answer turn answerMcpServers, and the first turn mcpServers', async () => {
      const first = harness(
        config({
          task: {
            mcpServers: [{ name: 'read-only', command: 'x', args: [], env: [] }],
            answerMcpServers: [{ name: 'writing', command: 'x', args: [], env: [] }],
          },
        }),
        { chunks: ['Shall I?'] },
      );
      await runTask(first.deps.config.tasks[0]!, first.deps);
      expect(JSON.stringify(first.agents[0]!.calls('session/new')[0]!.params)).toContain('read-only');
      expect(JSON.stringify(first.agents[0]!.calls('session/new')[0]!.params)).not.toContain('writing');
      const next = harness(first.deps.config, {});
      next.book = first.book;
      await answerQuestion('A1', 'yes', next.deps);
      const params = JSON.stringify(next.agents[0]!.calls('session/load')[0]!.params);
      expect(params).toContain('writing');
      expect(params).not.toContain('read-only');
    });

    await it('falls back to session/resume', async () => {
      const h = await asked({ omitLoadSession: true });
      const result = await answerQuestion('A1', 'yes', h.deps);
      expect(result.mode).toBe('resumed');
      expect(h.agents[0]!.calls('session/resume').length).toBe(1);
    });

    await it('starts a follow-up run with context when the agent can do neither', async () => {
      const h = await asked({ capabilities: { loadSession: false, sessionCapabilities: {} } });
      const result = await answerQuestion('A1', 'archive both', h.deps);
      expect(result.mode).toBe('follow-up');
      expect(result.message).toContain('follow-up');
      const prompt = JSON.stringify(h.agents[0]!.calls('session/prompt')[0]!.params);
      expect(prompt).toContain('Shall I?');
      expect(prompt).toContain('archive both');
    });

    await it('a second answer to the same question is dropped', async () => {
      const h = await asked({});
      await answerQuestion('A1', 'yes', h.deps);
      const again = await answerQuestion('A1', 'yes', h.deps);
      expect(again.mode).toBe('dropped');
      expect(h.agents.length).toBe(1);
    });

    await it('an unknown id and a bad id say so', async () => {
      const h = harness(config());
      expect((await answerQuestion('A9', 'yes', h.deps)).mode).toBe('unknown');
      expect((await answerQuestion('nope', 'yes', h.deps)).mode).toBe('unknown');
    });

    await it('a permission question takes only yes or no', async () => {
      const h = harness(config());
      h.book = [
        {
          id: 'A1',
          user: 'me',
          task: 't',
          kind: 'permission',
          sessionId: 'ses_1',
          action: { tool: 'write', kind: 'edit', digest: 'd' },
          text: 'Allow once: write',
          createdAt: new Date(START).toISOString(),
          expiresAt: new Date(START + 3_600_000).toISOString(),
          status: 'open',
          answer: null,
          answeredAt: null,
          resolution: null,
        },
      ];
      expect((await answerQuestion('A1', 'maybe later', h.deps)).mode).toBe('invalid');
      expect(cancelOrphanedPermissions(h.deps)).toBe(1);
      expect((await answerQuestion('A1', 'yes', h.deps)).mode).toBe('dropped');
    });
  });

  await describe('dueTasks', async () => {
    await it('leaves out a task that is already running', async () => {
      const serveConfig = config();
      const now = new Date(START);
      expect(dueTasks(serveConfig, () => null, new Set(), now).length).toBe(1);
      expect(dueTasks(serveConfig, () => null, new Set(['t']), now).length).toBe(0);
      expect(dueTasks(serveConfig, () => now, new Set(), now).length).toBe(0);
    });

    await it('counts a skip, so a task at its ceiling is not due again at once', async () => {
      const serveConfig = config();
      const now = new Date(START);
      const clock = attemptClock(() => new Date(now.getTime() - 2 * 3_600_000));
      expect(dueTasks(serveConfig, clock.lastRun, new Set(), now).length).toBe(1);
      clock.skipped('t', now);
      expect(dueTasks(serveConfig, clock.lastRun, new Set(), now).length).toBe(0);
      expect(nextWakeMs(serveConfig, clock.lastRun, now)).toBe(60_000);
    });
  });
};
