import { describe, expect, it } from '@gjsify/unit';

import {
  McpLink,
  McpToolError,
  renderForXmpp,
  sendToPeer,
  type MessengerSettings,
  type McpTools,
} from '@lotse/core';

const SETTINGS: MessengerSettings = {
  command: 'curlew',
  args: [],
  account: 'xmpp-abc123',
  peer: 'owner@example.org',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

const texts = (markdown: string) =>
  renderForXmpp(markdown)
    .map((s) => (s.kind === 'text' ? s.text : `[img ${s.url}]`))
    .join('|');

function linkWith(calls: Record<string, unknown>[], refuseImages = false): McpLink {
  const tools: McpTools = {
    closed: new Promise(() => {}),
    async call(_tool, args) {
      if (refuseImages && 'image_url' in args) throw new McpToolError('send_message', 'text is required');
      calls.push({ ...args });
      return {};
    },
    async listTools() {
      return ['send_message'];
    },
    async close() {},
  };
  return new McpLink(async () => tools);
}

export default async () => {
  await describe('Markdown for XMPP (XEP-0393)', async () => {
    await it('turns bold, italic, headings and lists into message styling', async () => {
      expect(texts('# Title\n\n**bold** and *it* and `**code**`\n\n- one\n* two')).toBe(
        '*Title*\n\n*bold* and _it_ and `**code**`\n\n• one\n• two',
      );
    });

    await it('writes a link as "text: url" with the whole URL', async () => {
      expect(texts('[Zur Anzeige](https://example.org/a?b=1&c=(2))')).toBe(
        'Zur Anzeige: https://example.org/a?b=1&c=(2)',
      );
      expect(texts('[https://example.org/x](https://example.org/x)')).toBe('https://example.org/x');
    });

    await it('leaves fenced code alone and keeps quotes', async () => {
      expect(texts('> quoted\n```\n**x** [a](b)\n```')).toBe('> quoted\n```\n**x** [a](b)\n```');
    });

    await it('splits at an image line and keeps the order', async () => {
      expect(
        texts('**A**\n\nWarum: x\n![](https://example.org/a.jpg)\n**B**\n![alt](https://example.org/b.jpg)'),
      ).toBe('*A*\n\nWarum: x|[img https://example.org/a.jpg]|*B*|[img https://example.org/b.jpg]');
    });

    await it('turns a non-https image into a link and caps the images', async () => {
      expect(texts('![x](http://example.org/a.jpg)')).toBe('x: http://example.org/a.jpg');
      const many = Array.from({ length: 10 }, (_, i) => `![](https://example.org/${i}.jpg)`).join('\n');
      const out = renderForXmpp(many);
      expect(out.filter((s) => s.kind === 'image').length).toBe(8);
      expect(out[out.length - 1]).toStrictEqual({
        kind: 'text',
        text: 'https://example.org/8.jpg\nhttps://example.org/9.jpg',
      });
    });

    await it('cuts a very long text into chunks', async () => {
      const long = Array.from({ length: 40 }, () => 'x'.repeat(400)).join('\n\n');
      const parts = renderForXmpp(long);
      expect(parts.length).toBe(3);
      expect(parts.every((p) => p.kind === 'text' && p.text.length <= 7000)).toBe(true);
    });
  });

  await describe('sendToPeer with images', async () => {
    await it('sends text, image, text as separate calls in order', async () => {
      const calls: Record<string, unknown>[] = [];
      await sendToPeer(linkWith(calls), SETTINGS, 'one\n![](https://example.org/a.jpg)\ntwo');
      expect(calls.map((c) => c.text ?? c.image_url).join('|')).toBe('one|https://example.org/a.jpg|two');
      expect(calls[1]).toStrictEqual({
        account: 'xmpp-abc123',
        to: 'owner@example.org',
        image_url: 'https://example.org/a.jpg',
      });
    });

    await it('falls back to a plain link when the server has no image_url', async () => {
      const calls: Record<string, unknown>[] = [];
      await sendToPeer(
        linkWith(calls, true),
        SETTINGS,
        'one\n![](https://example.org/a.jpg)\n![](https://example.org/b.jpg)',
      );
      expect(calls.map((c) => c.text).join('|')).toBe(
        'one|https://example.org/a.jpg|https://example.org/b.jpg',
      );
    });
  });
};
