import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpClient } from '@lotse/acp/client';
import {
  McpLink,
  OPENCODE_COMMAND,
  TaskFileError,
  TaskUsageError,
  abortableSleep,
  connectMcp,
  parseParamPairs,
  parseRunArgs,
  parseServeConfig,
  parseProfiles,
  parseSkillTask as parseSkill,
  renderTask,
  runReceiveLoop,
  runTask,
  serveTaskOf,
  type Cursor,
  type CursorStore,
  type MessengerSettings,
  type Question,
  type ServeConfig,
  type ServeDeps,
} from '@lotse/core';

import { listTasks, loadTasks, migrateTasks, readSkill } from '../../../src/core/serve-config.ts';
import {
  EXIT,
  reportText,
  runReport,
  runReportFromText,
  statusReport,
  statusText,
  tasksOf,
  tasksText,
} from '../../../src/frontends/cli/task-commands.ts';
import { FixtureAgent, type FixtureAgentOptions } from '../../support/fixture-agent.ts';
import { withFakeMcp } from '../../support/fake-mcp.ts';

const START = Date.parse('2026-10-10T12:00:00.000Z');
const server = (name: string) => ({ name, command: 'x', args: [], env: [] });
const parseSkillTask = (id: string, text: string, options: { cwd?: string } = { cwd: '/fixture' }) =>
  parseSkill(id, text, options);
const SHARED = JSON.stringify({
  version: 1,
  profiles: [{ id: 'p', data: 'public', mcpServers: [server('a'), server('b')] }],
});

function config(task: Record<string, unknown> = {}): ServeConfig {
  return parseServeConfig(
    JSON.stringify({
      version: 1,
      users: [{ id: 'me' }],
      profiles: [{ id: 'p', user: 'me' }],
      tasks: [{ id: 'legacy', profile: 'p', prompt: 'Do the thing.', cwd: '/fixture', ...task }],
    }),
    { profiles: parseProfiles(SHARED) },
  );
}

const SKILL = `---
name: demo
description: A demo task
allowed-tools: a
metadata:
  lotse-profile: p
  lotse-params: topic, day=today
---
Report on {{topic}} for {{day}}.
`;

function deps(cfg: ServeConfig, skills: Record<string, string>, agentOptions: FixtureAgentOptions = {}) {
  let at = START;
  const state = {
    agents: [] as FixtureAgent[],
    book: [] as Question[],
    records: [] as string[],
    prompts: [] as string[],
    locked: false,
  };
  const value: ServeDeps = {
    config: cfg,
    open: async (options) => {
      const agent = new FixtureAgent(agentOptions);
      state.agents.push(agent);
      const client = new AcpClient({ transport: agent.transport, gate: options.gate });
      await client.initialize();
      return { client, logLines: [], agentInfo: 'FixtureAgent 0.1.0', close: () => client.close() };
    },
    commandFor: () => OPENCODE_COMMAND,
    promptFor: (task) => task.prompt ?? '',
    skill: (id) => (id in skills ? parseSkillTask(id, skills[id]!, { cwd: '/fixture' }) : null),
    record: (run) => void state.records.push(run.outcome),
    channel: { name: 'fake', send: () => {} },
    questions: {
      read: () => state.book.map((question) => ({ ...question })),
      write: (next) => void (state.book = [...next]),
    },
    now: () => new Date(at),
    sleep: async () => void (at += 2_000),
    lock: () => (state.locked ? null : () => {}),
  };
  return { deps: value, state };
}

function throwsA(kind: new (...args: never[]) => Error, body: () => unknown): boolean {
  try {
    body();
  } catch (error) {
    return error instanceof kind;
  }
  return false;
}

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-tasks-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SETTINGS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: 'main',
  peer: 'person@example.org',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export default async () => {
  await describe('SKILL.md', async () => {
    await it('parses the frontmatter, the metadata and the body', async () => {
      const skill = parseSkillTask('demo', SKILL);
      expect(skill.description).toBe('A demo task');
      expect(skill.allowedTools).toStrictEqual(['a']);
      expect(skill.profile).toBe('p');
      expect(skill.params).toStrictEqual([
        { name: 'topic', default: null },
        { name: 'day', default: 'today' },
      ]);
    });

    await it('the name must be the directory, and a typo in a lotse key is reported', async () => {
      expect(throwsA(TaskFileError, () => parseSkillTask('other', SKILL))).toBe(true);
      expect(
        throwsA(TaskFileError, () => parseSkillTask('demo', SKILL.replace('lotse-params', 'lotse-paramz'))),
      ).toBe(true);
    });

    await it('fills params, uses defaults, rejects unknown and missing ones', async () => {
      const skill = parseSkillTask('demo', SKILL);
      expect(renderTask(skill, { topic: 'mail' }).prompt).toBe('Report on mail for today.');
      expect(throwsA(TaskUsageError, () => renderTask(skill, {}))).toBe(true);
      expect(throwsA(TaskUsageError, () => renderTask(skill, { topic: 'x', nope: 'y' }))).toBe(true);
      expect(throwsA(TaskUsageError, () => parseParamPairs(['novalue']))).toBe(true);
      expect(parseRunArgs('demo topic="a b"').params['topic']).toBe('a b');
    });

    await it('a task narrows its profile and never widens it', async () => {
      const cfg = config();
      const narrowed = serveTaskOf(parseSkillTask('demo', SKILL), cfg);
      expect(narrowed.mcpServers.map((s) => s.name)).toStrictEqual(['a']);
      const wider = parseSkillTask('demo', SKILL.replace('allowed-tools: a', 'allowed-tools: a c'));
      expect(throwsA(TaskFileError, () => serveTaskOf(wider, cfg))).toBe(true);
    });
  });

  await describe('runTask', async () => {
    await it('done: the reply is the output, the run is recorded', async () => {
      const { deps: d, state } = deps(config(), { demo: SKILL });
      const result = await runTask('demo', { topic: 'mail' }, d);
      expect(result).toStrictEqual({ status: 'done', output: 'answer' });
      expect(state.records).toStrictEqual(['done']);
    });

    await it('needs-person: a final question becomes an open question', async () => {
      const { deps: d } = deps(config(), { demo: SKILL }, { chunks: ['Shall I archive them?'] });
      const result = await runTask('demo', { topic: 'mail' }, d);
      expect(result).toStrictEqual({ status: 'needs-person', questionId: 'A1' });
    });

    await it('failed: a profile the file names but tasks.json lacks', async () => {
      const { deps: d } = deps(config(), { demo: SKILL.replace('lotse-profile: p', 'lotse-profile: zz') });
      const result = await runTask('demo', { topic: 'x' }, d);
      expect(result.status).toBe('failed');
    });

    await it('a held lock is failed "locked", starts no agent and is not recorded', async () => {
      const { deps: d, state } = deps(config(), { demo: SKILL });
      state.locked = true;
      const result = await runTask('demo', { topic: 'x' }, d);
      expect(result).toStrictEqual({ status: 'failed', reason: 'locked' });
      expect(state.agents.length).toBe(0);
      expect(state.records.length).toBe(0);
    });

    await it('a task of tasks.json runs as a task; it takes no params; unknown ids are usage errors', async () => {
      const { deps: d } = deps(config(), {});
      expect((await runTask('legacy', {}, d)).status).toBe('done');
      let usage = 0;
      for (const [id, params] of [
        ['legacy', { a: 'b' }],
        ['missing', {}],
      ] as const)
        await runTask(id, params, d).catch((error: unknown) => {
          if (error instanceof TaskUsageError) usage += 1;
        });
      expect(usage).toBe(2);
    });
  });

  await describe('exit codes', async () => {
    await it('0 done, 1 failed, 2 usage, 3 needs a person', async () => {
      const done = await runReport('demo', { topic: 'x' }, deps(config(), { demo: SKILL }).deps);
      expect(done.code).toBe(EXIT.done);
      const asked = await runReport(
        'demo',
        { topic: 'x' },
        deps(config(), { demo: SKILL }, { chunks: ['Really?'] }).deps,
      );
      expect(asked.code).toBe(EXIT['needs-person']);
      const bad = deps(config(), { demo: SKILL.replace('lotse-profile: p', 'lotse-profile: zz') });
      expect((await runReport('demo', { topic: 'x' }, bad.deps)).code).toBe(EXIT.failed);
      const usage = await runReport('demo', {}, deps(config(), { demo: SKILL }).deps);
      expect(usage.code).toBe(EXIT.usage);
      expect(reportText(usage)).toContain('topic');
    });
  });

  await describe('migrateTasks', async () => {
    const write = (dir: string) => {
      const file = join(dir, 'tasks.json');
      writeFileSync(file, JSON.stringify(rawConfig()));
      writeFileSync(join(dir, 'profiles.json'), SHARED);
      return file;
    };
    const rawConfig = () => ({
      version: 1,
      users: [{ id: 'me' }],
      profiles: [{ id: 'p', user: 'me' }],
      tasks: [{ id: 'legacy', profile: 'p', prompt: 'Do the thing.', cwd: '/fixture' }],
    });

    await it('writes one SKILL.md per task, once, and leaves tasks.json alone', async () => {
      withDir((dir) => {
        const file = write(dir);
        const before = readFileSync(file, 'utf8');
        const loaded = loadTasks(file, join(dir, 'profiles.json'));
        const tasksDir = join(dir, 'tasks');
        expect(migrateTasks(loaded, tasksDir)).toStrictEqual(['legacy']);
        expect(readSkill(tasksDir, 'legacy')!.body).toBe('Do the thing.');
        expect(migrateTasks(loaded, tasksDir)).toStrictEqual([]);
        expect(readFileSync(file, 'utf8')).toBe(before);
      });
    });

    await it('never overwrites a directory that exists', async () => {
      withDir((dir) => {
        const loaded = loadTasks(write(dir), join(dir, 'profiles.json'));
        const tasksDir = join(dir, 'tasks');
        mkdirSync(join(tasksDir, 'legacy'), { recursive: true });
        writeFileSync(join(tasksDir, 'legacy', 'mine'), 'mine');
        expect(migrateTasks(loaded, tasksDir)).toStrictEqual([]);
        expect(existsSync(join(tasksDir, 'legacy', 'SKILL.md'))).toBe(false);
      });
    });

    await it('lists SKILL.md tasks first, a broken one with its problem, then tasks.json', async () => {
      withDir((dir) => {
        const tasksDir = join(dir, 'tasks');
        mkdirSync(join(tasksDir, 'demo'), { recursive: true });
        writeFileSync(join(tasksDir, 'demo', 'SKILL.md'), SKILL);
        mkdirSync(join(tasksDir, 'broken'), { recursive: true });
        writeFileSync(join(tasksDir, 'broken', 'SKILL.md'), 'no frontmatter');
        const entries = listTasks(tasksDir, config());
        expect(entries.map((entry) => `${entry.id}:${entry.source}`)).toStrictEqual([
          'broken:skill',
          'demo:skill',
          'legacy:tasks.json',
        ]);
        expect(entries[0]!.problem).not.toBe(null);
        expect(tasksText(entries)).toContain('demo (topic, day=today)');
      });
    });
  });

  await describe('chat commands', async () => {
    await it('/tasks, /status and a bad /run reply without a model call', async () => {
      await withFakeMcp({}, async (fake) => {
        const { deps: d, state } = deps(config(), { demo: SKILL });
        withDir(() => {});
        const link = new McpLink(() => connectMcp(fake.command));
        const abort = new AbortController();
        const cursor: CursorStore & { value: Cursor | null } = {
          value: { at: '2026-10-10T11:00:00.000Z', seen: [] },
          read: () => cursor.value,
          write: (next) => void (cursor.value = next),
        };
        const paths = { stateDir: '/nonexistent-lotse-state', tasksDir: '/nonexistent-lotse-tasks' } as never;
        const loop = runReceiveLoop({
          link,
          settings: SETTINGS,
          serve: d,
          cursor,
          signal: abort.signal,
          timeoutS: 1,
          minCycleMs: 0,
          backoff: { initialMs: 10, maxMs: 40 },
          sleep: (_ms, signal) => abortableSleep(10, signal),
          commands: {
            run: async (args) => reportText(await runReportFromText(args, d)),
            tasks: () => tasksText(tasksOf(paths, d.config)),
            status: () => statusText(statusReport(paths)),
          },
        });
        try {
          fake.deliver('2026-10-10T11:30:00.000Z', '/tasks');
          fake.deliver('2026-10-10T11:31:00.000Z', '/status');
          fake.deliver('2026-10-10T11:32:00.000Z', '/run nosuchtask');
          const sent = () =>
            fake
              .calls()
              .filter((call) => call.tool === 'send_message')
              .map((call) => String(call.args['text']));
          await until(() => sent().length === 3, 'three replies');
          expect(sent()[0]).toContain('legacy');
          expect(sent()[1]).toContain('Nothing is running.');
          expect(sent()[2]).toContain('Not started');
          expect(state.agents.length).toBe(0);
        } finally {
          abort.abort();
          await loop;
          await link.close();
        }
      });
    });
  });
};
