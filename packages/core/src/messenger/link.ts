/**
 * One MCP connection that outlives the process behind it.
 *
 * `acquire` starts the server on first use and again after it died; `use` runs a call on it and, when
 * the connection (not the tool) failed, starts a fresh one and tries once more. Sending and the receive
 * loop share one link, so there is one `curlew mcp` process, not two.
 */

import { McpToolError, type McpTools } from './mcp-client.ts';

export class McpLink {
  #current: McpTools | null = null;
  #connecting: Promise<McpTools> | null = null;
  #closed = false;

  constructor(private readonly connect: () => Promise<McpTools>) {}

  async acquire(): Promise<McpTools> {
    if (this.#closed) throw new Error('the messenger link is closed');
    if (this.#current) return this.#current;
    this.#connecting ??= this.connect()
      .then((tools) => {
        this.#current = tools;
        void tools.closed.then(() => {
          if (this.#current === tools) this.#current = null;
        });
        return tools;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  /** Forget the current connection (it is broken or stuck) and end its process. */
  async drop(): Promise<void> {
    const tools = this.#current;
    this.#current = null;
    await tools?.close().catch(() => {});
  }

  /** `run` on the link; a dead connection is replaced once. A tool's own error is not retried. */
  async use<T>(run: (tools: McpTools) => Promise<T>): Promise<T> {
    try {
      return await run(await this.acquire());
    } catch (error) {
      if (error instanceof McpToolError || this.#closed) throw error;
      await this.drop();
      return run(await this.acquire());
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.drop();
  }
}
