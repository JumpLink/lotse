import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  abortableSleep,
  answerQuestion,
  chatSays,
  combineChannels,
  connectMcp,
  localDeadline,
  findRef,
  memoryRefs,
  recordRefs,
  messengerChannel,
  messengerText,
  noticeOf,
  parseReply,
  parseServeConfig,
  routeChannels,
  runReceiveLoop,
  type Cursor,
  type CursorStore,
  type McpTools,
  type MessageSource,
  type MessengerSettings,
  type NextOptions,
  type RefStore,
  type Question,
  type QuestionChannel,
  type RunDeps,
  type QuestionMessage,
} from '@lotse/core';
import { fileCursorStore } from '../../../src/core/messenger-state.ts';
import { parseSettings, withMessenger } from '../../../src/core/settings.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Task `t` with no restriction, `tui` kept off the messenger, `quiet` sending the chat a notice only. */
const ROUTED = parseServeConfig(
  JSON.stringify({
    version: 1,
    users: [{ id: 'me' }],
    profiles: [{ id: 'p', user: 'me', data: 'public' }],
    tasks: [
      { id: 't', profile: 'p', prompt: 'x', cwd: '/fixture' },
      {
        id: 'tui',
        profile: 'p',
        prompt: 'x',
        cwd: '/fixture',
        channels: ['desktop'],
      },
      {
        id: 'quiet',
        profile: 'p',
        prompt: 'x',
        cwd: '/fixture',
        messengerDetail: 'notice',
      },
    ],
  }),
);

function runDeps(book: { value: Question[] }): RunDeps {
  return {
    config: ROUTED,
    questions: {
      read: () => book.value.map((q) => ({ ...q })),
      write: (next: Question[]) => void (book.value = [...next]),
    },
    now: () => new Date(NOW),
    sleep: async () => {},
  } as unknown as RunDeps;
}

function memoryCursor(initial: string | null): CursorStore & { value: Cursor | null } {
  const store = {
    value: initial === null ? null : ({ at: initial, seen: [] } as Cursor | null),
    read: () => store.value,
    write: (cursor: Cursor) => void (store.value = cursor),
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
  body: (link: McpLink, deps: RunDeps) => Promise<void>,
  refs?: RefStore,
): Promise<void> {
  const link = linkTo(fake);
  const abort = new AbortController();
  const deps = runDeps(book);
  const loop = runReceiveLoop({
    link,
    settings: SETTINGS,
    deps: deps,
    cursor,
    signal: abort.signal,
    ...(refs ? { refs } : {}),
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

  await describe('parseReply with a reply reference', async () => {
    await it('a referenced open question settles a tagless reply among several', async () => {
      expect(parseReply('yes', ['A1', 'A2'], 'A2')).toStrictEqual({
        kind: 'answer',
        questionId: 'A2',
        text: 'yes',
      });
      expect(parseReply('yes', ['A1', 'A2'], 'A9')).toStrictEqual({ kind: 'ambiguous', open: ['A1', 'A2'] });
    });
  });

  await describe('chatSays', async () => {
    const base = { question: null, run: null };
    await it('a continued session is "Got it", never the internals', async () => {
      for (const mode of ['loaded', 'resumed', 'follow-up'] as const) {
        const said = chatSays('A4', {
          ...base,
          mode,
          message: '#A4: resumed the session with session/load',
        });
        expect(said).toBe('Got it, #A4.');
        expect(said).not.toContain('session');
      }
    });
    await it('a dropped answer names the status, never the stored resolution', async () => {
      const reason = 'the run failed: disk /srv/secret is full';
      const said = chatSays('A4', {
        ...base,
        mode: 'dropped',
        message: `#A4 is answered (${reason}); nothing waits for this answer`,
        question: question('A4', 'reply', { status: 'answered', resolution: reason }),
      });
      expect(said).toBe('#A4 is already answered.');
    });
    await it('an expired answer shows the local deadline, not the ISO time', async () => {
      const said = chatSays('A4', {
        ...base,
        mode: 'expired',
        message: '#A4 expired at 2026-10-11T00:00:00.000Z; the answer was dropped',
        question: question('A4', 'reply', { status: 'expired', expiresAt: '2026-10-11T00:00:00.000Z' }),
      });
      expect(said).toBe(`#A4 expired at ${localDeadline('2026-10-11T00:00:00.000Z')}.`);
      expect(said).not.toContain('.000Z');
    });
    await it('localDeadline takes an explicit locale', async () => {
      expect(localDeadline('2026-10-11T12:00:00.000Z', 'en-US')).toContain('10/11');
      expect(localDeadline('not a date')).toBe('not a date');
    });
    await it('other outcomes keep their own sentence', async () => {
      expect(chatSays('A4', { ...base, mode: 'unknown', message: 'there is no question #A4' })).toBe(
        'there is no question #A4',
      );
    });
  });

  await describe('messenger channel', async () => {
    const asks: QuestionMessage = {
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
      expect(text).toContain(`Valid until ${localDeadline('2026-10-11T00:00:00.000Z')}`);
      expect(text).not.toContain('2026-10-11T');
      expect(text).not.toContain('.000Z');
      expect(text).not.toContain('lotse answer');
    });
    await it('notice mode keeps the question text out and still shows a local deadline', async () => {
      const text = messengerText(
        noticeOf({ ...asks, text: 'Archive invoice 4711?', body: 'Archive invoice 4711?' }),
      );
      expect(text).not.toContain('4711');
      expect(text).toContain('Valid until ');
      expect(text).not.toContain('.000Z');
    });
    await it('a reply question asks for text; a report carries no hint', async () => {
      expect(messengerText({ ...asks, asks: 'reply' })).toContain('Reply: #A3 <your answer>');
      expect(messengerText({ title: 'lotse listen stopped', body: 'why', questionId: null })).toBe(
        'lotse listen stopped\n\nwhy',
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
    const message: QuestionMessage = { title: 't', body: 'b', questionId: null };
    const user = { id: 'me', addresses: [] };
    const ok = (log: string[], name: string): QuestionChannel => ({
      name,
      send: () => void log.push(name),
    });
    const broken: QuestionChannel = {
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
    await it('reports a failed channel even when another one delivered', async () => {
      const log: string[] = [];
      const heard: string[] = [];
      await combineChannels([ok(log, 'a'), broken], (name, error) =>
        heard.push(`${name}: ${(error as Error).message}`),
      ).send(user, message);
      expect(log).toStrictEqual(['a']);
      expect(heard).toStrictEqual(['broken: down']);
    });
    await it('a reporter that throws does not fail the send', async () => {
      const log: string[] = [];
      await combineChannels([ok(log, 'a'), broken], () => {
        throw new Error('log is full');
      }).send(user, message);
      expect(log).toStrictEqual(['a']);
    });
  });

  await describe('routeChannels', async () => {
    const user = { id: 'me', addresses: [] };
    const secret = 'Archive invoice 4711 from Example Corp?';
    const asking = (task: string): QuestionMessage => ({
      title: `lotse · ${task} · #A5`,
      body: `${secret}\n\nAnswer: lotse answer A5 <text>`,
      text: secret,
      questionId: 'A5',
      task,
      asks: 'reply',
      expiresAt: '2026-10-11T00:00:00.000Z',
    });
    const recorder = (into: QuestionMessage[]): QuestionChannel => ({
      name: 'desktop',
      send: (_user, message) => void into.push(message),
    });

    await it('a task restricted to the desktop never reaches the messenger send tool', async () => {
      await withFakeMcp({}, async (fake) => {
        const link = linkTo(fake);
        const desktop: QuestionMessage[] = [];
        try {
          const channel = routeChannels(
            [
              { name: 'desktop', channel: recorder(desktop) },
              { name: 'messenger', channel: messengerChannel(link, SETTINGS) },
            ],
            ROUTED,
          );
          await channel.send(user, asking('tui'));
          await channel.send(user, { title: 'done', body: secret, questionId: null, task: 'tui' });
        } finally {
          await link.close();
        }
        expect(fake.calls().filter((call) => call.tool === 'send_message').length).toBe(0);
        expect(desktop.length).toBe(2);
        expect(desktop[0]!.body).toContain(secret);
      });
    });

    await it('notice mode sends the chat no question text; the desktop keeps it', async () => {
      await withFakeMcp({}, async (fake) => {
        const link = linkTo(fake);
        const desktop: QuestionMessage[] = [];
        try {
          const channel = routeChannels(
            [
              { name: 'desktop', channel: recorder(desktop) },
              { name: 'messenger', channel: messengerChannel(link, SETTINGS) },
            ],
            ROUTED,
          );
          await channel.send(user, asking('quiet'));
          await channel.send(user, { title: 'lotse · quiet', body: secret, questionId: null, task: 'quiet' });
        } finally {
          await link.close();
        }
        const texts = sent(fake).map((call) => String(call.args['text']));
        expect(texts.length).toBe(2);
        for (const text of texts) {
          expect(text).not.toContain('4711');
          expect(text).not.toContain('Example Corp');
        }
        expect(texts[0]).toContain('A question is waiting in quiet');
        expect(texts[0]).toContain('#A5');
        expect(desktop[0]!.body).toContain(secret);
      });
    });

    await it('a notice that fails to send is retried as the notice, never the full question', async () => {
      await withFakeMcp({ sendFailures: 1 }, async (fake) => {
        const link = linkTo(fake);
        const clock = { t: 0 };
        const messenger = messengerChannel(link, SETTINGS, { now: () => clock.t, retryDelaysMs: [100] });
        try {
          const channel = routeChannels([{ name: 'messenger', channel: messenger }], ROUTED);
          await Promise.resolve(channel.send(user, asking('quiet'))).catch(() => {});
          clock.t = 100;
          expect(
            await messenger.retryUnsent(
              () => true,
              () => {},
            ),
          ).toStrictEqual(['A5']);
        } finally {
          await link.close();
        }
        const texts = sent(fake).map((call) => String(call.args['text']));
        expect(texts.length).toBe(2);
        for (const text of texts) {
          expect(text).toContain('A question is waiting in quiet');
          expect(text).not.toContain('4711');
          expect(text).not.toContain('Example Corp');
        }
      });
    });

    await it('an unrestricted task and listen news go to every channel in full', async () => {
      const desktop: QuestionMessage[] = [];
      const chat: QuestionMessage[] = [];
      const channel = routeChannels(
        [
          { name: 'desktop', channel: recorder(desktop) },
          { name: 'messenger', channel: { name: 'messenger', send: (_u, m) => void chat.push(m) } },
        ],
        ROUTED,
      );
      await channel.send(user, asking('t'));
      await channel.send(user, { title: 'lotse listen stopped', body: 'why', questionId: null });
      expect(chat.map((m) => m.text ?? m.body)).toStrictEqual([secret, 'why']);
      expect(desktop.length).toBe(2);
    });
  });

  await describe('messenger retry', async () => {
    const user = { id: 'me', addresses: [] };
    const asks: QuestionMessage = {
      title: 'lotse · t · #A4',
      body: 'Allow it?',
      text: 'Allow it?',
      questionId: 'A4',
      asks: 'permission',
    };
    const retrying = (fake: FakeMcp, link: McpLink, clock: { t: number }) =>
      messengerChannel(link, SETTINGS, { now: () => clock.t, retryDelaysMs: [100, 100] });
    const failures: string[] = [];
    const heard = (id: string, error: unknown, gaveUp: boolean) =>
      failures.push(`${id}:${(error as Error).message}:${gaveUp}`);

    await it('delivers once after a transient failure, and never twice', async () => {
      await withFakeMcp({ sendFailures: 1 }, async (fake) => {
        const link = linkTo(fake);
        const clock = { t: 0 };
        try {
          const channel = retrying(fake, link, clock);
          let threw = false;
          try {
            await channel.send(user, asks);
          } catch {
            threw = true;
          }
          expect(threw).toBe(true);
          expect(await channel.retryUnsent(() => true, heard)).toStrictEqual([]);
          clock.t = 100;
          expect(await channel.retryUnsent(() => true, heard)).toStrictEqual(['A4']);
          clock.t = 1000;
          expect(await channel.retryUnsent(() => true, heard)).toStrictEqual([]);
        } finally {
          await link.close();
        }
        expect(sent(fake).length).toBe(2);
        expect(String(sent(fake)[1]!.args['text'])).toContain('#A4');
      });
    });
    await it('does not retry a question that was answered meanwhile', async () => {
      await withFakeMcp({ sendFailures: 1 }, async (fake) => {
        const link = linkTo(fake);
        const clock = { t: 0 };
        try {
          const channel = retrying(fake, link, clock);
          await Promise.resolve(channel.send(user, asks)).catch(() => {});
          clock.t = 100;
          expect(await channel.retryUnsent(() => false, heard)).toStrictEqual([]);
          expect(await channel.retryUnsent(() => true, heard)).toStrictEqual([]);
        } finally {
          await link.close();
        }
        expect(sent(fake).length).toBe(1);
      });
    });
    await it('gives up after the last delay and says so', async () => {
      await withFakeMcp({ sendError: 'down' }, async (fake) => {
        const link = linkTo(fake);
        const clock = { t: 0 };
        failures.length = 0;
        try {
          const channel = retrying(fake, link, clock);
          await Promise.resolve(channel.send(user, asks)).catch(() => {});
          clock.t = 100;
          await channel.retryUnsent(() => true, heard);
          clock.t = 200;
          await channel.retryUnsent(() => true, heard);
          clock.t = 300;
          await channel.retryUnsent(() => true, heard);
        } finally {
          await link.close();
        }
        expect(failures.length).toBe(2);
        expect(failures[1]!.endsWith(':true')).toBe(true);
        expect(sent(fake).length).toBe(3);
      });
    });
    await it('the receive loop retries it while the question is open', async () => {
      await withFakeMcp({ sendFailures: 1 }, async (fake) => {
        const book = { value: [question('A4')] };
        const link = linkTo(fake);
        const channel = messengerChannel(link, SETTINGS, { retryDelaysMs: [0] });
        await Promise.resolve(channel.send(user, asks)).catch(() => {});
        const abort = new AbortController();
        const lines: string[] = [];
        const loop = runReceiveLoop({
          link,
          settings: SETTINGS,
          deps: runDeps(book),
          cursor: memoryCursor(BEFORE),
          signal: abort.signal,
          channel,
          log: (line) => lines.push(line),
          timeoutS: 1,
          minCycleMs: 0,
          backoff: { initialMs: 10, maxMs: 40 },
          sleep: (_ms, signal) => abortableSleep(10, signal),
        });
        try {
          await until(() => sent(fake).length === 2, 'the retry');
        } finally {
          abort.abort();
          await loop;
          await link.close();
        }
        expect(lines.some((line) => line.includes('#A4'))).toBe(true);
      });
    });
  });

  await describe('replies to a question message', async () => {
    await it('the channel remembers the id of the message that carried the question', async () => {
      await withFakeMcp({}, async (fake) => {
        const refs = memoryRefs();
        const link = linkTo(fake);
        const user = { id: 'me', addresses: [] };
        const asks: QuestionMessage = {
          title: 't',
          body: 'b',
          text: 'Allow it?',
          questionId: 'A4',
          asks: 'permission',
        };
        try {
          const channel = messengerChannel(link, SETTINGS, { refs });
          await channel.send(user, asks);
        } finally {
          await link.close();
        }
        expect(findRef(refs, 'o1')).toStrictEqual({ messageId: 'o1', user: 'me', questionId: 'A4' });
        expect(findRef(refs, 'other')).toBe(null);
      });
    });

    await it('binds the answer to the replied-to question even with several open', async () => {
      await withFakeMcp({ contract: true }, async (fake) => {
        const refs = memoryRefs();
        recordRefs(refs, 'me', 'A1', ['o-1']);
        recordRefs(refs, 'me', 'A2', ['o-2']);
        const book = { value: [question('A1'), question('A2')] };
        await looping(
          fake,
          book,
          memoryCursor(BEFORE),
          async () => {
            fake.deliver('2026-10-10T11:30:00.000Z', '> Allow it?\n\nyes', undefined, 'o-2');
            await until(() => sent(fake).length === 1, 'the acknowledgement');
          },
          refs,
        );
        expect(book.value.map((q) => q.status).join()).toBe('open,answered');
        expect(book.value[1]!.answer).toBe('yes');
        expect(String(sent(fake)[0]!.args['text'])).toBe('Got it, #A2.');
      });
    });

    await it('says so when the replied-to question is settled, and answers nothing else', async () => {
      await withFakeMcp({}, async (fake) => {
        const refs = memoryRefs();
        recordRefs(refs, 'me', 'A1', ['o-1']);
        const book = { value: [question('A1', 'permission', { status: 'answered' }), question('A2')] };
        await looping(
          fake,
          book,
          memoryCursor(BEFORE),
          async () => {
            fake.deliver('2026-10-10T11:30:00.000Z', 'yes', undefined, 'o-1');
            await until(() => sent(fake).length === 1, 'the notice');
          },
          refs,
        );
        expect(String(sent(fake)[0]!.args['text'])).toBe('#A1 is already answered.');
        expect(book.value[1]!.status).toBe('open');
      });
    });

    await it('an explicit id in the text still wins, and an unknown reply id reads as plain text', async () => {
      await withFakeMcp({}, async (fake) => {
        const refs = memoryRefs();
        recordRefs(refs, 'me', 'A2', ['o-2']);
        const book = { value: [question('A1'), question('A2')] };
        await looping(
          fake,
          book,
          memoryCursor(BEFORE),
          async () => {
            fake.deliver('2026-10-10T11:30:00.000Z', '#A1 no', undefined, 'o-2');
            await until(() => sent(fake).length === 1, 'the first notice');
            fake.deliver('2026-10-10T11:31:00.000Z', 'yes', undefined, 'unrelated');
            await until(() => sent(fake).length === 2, 'the second notice');
          },
          refs,
        );
        // `#A1 no` beat the reply to A2's message; the unknown reply id then fell back to the one open question.
        expect(book.value.map((q) => q.answer).join()).toBe('no,yes');
        expect(String(sent(fake)[0]!.args['text'])).toBe('Got it, #A1.');
        expect(String(sent(fake)[1]!.args['text'])).toBe('Got it, #A2.');
      });
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
        expect(String(sent(fake)[0]!.args['text'])).toBe('Got it, #A1.');
        expect(cursor.value).toStrictEqual({ at: '2026-10-10T11:30:00.000Z', seen: ['m1'] });
      });
    });

    await it('an answer to a question already settled with a failed run leaks no reason', async () => {
      await withFakeMcp({}, async (fake) => {
        const reason = 'the run failed: token sk-synthetic-123 rejected';
        const book = {
          value: [
            question('A1', 'reply', {
              status: 'answered',
              resolution: `continuing the session, but ${reason}`,
            }),
          ],
        };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'A1 again');
          await until(() => sent(fake).length === 1, 'the reply');
        });
        const text = String(sent(fake)[0]!.args['text']);
        expect(text).toBe('#A1 is already answered.');
        expect(text).not.toContain('sk-synthetic');
        expect(text).not.toContain('failed');
      });
    });

    await it('the cursor never moves back', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        const writes: Cursor[] = [];
        const cursor: CursorStore = {
          read: () => ({ at: BEFORE, seen: [] }),
          write: (next) => void writes.push(next),
        };
        await looping(fake, book, cursor, async () => {
          // One batch, newest first: the older message must not pull the cursor back.
          fake.deliver('2026-10-10T11:30:00.000Z', 'A1 ja');
          fake.deliver('2026-10-10T11:10:00.000Z', 'A1 ja');
          await until(() => sent(fake).length >= 2, 'both replies');
          expect(writes).toStrictEqual([{ at: '2026-10-10T11:30:00.000Z', seen: ['m1'] }]);
        });
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

    await it('questions kept off the chat do not count as open: one visible, one answer', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1'), question('A2', 'reply', { task: 'tui' })] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'yes');
          await until(() => sent(fake).length === 1, 'the acknowledgement');
        });
        expect(book.value[0]!.status).toBe('answered');
        expect(book.value[1]!.status).toBe('open');
      });
    });

    await it("with several open the chat hears ids only, never a hidden task's text", async () => {
      await withFakeMcp({}, async (fake) => {
        const secret = 'Archive invoice 4711?';
        const book = {
          value: [question('A1'), question('A2'), question('A3', 'reply', { task: 'tui', text: secret })],
        };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'yes');
          await until(() => sent(fake).length === 1, 'the clarification');
        });
        const reply = String(sent(fake)[0]!.args['text']);
        expect(reply).toContain('#A1, #A2');
        expect(reply).not.toContain('#A3');
        expect(reply).not.toContain('4711');
      });
    });

    await it('a message without sentAt is not lost', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1')] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver(null, 'A1 ja');
          await until(() => sent(fake).length === 1, 'the acknowledgement');
        });
        expect(book.value[0]!.status).toBe('answered');
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
        expect(String(sent(fake)[0]!.args['text'])).toBe('#A1 is already answered.');
      });
    });

    await it('a question kept off the chat cannot be answered from it', async () => {
      await withFakeMcp({}, async (fake) => {
        const book = { value: [question('A1', 'reply', { task: 'tui' })] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', 'go ahead');
          await until(() => sent(fake).length === 1, 'the first reply');
          fake.deliver('2026-10-10T11:31:00.000Z', 'A1 go ahead');
          await until(() => sent(fake).length === 2, 'the second reply');
        });
        expect(book.value[0]!.status).toBe('open');
        expect(String(sent(fake)[0]!.args['text'])).toContain('No question is waiting');
        expect(String(sent(fake)[1]!.args['text'])).toContain('#A1 is not answered in this chat');
      });
    });

    await it('an id-prefixed reply to a hidden question leaks only the id', async () => {
      await withFakeMcp({}, async (fake) => {
        const text = 'Archive invoice 4711 from Example Corp?';
        const book = { value: [question('A1', 'reply', { task: 'tui', text })] };
        await looping(fake, book, memoryCursor(BEFORE), async () => {
          fake.deliver('2026-10-10T11:30:00.000Z', '#A1 yes');
          await until(() => sent(fake).length === 1, 'the refusal');
        });
        const reply = String(sent(fake)[0]!.args['text']);
        expect(reply).toContain('#A1 is not answered in this chat');
        expect(reply).not.toContain('4711');
        expect(reply).not.toContain('Example Corp');
        expect(book.value[0]!.status).toBe('open');
        expect(book.value[0]!.answer).toBe(null);
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
        expect(cursor.value).toStrictEqual({ at: new Date(NOW).toISOString(), seen: [] });
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
        store.write({ at: BEFORE, seen: [] });
        expect(fileCursorStore(path).read()).toStrictEqual({ at: BEFORE, seen: [] });
        expect(readFileSync(path, 'utf8')).toBe(`{"cursor":"${BEFORE}"}\n`);
        store.write({ at: '2026-10-10T11:30:00.000Z', seen: ['m1', 'm2'] });
        expect(fileCursorStore(path).read()).toStrictEqual({
          at: '2026-10-10T11:30:00.000Z',
          seen: ['m1', 'm2'],
        });
        writeFileSync(path, '{"cursor": 7}');
        expect(fileCursorStore(path).read()).toBe(null);
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

  await describe('the receive seam', async () => {
    await it('reads through any MessageSource, resets it after a failure and needs no wait tool', async () => {
      const sends: string[] = [];
      const tools: McpTools = {
        closed: new Promise(() => {}),
        async call(_tool, args) {
          sends.push(String(args['text']));
          return {};
        },
        async describeTools() {
          return [];
        },
        async close() {},
      };
      const asked: { after: string; waitS: number }[] = [];
      let resets = 0;
      const source: MessageSource = {
        async next(after: string, { waitS, signal }: NextOptions) {
          asked.push({ after, waitS });
          if (asked.length === 1) throw new Error('boom');
          if (asked.length === 2)
            return {
              messages: [
                {
                  id: 'x1',
                  bodyText: 'yes',
                  sentAt: '2026-10-10T11:30:00.000Z',
                  fromSelf: false,
                  replyToId: null,
                },
              ],
              cursor: null,
            };
          await abortableSleep(20, signal);
          return { messages: [], cursor: null };
        },
        async reset() {
          resets += 1;
        },
      };
      const book = { value: [question('A1')] };
      const abort = new AbortController();
      const link = new McpLink(async () => tools);
      const loop = runReceiveLoop({
        link,
        settings: SETTINGS,
        source,
        deps: runDeps(book),
        cursor: memoryCursor(BEFORE),
        signal: abort.signal,
        timeoutS: 1,
        minCycleMs: 0,
        backoff: { initialMs: 10, maxMs: 40 },
        sleep: (_ms, signal) => abortableSleep(10, signal),
      });
      try {
        await until(() => sends.length === 1, 'the acknowledgement');
      } finally {
        abort.abort();
        await loop;
        await link.close();
      }
      expect(book.value[0]!.status).toBe('answered');
      expect(sends[0]).toBe('Got it, #A1.');
      expect(resets).toBe(1);
      expect(asked[0]).toStrictEqual({ after: BEFORE, waitS: 1 });
      expect(asked[1]!.after).toBe(BEFORE);
    });
  });
};
