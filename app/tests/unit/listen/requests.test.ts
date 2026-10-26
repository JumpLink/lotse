import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  PART_CHARS,
  REQUEST_DEFAULTS,
  abortableSleep,
  chatRequests,
  connectMcp,
  matchPrefix,
  recoverPending,
  runReceiveLoop,
  sendToPeer,
  splitForChat,
  type ChatRequests,
  type Cursor,
  type CursorStore,
  type MessengerSettings,
  type PendingRequest,
  type Question,
  type RequestRun,
  type RequestRunResult,
  type RequestSettings,
  type RunResult,
  type RunDeps,
  type RunLogEntry,
} from '@lotse/core';
import {
  formatEnvSpecs,
  formatServerSpecs,
  parseEnvSpecs,
  parseServerSpecs,
  parseSettings,
  withRequests,
} from '../../../src/core/settings.ts';
import { applyRequestFlags } from '../../../src/frontends/cli/messenger.ts';
import { createRequestsHolder } from '../../../src/frontends/cli/chat-requests.ts';
import { fixture } from '../../support/config.ts';
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

const CONFIG = fixture();

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

function runDeps(
  book: { value: Question[] },
  clock: Clock = { ms: NOW },
  entries: RunLogEntry[] = [],
): RunDeps {
  return {
    ...CONFIG,
    questions: {
      read: () => book.value.map((q) => ({ ...q })),
      write: (next: Question[]) => void (book.value = [...next]),
    },
    now: () => new Date(clock.ms),
    sleep: async () => {},
    log: (entry: RunLogEntry) => void entries.push(entry),
  } as unknown as RunDeps;
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
  const deps = runDeps(book);
  const requests = chatRequests({
    settings: ON,
    deps: deps,
    defaultCwd: '/home/example',
    send: (text) => sendToPeer(link, SETTINGS, text),
    run: runner.run,
  });
  const loop = runReceiveLoop({
    link,
    settings: SETTINGS,
    deps: deps,
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
      const entries: RunLogEntry[] = [];
      const requests = chatRequests({
        settings: { ...ON, preamble: 'Be brief.' },
        deps: runDeps({ value: [] }, { ms: NOW }, entries),
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
      const entries: RunLogEntry[] = [];
      const requests = chatRequests({
        settings: ON,
        deps: runDeps({ value: [] }, { ms: NOW }, entries),
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
        deps: runDeps({ value: [] }),
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
        deps: runDeps({ value: [] }, clock),
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
        deps: runDeps({ value: [] }),
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
      const entries: RunLogEntry[] = [];
      const requests = chatRequests({
        settings: ON,
        deps: runDeps({ value: [] }, { ms: NOW }, entries),
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
        'The request failed. The listen log has the details.',
        'The request failed. The listen log has the details.',
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
  await describe('request MCP server environment', async () => {
    const SERVER = {
      name: 'cal',
      command: 'reminder',
      args: ['mcp'],
      env: [{ name: 'REMINDER_HOME', value: '/data x' }],
    };
    await it('reaches the run as ACP env variables', async () => {
      const runner = fakeRunner();
      const requests = chatRequests({
        settings: { ...ON, mcpServers: [SERVER] },
        deps: runDeps({ value: [] }),
        defaultCwd: '/home/example',
        send: async () => {},
        run: runner.run,
      });
      requests.submit('hi', true);
      await until(() => runner.calls.length === 1, 'the run');
      expect(runner.calls[0]!.request.mcpServers).toStrictEqual([SERVER]);
      runner.calls[0]!.release(result());
      await requests.idle();
    });
    await it('round-trips through settings.json; a credential-looking name is refused', async () => {
      const saved = withRequests({ version: 1, agent: null }, { ...ON, mcpServers: [SERVER] });
      expect(parseSettings(JSON.stringify(saved))).toStrictEqual({ settings: saved });
      const bad = parseSettings(
        '{"version":1,"channel":{"messenger":{"requests":{"mcpServers":[{"name":"a","command":"b","env":[{"name":"API_TOKEN","value":"x"}]}]}}}}',
      );
      expect('problem' in bad).toBe(true);
    });
    await it('the CLI setter replaces the env and keeps it when servers are re-set', async () => {
      const withServer = { ...ON, mcpServers: [{ name: 'cal', command: 'reminder', args: ['mcp'] }] };
      const set = applyRequestFlags(withServer, { mcpEnv: 'cal:REMINDER_HOME=/data x' });
      expect(set).toStrictEqual({
        ...withServer,
        mcpServers: [{ ...withServer.mcpServers[0], env: [{ name: 'REMINDER_HOME', value: '/data x' }] }],
      });
      const again = applyRequestFlags(set as RequestSettings, { mcpServers: 'cal=reminder mcp --x' });
      expect(formatEnvSpecs((again as RequestSettings).mcpServers)).toBe('cal:REMINDER_HOME=/data x');
      const cleared = applyRequestFlags(set as RequestSettings, { mcpEnv: 'none' });
      expect(formatEnvSpecs((cleared as RequestSettings).mcpServers)).toBe('');
      expect('problem' in applyRequestFlags(withServer, { mcpEnv: 'other:A=1' })).toBe(true);
      expect('problem' in applyRequestFlags(withServer, { mcpEnv: 'cal:API_KEY=1' })).toBe(true);
      expect('problem' in (parseEnvSpecs('nonsense') as object)).toBe(true);
    });
  });

  await describe('requests left unfinished by a restart', async () => {
    const memory = (start: PendingRequest[] = []) => {
      const store = {
        value: start,
        read: () => store.value,
        write: (list: readonly PendingRequest[]) => void (store.value = [...list]),
      };
      return store;
    };
    await it('a request is noted by id and time only, and forgotten when it ends', async () => {
      const runner = fakeRunner();
      const pending = memory();
      const requests = chatRequests({
        settings: ON,
        deps: runDeps({ value: [] }),
        defaultCwd: '/home/example',
        send: async () => {},
        pending,
        run: runner.run,
      });
      requests.submit('write the secret plan', true);
      await until(() => runner.calls.length === 1, 'the run');
      expect(pending.value.length).toBe(1);
      expect(JSON.stringify(pending.value)).not.toContain('plan');
      runner.calls[0]!.release(result());
      await requests.idle();
      expect(pending.value.length).toBe(0);
    });
    await it('one message for one or several, then the list is empty; nothing is run', async () => {
      const sent: string[] = [];
      const one = memory([{ id: 'a', at: BEFORE }]);
      expect(await recoverPending(one, async (text) => void sent.push(text))).toBe(1);
      expect(sent[0]).toContain('not completed');
      expect(sent[0]).toContain('send it again');
      expect(one.value.length).toBe(0);
      const many = memory([
        { id: 'a', at: BEFORE },
        { id: 'b', at: BEFORE },
      ]);
      expect(await recoverPending(many, async (text) => void sent.push(text))).toBe(2);
      expect(sent[1]).toContain('2');
      expect(many.value.length).toBe(0);
      expect(await recoverPending(many, async (text) => void sent.push(text))).toBe(0);
      expect(sent.length).toBe(2);
    });
    await it('a message that cannot be sent still clears the list', async () => {
      const store = memory([{ id: 'a', at: BEFORE }]);
      const lines: string[] = [];
      await recoverPending(
        store,
        async () => {
          throw new Error('down');
        },
        (line) => void lines.push(line),
      );
      expect(store.value.length).toBe(0);
      expect(lines.length).toBe(1);
    });
  });

  await describe('reloading the request settings', async () => {
    const holderFor = (
      state: { settings: RequestSettings | null; profiles: string[] },
      built: RequestSettings[],
    ) =>
      createRequestsHolder({
        read: () => state.settings,
        profiles: () => state.profiles,
        build: (settings) => {
          built.push(settings);
          return { prefix: settings.prefix, submit: () => {}, idle: async () => {} };
        },
      });
    await it('builds on first sight, rebuilds on a change, drops on off, ignores the same', async () => {
      const built: RequestSettings[] = [];
      const state = { settings: ON as RequestSettings | null, profiles: ['p'] };
      const holder = holderFor(state, built);
      expect(holder.check().kind).toBe('changed');
      const first = holder.current();
      expect(first?.prefix).toBe('/ask');
      expect(holder.check().kind).toBe('unchanged');
      state.settings = { ...ON, prefix: '/do' };
      expect(holder.check().kind).toBe('changed');
      expect(holder.current()?.prefix).toBe('/do');
      expect(holder.current()).not.toBe(first);
      state.settings = null;
      expect(holder.check().kind).toBe('unchanged');
      expect(holder.current()?.prefix).toBe('/do');
      state.settings = { ...ON, enabled: false };
      expect(holder.check().kind).toBe('changed');
      expect(holder.current()).toBe(undefined);
      expect(built.length).toBe(2);
    });
    await it('a profile profiles.json lacks is a problem, and a later profiles.json can fix it', async () => {
      const state = { settings: ON as RequestSettings | null, profiles: ['other'] };
      const holder = holderFor(state, []);
      expect(holder.check().kind).toBe('problem');
      expect(holder.current()).toBe(undefined);
      state.profiles = ['p'];
      expect(holder.check().kind).toBe('changed');
      expect(holder.current()).not.toBe(undefined);
    });
    await it('a request running in the old instance finishes there; new messages use the new one', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        const link = new McpLink(() => connectMcp(fake.command));
        const abort = new AbortController();
        const deps = runDeps({ value: [] });
        let current = chatRequests({
          settings: ON,
          deps: deps,
          defaultCwd: '/h',
          send: (t) => sendToPeer(link, SETTINGS, t),
          run: runner.run,
        });
        const loop = runReceiveLoop({
          link,
          settings: SETTINGS,
          deps: deps,
          cursor: memoryCursor(BEFORE),
          signal: abort.signal,
          timeoutS: 1,
          minCycleMs: 0,
          sleep: (_ms, signal) => abortableSleep(10, signal),
          requests: () => current,
        });
        try {
          fake.deliver('2026-10-10T11:30:00.000Z', '/ask one');
          await until(() => runner.calls.length === 1, 'the first run');
          current = chatRequests({
            settings: { ...ON, prefix: '/do' },
            deps: deps,
            defaultCwd: '/h',
            send: (t) => sendToPeer(link, SETTINGS, t),
            run: runner.run,
          });
          fake.deliver('2026-10-10T11:31:00.000Z', '/do two');
          await until(() => runner.calls.length === 2, 'the second run');
          expect(runner.calls[1]!.request.text).toBe('two');
        } finally {
          for (const call of runner.calls) call.release(result());
          await current.idle();
          abort.abort();
          await loop;
          await link.close();
        }
      });
    });
  });

  await describe('the receive loop with once', async () => {
    await it('handles what is there and returns without a loop', async () => {
      await withFakeMcp({}, async (fake) => {
        const runner = fakeRunner();
        const link = new McpLink(() => connectMcp(fake.command));
        const deps = runDeps({ value: [] });
        const requests = chatRequests({
          settings: ON,
          deps: deps,
          defaultCwd: '/h',
          send: (t) => sendToPeer(link, SETTINGS, t),
          run: runner.run,
        });
        fake.deliver('2026-10-10T11:30:00.000Z', '/ask now');
        await runReceiveLoop({
          link,
          settings: SETTINGS,
          deps: deps,
          cursor: memoryCursor(BEFORE),
          signal: new AbortController().signal,
          timeoutS: 1,
          requests,
          once: true,
        });
        expect(runner.calls.length).toBe(1);
        runner.calls[0]!.release(result());
        await requests.idle();
        await link.close();
        expect(texts(fake)).toStrictEqual(['Three events today.']);
      });
    });
    await it('returns after one poll when nothing arrives', async () => {
      await withFakeMcp({}, async (fake) => {
        const link = new McpLink(() => connectMcp(fake.command));
        await runReceiveLoop({
          link,
          settings: SETTINGS,
          deps: runDeps({ value: [] }),
          cursor: memoryCursor(BEFORE),
          signal: new AbortController().signal,
          timeoutS: 1,
          once: true,
        });
        await link.close();
        expect(fake.calls().filter((call) => call.tool === 'xmpp_wait_reply').length).toBe(1);
      });
    });
  });
};
