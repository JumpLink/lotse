import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  connectMcp,
  longPollSource,
  messengerChannel,
  parseCapabilities,
  sendToPeerWithIds,
  waitSeconds,
  type MessengerSettings,
} from '@lotse/core';
import { withFakeMcp, type FakeMcp } from '../../support/fake-mcp.ts';

const SETTINGS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: 'main',
  peer: 'person@example.org',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

const NO_ABORT = new AbortController().signal;

const sends = (fake: FakeMcp) => fake.calls().filter((call) => call.tool === 'send_message');
const waits = (fake: FakeMcp) => fake.calls().filter((call) => call.tool === 'xmpp_wait_reply');

export default async () => {
  await describe('a server that meets the contract', async () => {
    await it('is sent Markdown with format "markdown", whole and unrendered', async () => {
      await withFakeMcp({ contract: true }, async (fake) => {
        const lines: string[] = [];
        const link = new McpLink(
          () => connectMcp(fake.command),
          (line) => lines.push(line),
        );
        const long = `# Title\n\n**bold** ${'x'.repeat(20_000)}\n![](https://example.org/a.jpg)`;
        try {
          const ids = await sendToPeerWithIds(link, SETTINGS, long);
          expect(ids).toStrictEqual(['o1']);
        } finally {
          await link.close();
        }
        expect(sends(fake).length).toBe(1);
        expect(sends(fake)[0]!.args).toStrictEqual({
          account: 'main',
          to: 'person@example.org',
          text: long,
          format: 'markdown',
        });
        expect(lines.length).toBe(0);
      });
    });

    await it('asks the wait tool to strip quotes and keeps the wait under its limit', async () => {
      await withFakeMcp({ contract: true, maxWaitS: 5 }, async (fake) => {
        const link = new McpLink(() => connectMcp(fake.command));
        fake.deliver('2026-10-10T11:30:00.000Z', '> Allow it?\n\nyes', 'm1', 'o-2');
        try {
          const page = await longPollSource(link, SETTINGS).next('2026-10-10T11:00:00.000Z', {
            waitS: 60,
            signal: NO_ABORT,
          });
          expect(page.messages[0]!.bodyText).toBe('yes');
        } finally {
          await link.close();
        }
        expect(waits(fake)[0]!.args['strip_quotes']).toBe(true);
        expect(waits(fake)[0]!.args['timeout_s']).toBe(5);
      });
    });

    await it('reports every message id of a split text', async () => {
      const link = new McpLink(async () => ({
        closed: new Promise<void>(() => {}),
        async call(tool: string) {
          return tool === 'send_message' ? { originId: 'a', originIds: ['a', 'b'] } : {};
        },
        async describeTools() {
          return [{ name: 'send_message', inputs: ['format'] }];
        },
        async close() {},
      }));
      expect(await sendToPeerWithIds(link, SETTINGS, 'x')).toStrictEqual(['a', 'b']);
    });

    await it('uses the configured capability tool name', async () => {
      const called: string[] = [];
      const link = new McpLink(async () => ({
        closed: new Promise<void>(() => {}),
        async call(tool: string) {
          called.push(tool);
          return { protocols: [] };
        },
        async describeTools() {
          return [
            { name: 'send_message', inputs: ['format'] },
            { name: 'xmpp_wait_reply', inputs: ['strip_quotes'] },
            { name: 'caps', inputs: [] },
          ];
        },
        async close() {},
      }));
      await sendToPeerWithIds(link, { ...SETTINGS, capabilitiesTool: 'caps' }, 'x');
      expect(called.join()).toBe('caps,send_message');
    });
  });

  await describe('an older server', async () => {
    await it('gets the text as plain, unrendered and uncut, and one notice', async () => {
      await withFakeMcp({}, async (fake) => {
        const lines: string[] = [];
        const link = new McpLink(
          () => connectMcp(fake.command),
          (line) => lines.push(line),
        );
        const text = `# Title\n\n**bold** ${'x'.repeat(20_000)}\n![](https://example.org/a.jpg)`;
        try {
          await sendToPeerWithIds(link, SETTINGS, text);
          await sendToPeerWithIds(link, SETTINGS, 'again');
          await messengerChannel(link, SETTINGS).send(
            { id: 'me', addresses: [] },
            { title: 't', body: 'third', questionId: null },
          );
        } finally {
          await link.close();
        }
        expect(sends(fake).length).toBe(3);
        expect(sends(fake)[0]!.args).toStrictEqual({ account: 'main', to: 'person@example.org', text });
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain('older than the contract');
      });
    });

    await it('waits 60 s, does not ask for stripped quotes and leaves the reply as it came', async () => {
      await withFakeMcp({}, async (fake) => {
        const link = new McpLink(() => connectMcp(fake.command));
        fake.deliver('2026-10-10T11:30:00.000Z', '> Allow it?\n\nyes', 'm1', 'o-2');
        try {
          const page = await longPollSource(link, SETTINGS).next('2026-10-10T11:00:00.000Z', {
            waitS: 60,
            signal: NO_ABORT,
          });
          expect(page.messages[0]!.bodyText).toBe('> Allow it?\n\nyes');
        } finally {
          await link.close();
        }
        expect('strip_quotes' in waits(fake)[0]!.args).toBe(false);
        expect(waits(fake)[0]!.args['timeout_s']).toBe(60);
      });
    });
  });

  await describe('the capability tool result', async () => {
    await it('is read for the account, else the only protocol, else not at all', async () => {
      const entry = (accounts: string[], max: number) => ({
        protocol: 'xmpp',
        accounts,
        maxMessageChars: 8000,
        waitTimeoutS: { default: 60, max },
      });
      expect(
        parseCapabilities({ protocols: [entry(['x'], 1), entry(['main'], 9)] }, 'main')!.waitTimeoutS!.max,
      ).toBe(9);
      expect(parseCapabilities({ protocols: [entry(['x'], 7)] }, 'main')!.waitTimeoutS!.max).toBe(7);
      expect(parseCapabilities({ protocols: [entry(['x'], 1), entry(['y'], 2)] }, 'main')).toBe(null);
      expect(parseCapabilities('nope', 'main')).toBe(null);
    });

    await it('caps a wait only when the server states a limit', async () => {
      const base = { format: 'plain', stripQuotes: false, capabilities: null, notice: null } as const;
      expect(waitSeconds({ ...base, maxWaitS: null }, undefined)).toBe(60);
      expect(waitSeconds({ ...base, maxWaitS: null }, 300)).toBe(300);
      expect(waitSeconds({ ...base, maxWaitS: 30 }, 60)).toBe(30);
      expect(waitSeconds({ ...base, maxWaitS: 30 }, 0)).toBe(0);
    });
  });
};
