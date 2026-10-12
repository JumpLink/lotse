/**
 * The MCP endpoint a run's agent calls `person_needed` on: HTTP on 127.0.0.1, one random path per run.
 *
 * It lives inside `serve` on purpose. The code the person sends is handed to the waiting call in this
 * process's memory (`person.ts`); a second process, or a file between the two, would be somewhere a
 * code could be left behind. It speaks the small part of MCP a tool server needs — `initialize`,
 * `ping`, `tools/list`, `tools/call` — answering each POST with plain JSON, which streamable HTTP
 * allows, so no SDK server class and no SSE stream have to run under GJS.
 *
 * The server starts with the first run that attaches and closes with the last one.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  PERSON_KINDS,
  type PersonHandler,
  type PersonHost,
  type PersonNeededInput,
  type PersonKind,
} from './person.ts';

export const PERSON_TOOL = 'person_needed';

const TOOL = {
  name: PERSON_TOOL,
  description:
    'Tell the person that only they can continue (a login, a code, an approval, a device step) and wait for their reply. Returns {outcome: "done" | "code" | "timeout" | "declined", code?}. "done": they did it themselves. "code": they sent the code, enter it yourself. "timeout": no reply in time — stop and report what is still open; do not call again. "declined": they said no.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...PERSON_KINDS], description: 'What the site wants from the person.' },
      origin: { type: 'string', description: 'The site or service that asks, for example its host name.' },
      prompt: { type: 'string', description: 'One sentence: what the person has to do.' },
      acceptsCode: {
        type: 'boolean',
        description: 'The person may reply with the code (4-10 letters or digits) instead of doing it themselves.',
      },
      timeoutMin: { type: 'integer', minimum: 1, description: 'Minutes to wait. Omit for the default.' },
    },
    required: ['kind', 'origin', 'prompt'],
    additionalProperties: false,
  },
};

function parseInput(value: unknown): PersonNeededInput | string {
  if (typeof value !== 'object' || value === null) return 'arguments must be an object';
  const args = value as Record<string, unknown>;
  const kind = args['kind'];
  if (!PERSON_KINDS.includes(kind as PersonKind)) return `kind must be one of ${PERSON_KINDS.join(', ')}`;
  const { origin, prompt, acceptsCode, timeoutMin } = args;
  if (typeof origin !== 'string' || origin.trim() === '') return 'origin must be a non-empty string';
  if (typeof prompt !== 'string') return 'prompt must be a string';
  if (acceptsCode !== undefined && typeof acceptsCode !== 'boolean') return 'acceptsCode must be true or false';
  if (timeoutMin !== undefined && (typeof timeoutMin !== 'number' || !Number.isInteger(timeoutMin) || timeoutMin < 1))
    return 'timeoutMin must be a whole number of minutes, 1 or more';
  return {
    kind: kind as PersonKind,
    origin: origin.trim(),
    prompt,
    acceptsCode: acceptsCode === true,
    ...(typeof timeoutMin === 'number' ? { timeoutMin } : {}),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function rpc(message: Record<string, unknown>, handler: PersonHandler): Promise<unknown> {
  const id = message['id'];
  const params = (message['params'] ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (message['method']) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'lotse-person', version: '1' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [TOOL] });
    case 'tools/call': {
      if (params['name'] !== PERSON_TOOL) return fail(-32602, `unknown tool "${String(params['name'])}"`);
      const input = parseInput(params['arguments']);
      const failure = (text: string) => ok({ isError: true, content: [{ type: 'text', text }] });
      if (typeof input === 'string') return failure(input);
      try {
        const outcome = await handler(input);
        return ok({ content: [{ type: 'text', text: JSON.stringify(outcome) }] });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    }
    default:
      return fail(-32601, `method not found: ${String(message['method'])}`);
  }
}

export function createPersonHost(): PersonHost {
  const routes = new Map<string, PersonHandler>();
  let server: Server | null = null;
  let starting: Promise<number> | null = null;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const token = (request.url ?? '').split('?')[0]!.replace(/^\/person\//, '');
    const handler = routes.get(token);
    if (!handler) return send(response, 404);
    if (request.method !== 'POST') return send(response, 405);
    let message: unknown;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      return send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message))
      return send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one request per POST' } });
    const record = message as Record<string, unknown>;
    if (record['id'] === undefined) return send(response, 202);
    send(response, 200, await rpc(record, handler));
  };

  const start = (): Promise<number> => {
    starting ??= new Promise<number>((resolve, reject) => {
      const created = createServer((request, response) => {
        handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      created.once('error', reject);
      created.listen(0, '127.0.0.1', () => {
        server = created;
        const address = created.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    return starting;
  };

  return {
    async attach(handler) {
      const port = await start();
      const token = randomBytes(24).toString('hex');
      routes.set(token, handler);
      return {
        server: { type: 'http', name: 'lotse-person', url: `http://127.0.0.1:${port}/person/${token}`, headers: [] },
        detach: () => {
          routes.delete(token);
          if (routes.size > 0) return;
          server?.close();
          server = null;
          starting = null;
        },
      };
    },
  };
}
