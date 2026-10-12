import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  PART_CHARS,
  REQUEST_DEFAULTS,
  abortableSleep,
  chatRequests,
  connectMcp,
  matchPrefix,
  parseServeConfig,
  runReceiveLoop,
  sendToPeer,
  splitForChat,
  type ChatRequests,
  type Cursor,
  type CursorStore,
  type MessengerSettings,
  type Question,
  type RequestRun,
  type RequestRunResult,
  type RequestSettings,
  type RunResult,
  type ServeDeps,
  type ServeLogEntry,
} from '@lotse/core';
import {
  formatServerSpecs,
  parseServerSpecs,
  parseSettings,
  withRequests,
} from '../../../src/core/settings.ts';
import { applyRequestFlags } from '../../../src/frontends/cli/messenger.ts';
import { withFakeMcp, type FakeMcp } from '../../support/fake-mcp.ts';

const SETTINGS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: 'main',
  peer: 'person@example.org',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

const ON: RequestSettings = { ...REQUEST_DEFAULTS, enabled: true, profile: 'p' };

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const BEFORE = '2026-10-10T11:00:00.000Z';

const CONFIG = parseServeConfig(
  JSON.stringify({
    version: 1,
    users: [{ id: 'me' }],
    profiles: [{ id: 'p', user: 'me', data: 'public' }],
    tasks: [{ id: 't', profile: 'p', schedule: { every: '1h' }, prompt: 'x', cwd: '/fixture' }],
  }),
);

function question(id: string): Question {
  return {
    id,
    user: 'me',
    task: 't',
    kind: 'permission',
    sessionId: 'ses',
    action: null,
    text: 'Allow it?',
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
  };
}

interface Clock {
  ms: number;
}

function serveDeps(
  book: { value: Question[] },
  clock: Clock = { ms: NOW },
  entries: ServeLogEntry[] = [],
): ServeDeps {
  return {
    config: CONFIG,
    questions: {
      read: () => book.value.map((q) => ({ ...q })),
      write: (next: Question[]) => void (book.value = [...next]),
    },
    now: () => new Date(clock.ms),
    sleep: async () => {},
    log: (entry: ServeLogEntry) => void entries.push(entry),
  } as unknown as ServeDeps;
}

function result(patch: Partial<RunResult> = {}, how: RequestRunResult['how'] = 'new'): RequestRunResult {
  return {
    how,
    run: {
      task: '@chat',
      outcome: 'done',
      sessionId: 'ses-1',
      stopReason: 'end_turn',
      questionId: null,
      reply: 'Three events today.',
      reason: null,
      precheck: null,
      startedAt: new Date(NOW).toISOString(),
      endedAt: new Date(NOW).toISOString(),
      ...patch,
    },
  };
}

/** A fake run per request: each waits until the test releases it with a result. */
function fakeRunner() {
  const calls: { request: RequestRun; release: (value: RequestRunResult | Error) => void }[] = [];
  const run = (request: RequestRun) =>
    new Promise<RequestRunResult>((resolve, reject) => {
      calls.push({
        request,
        release: (value) => (value instanceof Error ? reject(value) : resolve(value)),
      });
    });
  return { calls, run };
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function memoryCursor(at: string): CursorStore & { value: Cursor | null } {
  const store = {
    value: { at, seen: [] } as Cursor | null,
    read: () => store.value,
    write: (cursor: Cursor) => void (store.value = cursor),
  };
  return store;
}

/** The receive loop against `fake`, with requests run by `runner`, until `body` is done. */
async function looping(
  fake: FakeMcp,
  book: { value: Question[] },
  runner: ReturnType<typeof fakeRunner>,
  body: (requests: ChatRequests) => Promise<void>,
  cursor: CursorStore = memoryCursor(BEFORE),
): Promise<void> {
  const link = new McpLink(() => connectMcp(fake.command));
  const abort = new AbortController();
  const deps = serveDeps(book);
  const requests = chatRequests({
    settings: ON,
    serve: deps,
    defaultCwd: '/home/example',
    send: (text) => sendToPeer(link, SETTINGS, text),
    run: runner.run,
  });
  const loop = runReceiveLoop({
    link,
    settings: SETTINGS,
    serve: deps,
    cursor,
    signal: abort.signal,
    timeoutS: 1,
    minCycleMs: 0,
    backoff: { initialMs: 10, maxMs: 40 },
    sleep: (_ms, signal) => abortableSleep(10, signal),
    requests,
  });
  try {
    await body(requests);
  } finally {
    for (const call of runner.calls) call.release(result());
    await requests.idle();
    abort.abort();
    await loop;
    await link.close();
  }
}

const texts = (fake: FakeMcp) =>
  fake
    .calls()
    .filter((call) => call.tool === 'send_message')
    .map((call) => String(call.args['text']));

export default async () => {
  await describe('matchPrefix', async () => {
    await it('the prefix, any case, then a space or the end', async () => {
      expect(matchPrefix('/ask what is on today', '/ask')).toBe('what is on today');
      expect(matchPrefix('  /ASK  hello ', '/ask')).toBe('hello');
      expect(matchPrefix('/ask', '/ask')).toBe('');
      expect(matchPrefix('/asking around', '/ask')).toBe(null);
      expect(matchPrefix('please /ask', '/ask')).toBe(null);
    });
    await it('a prefix ending in a sign needs no space', async () => {
      expect(matchPrefix('?what now', '?')).toBe('what now');
    });
  });

  await describe('splitForChat', async () => {
    await it('a short answer is one message', async () => {
      expect(splitForChat('  short  ')).toStrictEqual(['short']);
    });
    await it('a long one is cut at words and numbered', async () => {
      const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
      const parts = splitForChat(text);
      expect(parts.length).toBe(3);
      expect(parts[0]!.startsWith('(1/3) word0 ')).toBe(true);
      expect(parts.every((part) => part.length <= PART_CHARS)).toBe(true);
      // No word is split in two.
      expect(
        parts
          .join(' ')
          .replace(/\(\d\/3\) /g, '')
          .split(/\s+/).length,
      ).toBe(400);
    });
    await it('more than fits is cut short and says how much is missing', async () => {
      const parts = splitForChat('x '.repeat(5000));
      expect(parts.length).toBe(3);
      expect(parts[2]).toContain('shortened');
      expect(parts.every((part) => part.length <= PART_CHARS)).toBe(true);
    });
  });

  await describe('chat requests', async () => {
    await it('a request runs with the profile, the cwd and the rights, and the answer goes back', async () => {
      const runner = fakeRunner();
      const out: string[] = [];
      const entries: ServeLogEntry[] = [];
      const requests = chatRequests({
        settings: { ...ON, preamble: 'Be brief.' },
        serve: serveDeps({ value: [] }, { ms: NOW }, entries),
        defaultCwd: '/home/example',
        send: async (text) => void out.push(text),
        run: runner.run,
      });
      requests.submit('what is on my calendar', true);
      await until(() => runner.calls.length === 1, 'the run');
      expect(runner.calls[0]!.request).toStrictEqual({
        profile: 'p',
        cwd: '/home/example',
        mcpServers: [],
        rights: 'read',
        preamble: 'Be brief.',
        text: 'what is on my calendar',
        sessionId: null,
      });
      runner.calls[0]!.release(result());
      await requests.idle();
      expect(out).toStrictEqual(['Three events today.']);
      const logged = JSON.stringify(entries);
      expect(entries.map((entry) => entry.detail?.['phase'])).toStrictEqual(['start', 'end']);
      expect(logged).not.toContain('calendar');
      expect(logged).not.toContain('Three events');
    });

    await it('busy: the next one is queued, hears its place, and runs after', async () => {
      const runner = fakeRunner();
      const out: string[] = [];
      const entries: ServeLogEntry[] = [];
      const requests = chatRequests({
        settings: ON,
        serve: serveDeps({ value: [] }, { ms: NOW }, entries),
        defaultCwd: '/home/example',
        send: async (text) => void out.push(text),
        run: runner.run,
      });
      requests.submit('first', true);
      requests.submit('second', true);
      await until(() => out.length === 1, 'the queue notice');
      expect(out[0]).toContain('queued (position 1)');
      expect(runner.calls.length).toBe(1);
      runner.calls[0]!.release(result({ reply: 'one' }));
      await until(() => runner.calls.length === 2, 'the second run');
      expect(runner.calls[1]!.request.text).toBe('second');
      runner.calls[1]!.release(result({ reply: 'two' }));
      await requests.idle();
      expect(out.slice(1)).toStrictEqual(['one', 'two']);
      expect(entries.some((entry) => entry.detail?.['phase'] === 'queued')).toBe(true);
    });

    await it('two at a time with maxConcurrent 2', async () => {
      const runner = fakeRunner();
      const requests = chatRequests({
        settings: { ...ON, maxConcurrent: 2 },
        serve: serveDeps({ value: [] }),
        defaultCwd: '/home/example',
        send: async () => {},
        run: runner.run,
      });
      requests.submit('a', true);
      requests.submit('b', true);
      await until(() => runner.calls.length === 2, 'both runs');
      for (const call of runner.calls) call.release(result());
      await requests.idle();
    });

    await it('a plain message inside the window continues the session; after it, a new one with a note', async () => {
      const runner = fakeRunner();
      const out: string[] = [];
      const clock = { ms: NOW };
      const requests = chatRequests({
        settings: ON,
        serve: serveDeps({ value: [] }, clock),
        defaultCwd: '/home/example',
        send: async (text) => void out.push(text),
        run: runner.run,
      });
      requests.submit('first', true);
      await until(() => runner.calls.length === 1, 'the first run');
      runner.calls[0]!.release(result({ sessionId: 'ses-1' }));
      await requests.idle();

      clock.ms += 29 * 60_000;
      requests.submit('and tomorrow?', false);
      await until(() => runner.calls.length === 2, 'the follow-up');
      expect(runner.calls[1]!.request.sessionId).toBe('ses-1');
      runner.calls[1]!.release(result({ sessionId: 'ses-1' }, 'loaded'));
      await requests.idle();

      // The prefix always starts afresh, even inside the window.
      requests.submit('something else', true);
      await until(() => runner.calls.length === 3, 'the prefixed one');
      expect(runner.calls[2]!.request.sessionId).toBe(null);
      runner.calls[2]!.release(result({ sessionId: 'ses-2' }));
      await requests.idle();

      clock.ms += 31 * 60_000;
      requests.submit('and next week?', false);
      await until(() => runner.calls.length === 4, 'the late one');
      expect(runner.calls[3]!.request.sessionId).toBe(null);
      runner.calls[3]!.release(result({ sessionId: 'ses-3', reply: 'Nothing.' }));
      await requests.idle();
      expect(out[3]).toContain('More than 30 min');
      expect(out[3]).toContain('Nothing.');
    });

    await it('a session that cannot be continued says so', async () => {
      const runner = fakeRunner();
      const out: string[] = [];
      const requests = chatRequests({
        settings: ON,
        serve: serveDeps({ value: [] }),
        defaultCwd: '/home/example',
        send: async (text) => void out.push(text),
        run: runner.run,
      });
      requests.submit('first', true);
      await until(() => runner.calls.length === 1, 'the run');
      runner.calls[0]!.release(result());
      await requests.idle();
      requests.submit('more', false);
      await until(() => runner.calls.length === 2, 'the follow-up');
      runner.calls[1]!.release(result({ sessionId: 'ses-9', reply: 'ok' }, 'fresh'));
      await requests.idle();
      expect(out[1]).toContain('could not be continued');
    });

    await it('a failed or thrown run is said in the chat; the reason goes to the log only', async () => {
      const runner = fakeRunner();
      const out: string[] = [];
      const entries: ServeLogEntry[] = [];
      const requests = chatRequests({
        settings: ON,
        serve: serveDeps({ value: [] }, { ms: NOW }, entries),
        defaultCwd: '/home/example',
        send: async (text) => void out.push(text),
        run: runner.run,
        log: () => {},
      });
      requests.submit('one', true);
      await until(() => runner.calls.length === 1, 'the first run');
      runner.calls[0]!.release(result({ outcome: 'failed', reply: null, reason: 'token sk-synthetic' }));
      await requests.idle();
      requests.submit('two', false);
      await until(() => runner.calls.length === 2, 'the second run');
      expect(runner.calls[1]!.request.sessionId).toBe(null);
      runner.calls[1]!.release(new Error('agent crashed'));
      await requests.idle();
      expect(out).toStrictEqual([
        'The request failed. The serve log has the details.',
        'The request failed. The serve log has the details.',
      ]);
      expect(entries.some((entry) => entry.event === 'error')).toBe(true);
    });
  });

  await describe('requests in the receive loop', async () => {
    await it('a message with nothing open starts a run, and the answer comes back', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        await looping(fake, { value: [] }, runner, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'what is on today?');
          await until(() => runner.calls.length === 1, 'the run');
          expect(runner.calls[0]!.request.text).toBe('what is on today?');
          runner.calls[0]!.release(result());
          await until(() => texts(fake).length === 1, 'the answer');
        });
        expect(texts(fake)).toStrictEqual(['Three events today.']);
      });
    });

    await it('with one question open, plain text still answers it; the prefix makes a request', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        const book = { value: [question('A1')] };
        await looping(fake, book, runner, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', '/ask what is A1 about?');
          await until(() => runner.calls.length === 1, 'the request');
          fake.deliver('2026-10-10T11:31:00.000Z', 'ja');
          await until(() => texts(fake).includes('Got it, #A1.'), 'the answer');
        });
        expect(runner.calls.length).toBe(1);
        expect(runner.calls[0]!.request.text).toBe('what is A1 about?');
        expect(book.value[0]!.answer).toBe('yes');
      });
    });

    await it('a bare yes with nothing open, and a bare prefix, start nothing', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        await looping(fake, { value: [] }, runner, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'yes');
          fake.deliver('2026-10-10T11:31:00.000Z', '/ask');
          await until(() => texts(fake).length === 2, 'two replies');
        });
        expect(runner.calls.length).toBe(0);
        expect(texts(fake)[0]).toContain('No question is waiting');
        expect(texts(fake)[1]).toContain('What should I do?');
      });
    });

    await it('a running request does not block the next message', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        const book = { value: [] as Question[] };
        await looping(fake, book, runner, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'a long job');
          await until(() => runner.calls.length === 1, 'the run');
          book.value = [question('A1')];
          fake.deliver('2026-10-10T11:31:00.000Z', 'A1 ja');
          await until(() => texts(fake).includes('Got it, #A1.'), 'the answer while the run goes on');
          expect(texts(fake).length).toBe(1);
        });
      });
    });

    await it('two messages of the same millisecond, listed apart, are both handled', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        const at = '2026-10-10T11:30:00.000Z';
        const cursor = memoryCursor(BEFORE);
        await looping(
          fake,
          { value: [] },
          runner,
          async () => {
            fake.deliver(at, 'first', 'x1');
            await until(() => runner.calls.length === 1, 'the first');
            runner.calls[0]!.release(result({ reply: 'one' }));
            await until(() => texts(fake).length === 1, 'the first answer');
            fake.deliver(at, '/ask second', 'x2');
            await until(() => runner.calls.length === 2, 'the second, same millisecond');
            runner.calls[1]!.release(result({ reply: 'two' }));
            await until(() => texts(fake).length === 2, 'the second answer');
            // Several more polls: neither is read again.
            const polls = fake.calls().length;
            await until(() => fake.calls().length > polls + 3, 'more polls');
          },
          cursor,
        );
        expect(runner.calls.length).toBe(2);
        expect(cursor.value).toStrictEqual({ at, seen: ['x1', 'x2'] });
      });
    });
  });

  await describe('request settings', async () => {
    await it('round-trip through the file, with defaults for what is left out', async () => {
      const parsed = parseSettings(
        '{"version":1,"channel":{"messenger":{"peer":"person@example.org","requests":{"enabled":true,"profile":"p"}}}}',
      );
      expect('settings' in parsed && parsed.settings.channel?.messenger?.requests).toStrictEqual(ON);
      const saved = withRequests(
        { version: 1, agent: null },
        { ...ON, mcpServers: [{ name: 'cal', command: 'reminder', args: ['mcp'] }], rights: 'confirm' },
      );
      expect(parseSettings(JSON.stringify(saved))).toStrictEqual({ settings: saved });
    });
    await it('refuses a bad value and a secret-looking field', async () => {
      const problem = (requests: string) => {
        const parsed = parseSettings(`{"version":1,"channel":{"messenger":{"requests":${requests}}}}`);
        return 'problem' in parsed ? parsed.problem : '';
      };
      expect(problem('{"rights":"all"}')).toContain('rights');
      expect(problem('{"maxConcurrent":0}')).toContain('maxConcurrent');
      expect(problem('{"followUpMinutes":-1}')).toContain('followUpMinutes');
      expect(problem('{"apiKey":"x"}')).toContain('secret-looking');
      expect(problem('{"mcpServers":[{"name":"a","command":"b","env":{}}]}')).toContain('env');
    });
    await it('server specs read and write the same', async () => {
      const servers = parseServerSpecs('cal=reminder mcp; mail=curlew mcp --read-only');
      expect(servers).toStrictEqual([
        { name: 'cal', command: 'reminder', args: ['mcp'] },
        { name: 'mail', command: 'curlew', args: ['mcp', '--read-only'] },
      ]);
      expect(formatServerSpecs(servers as never)).toBe('cal=reminder mcp; mail=curlew mcp --read-only');
      expect(parseServerSpecs('none')).toStrictEqual([]);
      expect('problem' in (parseServerSpecs('just-a-word') as object)).toBe(true);
    });
    await it('CLI flags change what they name and keep the rest', async () => {
      expect(
        applyRequestFlags(ON, { requests: 'off', followUpMinutes: 10, mcpServers: 'cal=reminder mcp' }),
      ).toStrictEqual({
        ...ON,
        enabled: false,
        followUpMinutes: 10,
        mcpServers: [{ name: 'cal', command: 'reminder', args: ['mcp'] }],
      });
      expect(applyRequestFlags(ON, { rights: 'write' })).toStrictEqual({
        problem: '--request-rights takes read or confirm',
      });
      expect('problem' in applyRequestFlags(ON, { maxConcurrent: 0 })).toBe(true);
      expect('problem' in applyRequestFlags(ON, { prefix: ' ' })).toBe(true);
    });
  });
};
