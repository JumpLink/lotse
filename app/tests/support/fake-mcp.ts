/**
 * A real MCP server over stdio for the messenger tests: real framing, a real `initialize`, real
 * `tools/list` and `tools/call` — in plain Node with no SDK, so the client under test is the only SDK
 * in the room. It is written to a temp directory and started as `node <file>`, the way the stand-in
 * agent is, so the same test runs on GJS and on Node.
 *
 * It behaves like curlew's two tools and nothing else:
 *
 * - `send_message {account, to, text}` → `{conversationId, sentAt}`, listed unless `noSend`.
 * - `xmpp_wait_reply {account, peer, after, timeout_s}` → `{status:'reply', messages, cursor}` for the
 *   inbox entries sent after `after`, else `{status:'timeout', cursor}` after a short wait (the
 *   fixture waits `waitMs`, not `timeout_s` — the tests are not meant to sit).
 *
 * Every call is appended to the `calls` file as one JSON line, so a test reads what the client sent.
 * The inbox is a file too: a test appends to it while the loop is polling. `dieAfterWaits` ends the
 * first process that answers that many waits — and, because a marker file remembers it, only the first.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCommand } from '@lotse/core';

const SERVER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const dir = process.env.FAKE_MCP_DIR;
const opts = JSON.parse(process.env.FAKE_MCP_OPTIONS || '{}');
const log = (line) => fs.appendFileSync(dir + '/calls', JSON.stringify(line) + '\n');
const inbox = () => { try { return JSON.parse(fs.readFileSync(dir + '/inbox', 'utf8')); } catch { return []; } };
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tools = [
  { name: 'send_message', description: 'send', inputSchema: { type: 'object', properties: {} } },
  { name: 'xmpp_wait_reply', description: 'wait', inputSchema: { type: 'object', properties: {} } },
].filter((tool) => !(opts.noSend && tool.name === 'send_message'));
let waits = 0;
let sends = 0;
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

async function call(name, args) {
  log({ tool: name, args });
  if (name === 'send_message') {
    sends += 1;
    if (opts.sendFailures && sends <= opts.sendFailures) return { isError: true, content: [{ type: 'text', text: 'database is locked' }] };
    if (opts.sendError) return { isError: true, content: [{ type: 'text', text: opts.sendError }] };
    return text({ conversationId: 'c1', sentAt: new Date().toISOString() });
  }
  if (name === 'xmpp_wait_reply') {
    waits += 1;
    if (opts.dieAfterWaits && waits >= opts.dieAfterWaits && !fs.existsSync(dir + '/died')) {
      fs.writeFileSync(dir + '/died', '1');
      process.exit(3);
    }
    const deadline = Date.now() + (opts.waitMs ?? 40);
    for (;;) {
      const fresh = inbox().filter((m) => m.sentAt > args.after);
      if (fresh.length > 0) return text({ status: 'reply', messages: fresh, cursor: fresh[fresh.length - 1].sentAt });
      if (Date.now() >= deadline) return text({ status: 'timeout', cursor: args.after });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    return out({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'fake-messenger', version: '0' } } });
  }
  if (message.method === 'tools/list') return out({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') {
    const result = await call(message.params.name, message.params.arguments || {});
    return out({ jsonrpc: '2.0', id: message.id, result });
  }
  out({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
});
`;

export interface FakeMcpOptions {
  readonly noSend?: boolean;
  readonly sendError?: string;
  /** The first n sends fail with "database is locked", later ones succeed. */
  readonly sendFailures?: number;
  /** How long a wait lasts when nothing is in the inbox. Default 40 ms. */
  readonly waitMs?: number;
  /** The first server process exits (code 3) on this wait. */
  readonly dieAfterWaits?: number;
}

export interface FakeMcp {
  readonly command: AgentCommand;
  /** Every tool call the server received, oldest first. */
  calls(): { tool: string; args: Record<string, unknown> }[];
  /** A message from the peer, as curlew's `xmpp_wait_reply` shapes it. */
  deliver(sentAt: string, bodyText: string): void;
  readonly dir: string;
}

export async function withFakeMcp(
  options: FakeMcpOptions,
  run: (fake: FakeMcp) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-fake-mcp-'));
  try {
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'server.cjs');
    writeFileSync(script, SERVER);
    writeFileSync(join(dir, 'calls'), '');
    const inbox: { sentAt: string; bodyText: string; fromSelf: boolean }[] = [];
    writeFileSync(join(dir, 'inbox'), '[]');
    await run({
      dir,
      command: {
        id: 'messenger',
        title: 'fake messenger',
        program: 'node',
        args: [script],
        env: { FAKE_MCP_DIR: dir, FAKE_MCP_OPTIONS: JSON.stringify(options) },
      },
      calls: () =>
        readFileSync(join(dir, 'calls'), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown> }),
      deliver: (sentAt, bodyText) => {
        inbox.push({ sentAt, bodyText, fromSelf: false });
        writeFileSync(join(dir, 'inbox'), JSON.stringify(inbox));
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
