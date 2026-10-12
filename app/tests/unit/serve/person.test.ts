import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';

import {
  OPENCODE_COMMAND,
  REDACTED,
  answerQuestion,
  parsePersonReply,
  parseServeConfig,
  personRefusal,
  runTask,
  type PersonHandler,
  type PersonNeededInput,
  type PersonOutcome,
  type Question,
  type ServeConfig,
  type ServeDeps,
  type ServeLogEntry,
  type ServeMessage,
} from '@lotse/core';
import { FixtureAgent } from '../../support/fixture-agent.ts';

const START = Date.parse('2026-10-10T12:00:00.000Z');
const CODE = 'K7x9Q2';

const INPUT: PersonNeededInput = {
  kind: 'code',
  origin: 'example.test',
  prompt: 'Enter the code from your authenticator app.',
  acceptsCode: true,
};

function config(profile: Record<string, unknown> = {}, task: Record<string, unknown> = {}): ServeConfig {
  return parseServeConfig(
    JSON.stringify({
      version: 1,
      users: [{ id: 'me' }],
      profiles: [{ id: 'p', user: 'me', data: 'public', model: 'github-copilot/gpt-5.5-codex', ...profile }],
      tasks: [
        {
          id: 't',
          profile: 'p',
          schedule: { every: '1h' },
          prompt: 'Do the thing.',
          cwd: '/fixture',
          personNeeded: { enabled: true },
          ...task,
        },
      ],
    }),
  );
}

interface Harness {
  readonly deps: ServeDeps;
  readonly sent: ServeMessage[];
  readonly log: ServeLogEntry[];
  readonly returns: string[];
  book: Question[];
  onSleep: () => Promise<void> | void;
  step: number;
}

/**
 * A run whose agent calls `person_needed` the way the real one would: once, just before its turn
 * answers. The fixture agent calls no tools, so the harness makes the call through the handler the
 * fake host was given.
 */
function harness(serveConfig: ServeConfig, calls: (call: PersonHandler) => Promise<unknown>): Harness {
  let at = START;
  const h: Harness = { sent: [], log: [], returns: [], book: [], onSleep: () => {}, step: 60_000 } as unknown as Harness;
  (h as { deps: ServeDeps }).deps = {
    config: serveConfig,
    open: async (options) => {
      const agent = new FixtureAgent();
      const client = new AcpClient({ transport: agent.transport, gate: options.gate });
      await client.initialize();
      const prompt = client.prompt.bind(client);
      client.prompt = async (params) => {
        await calls(handlerOf(h));
        return prompt(params);
      };
      return { client, logLines: [], agentInfo: 'FixtureAgent 0.1.0', close: () => client.close() };
    },
    commandFor: () => OPENCODE_COMMAND,
    promptFor: (task) => task.prompt ?? '',
    channel: { name: 'fake', send: (_user, message) => void h.sent.push(message) },
    questions: {
      read: () => h.book.map((question) => ({ ...question })),
      write: (next) => void (h.book = [...next]),
    },
    personHost: {
      attach: async (handler) => {
        handlers.set(h, handler);
        return {
          server: { type: 'http', name: 'lotse-person', url: 'http://127.0.0.1:1/person/x', headers: [] },
          detach: () => void handlers.delete(h),
        };
      },
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

const handlers = new Map<Harness, PersonHandler>();
const handlerOf = (h: Harness): PersonHandler => handlers.get(h)!;

/** Everything lotse wrote or sent, as one string: where a code must never appear. */
const everything = (h: Harness, ...more: string[]): string =>
  JSON.stringify([h.book, h.log, h.sent, ...more]);

export default async () => {
  await describe('person_needed', async () => {
    await it('"done" returns done and the question is answered', async () => {
      let outcome: PersonOutcome | null = null;
      const h = harness(config(), async (call) => void (outcome = await call({ ...INPUT, acceptsCode: false })));
      h.onSleep = async () => {
        if (h.book[0]?.status === 'open') await answerQuestion('#A1', 'fertig', h.deps);
      };
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(outcome!.outcome).toBe('done');
      expect(h.book[0]!.kind).toBe('person');
      expect(h.book[0]!.status).toBe('answered');
      expect(h.sent[0]!.asks).toBe('person');
      expect(h.sent[0]!.text).toContain('example.test');
    });

    await it('a code reply is handed to the call and kept out of every record', async () => {
      let outcome: PersonOutcome | null = null;
      let said = '';
      const h = harness(config(), async (call) => void (outcome = await call(INPUT)));
      h.onSleep = async () => {
        if (h.book[0]?.status === 'open') said = (await answerQuestion('#A1', CODE, h.deps)).message;
      };
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(outcome).toStrictEqual({ outcome: 'code', code: CODE });
      expect(h.book[0]!.answer).toBe('text');
      expect(h.book[0]!.resolution).toBe('code received');
      expect(everything(h, said).includes(CODE)).toBe(false);
      expect(h.sent[0]!.text).toContain('code');
    });

    await it('a code is not taken when the call did not accept one', async () => {
      let outcome: PersonOutcome | null = null;
      let refused = '';
      const h = harness(config(), async (call) => void (outcome = await call({ ...INPUT, acceptsCode: false })));
      h.onSleep = async () => {
        if (h.book[0]?.status !== 'open') return;
        const first = await answerQuestion('#A1', CODE, h.deps);
        refused = first.mode;
        await answerQuestion('#A1', 'done', h.deps);
      };
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(refused).toBe('invalid');
      expect(outcome!.outcome).toBe('done');
    });

    await it('no reply in time returns timeout and leaves a deferred open item', async () => {
      let outcome: PersonOutcome | null = null;
      const h = harness(config(), async (call) => void (outcome = await call(INPUT)));
      const run = await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(run.outcome).toBe('done');
      expect(outcome!.outcome).toBe('timeout');
      expect(h.book[0]!.status).toBe('open');
      expect(h.book[0]!.deferred).toBe(true);
      expect(h.book[0]!.acceptsCode).toBe(true);
    });

    await it('the task\'s own wait wins over the default, the call\'s over the task\'s', async () => {
      let polls = 0;
      const h = harness(
        config({}, { personNeeded: { enabled: true, timeoutMin: 3 } }),
        async (call) => void (await call(INPUT)),
      );
      h.step = 60_000;
      h.onSleep = () => void (polls += 1);
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(polls).toBe(3);
    });

    await it('a deferred item answered with "done" continues the session; a code is refused', async () => {
      const h = harness(config(), async (call) => void (await call(INPUT)));
      await runTask(h.deps.config.tasks[0]!, h.deps);
      const late = await answerQuestion('#A1', CODE, h.deps);
      expect(late.mode).toBe('invalid');
      expect(JSON.stringify([late, h.book, h.log]).includes(CODE)).toBe(false);
      expect(h.book[0]!.status).toBe('open');
      const done = await answerQuestion('#A1', 'done', h.deps);
      expect(done.question!.status).toBe('answered');
      expect(done.run).not.toBe(null);
    });

    await it('"no" returns declined', async () => {
      let outcome: PersonOutcome | null = null;
      const h = harness(config(), async (call) => void (outcome = await call(INPUT)));
      h.onSleep = async () => {
        if (h.book[0]?.status === 'open') await answerQuestion('#A1', 'no', h.deps);
      };
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(outcome!.outcome).toBe('declined');
    });

    await it('a second call while one waits is rejected', async () => {
      let second = '';
      const h = harness(config(), async (call) => {
        const first = call({ ...INPUT, acceptsCode: false });
        await call(INPUT).catch((error: Error) => void (second = error.message));
        await first;
      });
      h.onSleep = async () => {
        if (h.book[0]?.status === 'open') await answerQuestion('#A1', 'done', h.deps);
      };
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(second).toContain('already waiting');
      expect(h.book.length).toBe(1);
    });

    await it('a task without person_needed is refused', async () => {
      const refusal = personRefusal(
        config({}, { personNeeded: { enabled: false } }).tasks[0]!,
        config().profiles[0]!,
        INPUT,
      );
      expect(refusal).toContain('not have person_needed enabled');
    });

    await it('a code is refused on a free model and on an unknown one', async () => {
      const task = config().tasks[0]!;
      const free = personRefusal(task, config({ model: 'opencode/some-model-free' }).profiles[0]!, INPUT);
      expect(free).toContain('free model');
      const unknown = config();
      const none = personRefusal(task, { ...unknown.profiles[0]!, model: null }, INPUT);
      expect(none).toContain('names its model');
      expect(personRefusal(task, config().profiles[0]!, INPUT)).toBe(null);
      // "done" carries no credential, so a free model may ask for it.
      expect(personRefusal(task, config({ model: 'opencode/some-model-free' }).profiles[0]!, { ...INPUT, acceptsCode: false })).toBe(null);
    });

    await it('the handler throws the refusal on a profile without a model', async () => {
      let message = '';
      const h = harness(config({ model: null }), async (call) => {
        await call(INPUT).catch((error: Error) => void (message = error.message));
      });
      await runTask(h.deps.config.tasks[0]!, h.deps);
      expect(message).toContain('names its model');
      expect(h.book.length).toBe(0);
    });

    await it('reads replies without a model', async () => {
      expect(parsePersonReply('Done.', false)).toStrictEqual({ kind: 'done' });
      expect(parsePersonReply('fertig', true)).toStrictEqual({ kind: 'done' });
      expect(parsePersonReply('nein', true)).toStrictEqual({ kind: 'declined' });
      expect(parsePersonReply(' 482913 ', true)).toStrictEqual({ kind: 'code', code: '482913' });
      expect(parsePersonReply('482913', false)).toStrictEqual({ kind: 'invalid' });
      expect(parsePersonReply('123', true)).toStrictEqual({ kind: 'invalid' });
      expect(parsePersonReply('12345678901', true)).toStrictEqual({ kind: 'invalid' });
      expect(parsePersonReply('my code is 1234', true)).toStrictEqual({ kind: 'invalid' });
      expect(REDACTED).toBe('••••');
    });
  });
};
