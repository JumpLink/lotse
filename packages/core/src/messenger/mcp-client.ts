/**
 * A small MCP client: spawn one stdio server, call its tools, learn when it dies.
 *
 * Generic on purpose — it knows no messenger. `MessengerChannel` and the receive loop talk to the
 * `McpTools` interface, and a test hands them a fake; only `connectMcp` touches the SDK and a process.
 *
 * **The process side is `StdioChannel`, not the SDK's `StdioClientTransport`.** The SDK's transport
 * spawns through `cross-spawn`, which knows nothing of the Flatpak sandbox: a curlew on the host is
 * reached through `flatpak-spawn --host` (`toHostCommand`), and that rewrite lives in `StdioChannel`
 * together with the process-group kill and the stdout/stderr end gate. So the SDK supplies the
 * protocol (`Client`) and lotse supplies the pipe, through the SDK's `Transport` seam.
 *
 * MCP's stdio framing is one JSON message per line, the same as ACP's, which is why `StdioChannel`
 * carries it unchanged.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { RawChannel } from '@lotse/acp/transport';

import { StdioChannel, type AgentCommand } from '../agents/stdio.ts';

export interface McpCallOptions {
  /** How long to wait for the tool's answer. The SDK default (60 s) is too short for a long-poll. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The part of an MCP server the messenger needs: call a tool, and know when the server is gone. */
export interface McpTools {
  /**
   * The tool's result as a value: `structuredContent` if the server sent one, else the first text
   * block parsed as JSON, else that text. A tool error (`isError`) throws `McpToolError`.
   */
  call(tool: string, args: Readonly<Record<string, unknown>>, options?: McpCallOptions): Promise<unknown>;
  /** The tools the server lists — used to say "this server has no send_message" instead of failing later. */
  listTools(): Promise<readonly string[]>;
  /** Settles when the connection ends, for whatever reason. Never rejects. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** The server answered, but with a tool error. The connection is fine. */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
    this.name = 'McpToolError';
  }
}

/** A newline-framed `RawChannel` as the SDK's `Transport`. */
class ChannelTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #buffer = '';
  #ended = false;

  constructor(private readonly channel: RawChannel) {
    channel.onData((chunk) => this.#read(chunk));
    channel.onEnd((reason) => {
      if (reason) this.onerror?.(reason);
      this.#end();
    });
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.channel.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.channel.terminate();
    this.#end();
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.onclose?.();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === '') continue;
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

export interface ConnectOptions {
  /** One line of the server's stderr — its log. Delivered, never interpreted. */
  readonly onStderr?: (line: string) => void;
  /** How long the handshake may take. */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

/** What a tool result means as a value (see `McpTools.call`). */
export function resultValue(tool: string, result: ToolResult): unknown {
  const text = result.content?.find((block) => block.type === 'text')?.text;
  if (result.isError) throw new McpToolError(tool, text ?? 'the tool reported an error');
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Start `command` and complete the MCP handshake. Rejects with the reason when it cannot. */
export async function connectMcp(command: AgentCommand, options: ConnectOptions = {}): Promise<McpTools> {
  const channel = new StdioChannel({
    command,
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
  });
  const transport = new ChannelTransport(channel);
  const client = new Client({ name: 'lotse', version: '0.3.0' });
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  client.onclose = () => markClosed();
  let failure: Error | undefined;
  transport.onerror = (error) => {
    failure = error;
  };

  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    channel.terminate();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${command.program} did not start as an MCP server: ${failure?.message ?? reason}`);
  }

  return {
    closed,
    async call(tool, args, callOptions = {}) {
      const result = (await client.callTool({ name: tool, arguments: { ...args } }, undefined, {
        ...(callOptions.timeoutMs !== undefined ? { timeout: callOptions.timeoutMs } : {}),
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      })) as ToolResult;
      return resultValue(tool, result);
    },
    async listTools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name);
    },
    async close() {
      await client.close().catch(() => {});
      channel.terminate();
      markClosed();
    },
  };
}
