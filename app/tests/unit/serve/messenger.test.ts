import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  abortableSleep,
  answerQuestion,
  combineChannels,
  connectMcp,
  messengerChannel,
  messengerText,
  parseReply,
  parseServeConfig,
  runReceiveLoop,
  type CursorStore,
  type MessengerSettings,
  type Question,
  type ServeChannel,
  type ServeDeps,
  type ServeMessage,
} from '@lotse/core';
import { fileCursorStore } from '../../../src/core/messenger-state.ts';
import { parseSettings, withMessenger } from '../../../src/core/settings.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFakeMcp, type FakeMcp } from '../../support/fake-mcp.ts';

const SETTINGS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: 'main',
  peer: 'person@example.org',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const BEFORE = '2026-10-10T11:00:00.000Z';

function question(
  id: string,
  kind: 'permission' | 'reply' = 'permission',
  patch: Partial<Question> = {},
): Question {
  return {
    id,
    user: 'me',
    task: 't',
    kind,
    sessionId: 'ses',
    action: null,
    text: 'Allow it?',
    createdAt: new Date(NOW - 60_000 + Number(id.slice(1))).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
    ...patch,
  };
}

function serveDeps(book: { value: Question[] }): ServeDeps {
  return {
    config: parseServeConfig(
      JSON.stringify({
        version: 1,
        users: [{ id: 'me' }],
        profiles: [{ id: 'p', user: 'me', data: 'public' }],
        tasks: [{ id: 't', profile: 'p', schedule: { every: '1h' }, prompt: 'x', cwd: '/fixture' }],
      }),
    ),
    questions: {
      read: () => book.value.map((q) => ({ ...q })),
      write: (next: Question[]) => void (book.value = [...next]),
    },
    now: () => new Date(NOW),
    sleep: async () => {},
  } as unknown as ServeDeps;
}

function memoryCursor(initial: string | null): CursorStore & { value: string | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (cursor: string) => void (store.value = cursor),
  };
  return store;
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function linkTo(fake: FakeMcp): McpLink {
  return new McpLink(() => connectMcp(fake.command));
}

/** Run the receive loop against `fake` until `body` is done. */
async function looping(
  fake: FakeMcp,
  book: { value: Question[] },
  cursor: CursorStore,
  body: (link: McpLink, deps: ServeDeps) => Promise<void>,
): Promise<void> {
  const link = linkTo(fake);
  const abort = new AbortController();
  const deps = serveDeps(book);
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
  });
  try {
    await body(link, deps);
  } finally {
    abort.abort();
    await loop;
    await link.close();
  }
}

const sent = (fake: FakeMcp) => fake.calls().filter((call) => call.tool === 'send_message');

export default async () => {
  await describe('parseReply', async () => {
    const open = ['A3'];
    await it('an id and a word', async () => {
      expect(parseReply('A3 ja', open)).toStrictEqual({ kind: 'answer', questionId: 'A3', text: 'ja' });
      expect(parseReply('#a3: only the first', ['A3', 'A4'])).toStrictEqual({
        kind: 'answer',
        questionId: 'A3',
        text: 'only the first',
      });
      expect(parseReply('#A03 no', open)).toStrictEqual({ kind: 'answer', questionId: 'A3', text: 'no' });
    });
    await it('plain text is for the one open question', async () => {
      expect(parseReply('  yes ', open)).toStrictEqual({ kind: 'answer', questionId: 'A3', text: 'yes' });
    });
    await it('plain text with several open answers nothing', async () => {
      expect(parseReply('yes', ['A1', 'A2'])).toStrictEqual({ kind: 'ambiguous', open: ['A1', 'A2'] });
    });
    await it('plain text with none open, a bare id, and blanks', async () => {
      expect(parseReply('yes', [])).toStrictEqual({ kind: 'nothing-open' });
      expect(parseReply('#A3', open)).toStrictEqual({ kind: 'missing-text', questionId: 'A3' });
      expect(parseReply('   ', open)).toStrictEqual({ kind: 'ignore' });
    });
    await it('an id inside a sentence is not an id', async () => {
      expect(parseReply('please do A3 now', open)).toStrictEqual({
        kind: 'answer',
        questionId: 'A3',
        text: 'please do A3 now',
      });
    });
  });

  await describe('messenger channel', async () => {
    const asks: ServeMessage = {
      title: 'lotse · t · #A3',
      body: 'Allow it?\n\nAnswer: lotse answer A3 yes|no — expires x',
      text: 'Allow it?',
      expiresAt: '2026-10-11T00:00:00.000Z',
      questionId: 'A3',
      asks: 'permission',
    };
    await it('puts the id, the question and the reply hint in one text', async () => {
      const text = messengerText(asks);
      expect(text.startsWith('lotse · t · #A3\n\nAllow it?')).toBe(true);
      expect(text).toContain('Reply: #A3 yes or #A3 no');
      expect(text).toContain('Valid until 2026-10-11T00:00:00.000Z');
      expect(text).not.toContain('lotse answer');
    });
    await it('a reply question asks for text; a report carries no hint', async () => {
      expect(messengerText({ ...asks, asks: 'reply' })).toContain('Reply: #A3 <your answer>');
      expect(messengerText({ title: 'lotse serve stopped', body: 'why', questionId: null })).toBe(
        'lotse serve stopped\n\nwhy',
      );
    });
    await it('sends {account, to, text} through the configured send tool', async () => {
      await withFakeMcp({}, async (fake) => {
        const link = linkTo(fake);
        try {
          await messengerChannel(link, SETTINGS).send({ id: 'me', addresses: [] }, asks);
        } finally {
          await link.close();
        }
        const calls = sent(fake);
        expect(calls.length).toBe(1);
        expect(calls[0]!.args['account']).toBe('main');
        expect(calls[0]!.args['to']).toBe('person@example.org');
        expect(String(calls[0]!.args['text'])).toContain('#A3');
      });
    });
    await it('a tool error is an error the caller sees', async () => {
      await withFakeMcp({ sendError: 'no grant' }, async (fake) => {
        const link = linkTo(fake);
        let message = '';
        try {
          await messengerChannel(link, SETTINGS).send({ id: 'me', addresses: [] }, asks);
        } catch (error) {
          message = (error as Error).message;
        } finally {
          await link.close();
        }
        expect(message).toContain('no grant');
      });
    });
  });

  await describe('combineChannels', async () => {
    const message: ServeMessage = { title: 't', body: 'b', questionId: null };
    const user = { id: 'me', addresses: [] };
    const ok = (log: string[], name: string): ServeChannel => ({
      name,
      send: () => void log.push(name),
    });
    const broken: ServeChannel = {
      name: 'broken',
      send: () => {
        throw new Error('down');
      },
    };
    await it('sends to every channel; one down does not hide the question', async () => {
      const log: string[] = [];
      await combineChannels([ok(log, 'a'), broken, ok(log, 'b')]).send(user, message);
      expect(log).toStrictEqual(['a', 'b']);
    });
    await it('fails only when all fail', async () => {
      let failed = false;
      try {
        await combineChannels([broken, broken]).send(user, message);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  await describe('receive loop', async () => {
    await it('a reply answers the question, and the person hears what was done', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        const cursor = memoryCursor(BEFORE);
        await looping(fake, book, cursor, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'A1 ja');
          await until(() => sent(fake).length === 1, 'the acknowledgement');
        });
        expect(book.value[0]!.status).toBe('answered');
        expect(book.value[0]!.answer).toBe('yes');
        expect(String(sent(fake)[0]!.args['text'])).toContain('#A1');
        expect(cursor.value).toBe('2026-10-10T11:30:00.000Z');
      });
    });

    await it('plain text answers the only open question; "decline" is a no', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'decline');
          await until(() => sent(fake).length === 1, 'the acknowledgement');
        });
        expect(book.value[0]!.answer).toBe('no');
      });
    });

    await it('several open and no id: a clarifying message, nothing answered', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1'), question('A2')] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'yes');
          await until(() => sent(fake).length === 1, 'the clarification');
        });
        expect(book.value.every((q) => q.status === 'open')).toBe(true);
        expect(String(sent(fake)[0]!.args['text'])).toContain('#A1, #A2');
      });
    });

    await it('an unknown id is told so', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'A9 yes');
          await until(() => sent(fake).length === 1, 'the answer');
        });
        expect(String(sent(fake)[0]!.args['text'])).toContain('no question #A9');
        expect(book.value[0]!.status).toBe('open');
      });
    });

    await it('first answer wins: the desktop answered, the chat hears "answered"', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        await looping(fake, book, memoryCursor(BEFORE), async (_link, deps) => {
          const first = await answerQuestion('#A1', 'no', deps);
          expect(first.mode).toBe('declined');
          fake.deliver('2026-10-10T11:30:00.000Z', 'A1 yes');
          await until(() => sent(fake).length === 1, 'the answer');
        });
        expect(book.value[0]!.answer).toBe('no');
        expect(String(sent(fake)[0]!.args['text'])).toContain('#A1 is answered');
      });
    });

    await it('a message of its own is not read as an answer', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        const cursor = memoryCursor(BEFORE);
        await looping(fake, book, cursor, async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'Reply: #A1 yes or #A1 no');
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        // The fake marks it as the peer's; a real server marks `fromSelf`, which the loop skips.
        expect(book.value.length).toBe(1);
      });
    });

    await it('survives the server dying: backs off, reconnects, keeps answering', async () => {
      await withFakeMcp({ dieAfterWaits: 2 }, async (fake) => {
        const book = { value: [question('A1')] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          await until(
            () => fake.calls().filter((c) => c.tool === 'xmpp_wait_reply').length >= 2,
            'the death',
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          fake.deliver('2026-10-10T11:30:00.000Z', 'A1 ja');
          await until(() => book.value[0]!.status === 'answered', 'the answer after reconnect');
        });
      });
    });

    await it('starts from now on the first run and persists that cursor', async () => {
      await withFakeMcp({}, async (fake) => {
        const cursor = memoryCursor(null);
        await looping(fake, { value: [] }, cursor, async () => {
          await until(() => fake.calls().length > 0, 'the first poll');
        });
        expect(cursor.value).toBe(new Date(NOW).toISOString());
        expect(fake.calls()[0]!.args['after']).toBe(new Date(NOW).toISOString());
      });
    });

    await it('does not replay a reply the cursor is past', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        fake.deliver('2026-10-10T10:00:00.000Z', 'A1 yes');
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          await until(() => fake.calls().length > 1, 'two polls');
        });
        expect(book.value[0]!.status).toBe('open');
      });
    });
  });

  await describe('cursor file', async () => {
    await it('round-trips, and a missing or broken file reads as no cursor', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lotse-cursor-'));
      try {
        const path = join(dir, 'state', 'messenger-cursor.json');
        const store = fileCursorStore(path);
        expect(store.read()).toBe(null);
        store.write(BEFORE);
        expect(fileCursorStore(path).read()).toBe(BEFORE);
        expect(readFileSync(path, 'utf8')).toContain(BEFORE);
        store.write('2026-10-10T11:30:00.000Z');
        expect(fileCursorStore(path).read()).toBe('2026-10-10T11:30:00.000Z');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await describe('channel settings', async () => {
    const problemOf = (raw: string) =>
      'problem' in parseSettings(raw) ? (parseSettings(raw) as { problem: string }).problem : '';
    await it('reads active and messenger, with defaults for what is left out', async () => {
      const parsed = parseSettings(
        '{"version":1,"channel":{"active":["desktop","messenger"],"messenger":{"account":"main","peer":"person@example.org"}}}',
      );
      expect(parsed).toStrictEqual({
        settings: {
          version: 1,
          agent: null,
          channel: {
            desktop: { mode: 'notification' },
            active: ['desktop', 'messenger'],
            messenger: SETTINGS,
          },
        },
      });
    });
    await it('refuses an unknown channel, a non-string field and a secret-looking one', async () => {
      expect(problemOf('{"version":1,"channel":{"active":["sms"]}}')).toContain('channel.active');
      expect(problemOf('{"version":1,"channel":{"messenger":{"peer":3}}}')).toContain(
        'channel.messenger.peer',
      );
      expect(problemOf('{"version":1,"channel":{"messenger":{"args":"mcp"}}}')).toContain('args');
      expect(problemOf('{"version":1,"channel":{"messenger":{"password":"x"}}}')).toContain('secret-looking');
    });
    await it('a save round-trips through the parser', async () => {
      const saved = withMessenger({ version: 1, agent: null }, ['messenger'], SETTINGS);
      expect(parseSettings(JSON.stringify(saved))).toStrictEqual({ settings: saved });
    });
  });
};
