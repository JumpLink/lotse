/**
 * Which messenger server `serve` talks to, and as whom — the shape of `channel.messenger` in
 * settings.json. Curlew is the default, not a requirement: any MCP server with a "send a text to a peer"
 * tool and a "wait for a reply after a cursor" tool fits, named here.
 *
 * `account` and `peer` have no default (they are the person's own), and may be empty in the file so the
 * settings page can save a half-filled form; `messengerProblem` says what is still missing, and `serve`
 * then runs without the messenger and says why.
 */

import type { AgentCommand } from '../agents/stdio.ts';

export type ChannelName = 'desktop' | 'messenger';

export const CHANNEL_NAMES: readonly ChannelName[] = ['desktop', 'messenger'];

export interface MessengerSettings {
  /** The MCP server's program, resolved on PATH. */
  readonly command: string;
  /** Its arguments. No secret belongs here: settings.json holds none. */
  readonly args: readonly string[];
  /** The messenger account to send from (curlew: an account id). */
  readonly account: string;
  /** Who to talk to (curlew: an address). */
  readonly peer: string;
  /** The server's tool that sends `{account, to, text}`. */
  readonly sendTool: string;
  /** The server's tool that waits for a reply `{account, peer, after, timeout_s, include_bodies}`. */
  readonly waitTool: string;
}

export const MESSENGER_DEFAULTS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: '',
  peer: '',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

/** What is still missing for the messenger to run, or `null`. */
export function messengerProblem(settings: MessengerSettings): string | null {
  const missing = (['command', 'account', 'peer', 'sendTool', 'waitTool'] as const).filter(
    (key) => settings[key].trim() === '',
  );
  return missing.length === 0 ? null : `channel.messenger needs ${missing.join(', ')}`;
}

/** The server as a process to start. */
export function messengerCommand(settings: MessengerSettings): AgentCommand {
  return {
    id: 'messenger',
    title: 'messenger MCP server',
    program: settings.command,
    args: [...settings.args],
  };
}
