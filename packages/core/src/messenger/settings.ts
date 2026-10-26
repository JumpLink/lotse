/**
 * Which messenger server `listen` talks to, and as whom — the shape of `channel.messenger` in
 * settings.json. Curlew is the default, not a requirement: any MCP server that meets the contract
 * (docs/messenger-contract.md) fits, its tools named here.
 *
 * `account` and `peer` have no default (they are the person's own), and may be empty in the file so the
 * settings page can save a half-filled form; `messengerProblem` says what is still missing, and `listen`
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
  /** The server's tool that sends `{account, to, text, format}`. */
  readonly sendTool: string;
  /** The server's tool that waits for a reply `{account, peer, after, timeout_s, include_bodies, strip_quotes}`. */
  readonly waitTool: string;
  /** The server's read-only tool that describes its limits. Absent: `messaging_capabilities`. */
  readonly capabilitiesTool?: string;
  /** Requests the person starts from the chat. Absent: `REQUEST_DEFAULTS`, which is off. */
  readonly requests?: RequestSettings;
}

/** One environment variable of an MCP server, the shape ACP uses. */
export interface RequestEnvVariable {
  readonly name: string;
  readonly value: string;
}

/**
 * A stdio MCP server an ad-hoc run gets. `env` is declared like an ACP entry's, but a secret-looking
 * name is refused: settings.json holds no credential.
 */
export interface RequestMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: readonly RequestEnvVariable[];
}

/**
 * A message from the peer that answers no question starts an agent run (`requests.ts`). The run is
 * not a task: it borrows one of the profiles for the agent, the model and the user.
 */
export interface RequestSettings {
  readonly enabled: boolean;
  /** A message starting with this is always a new request, never an answer. */
  readonly prefix: string;
  /** A profile id of profiles.json. */
  readonly profile: string;
  /** Put in front of the person's first message of a session. */
  readonly preamble: string;
  /** The session's working directory. Empty: the home directory. */
  readonly cwd: string;
  readonly mcpServers: readonly RequestMcpServer[];
  /** `read` declines every permission request without asking; `confirm` asks in the chat. */
  readonly rights: 'read' | 'confirm';
  /** How long after an answer a plain message continues that session. 0: never. */
  readonly followUpMinutes: number;
  /** Runs at the same time; more requests wait in a queue. */
  readonly maxConcurrent: number;
  /** Minutes `person_needed` waits for the person when neither the call nor the task says. */
  readonly personNeededMinutes: number;
}

export const REQUEST_DEFAULTS: RequestSettings = {
  enabled: false,
  prefix: '/ask',
  profile: '',
  preamble: '',
  cwd: '',
  mcpServers: [],
  rights: 'read',
  followUpMinutes: 30,
  maxConcurrent: 1,
  personNeededMinutes: 30,
};

export const MESSENGER_DEFAULTS: MessengerSettings = {
  command: 'curlew',
  args: ['mcp'],
  account: '',
  peer: '',
  sendTool: 'send_message',
  waitTool: 'xmpp_wait_reply',
};

export function requestSettings(settings: MessengerSettings): RequestSettings {
  return settings.requests ?? REQUEST_DEFAULTS;
}

/** What keeps enabled requests from running, or `null` (also when they are off). */
export function requestProblem(settings: RequestSettings, profiles: readonly string[]): string | null {
  if (!settings.enabled) return null;
  if (settings.profile.trim() === '') return 'channel.messenger.requests needs a profile';
  if (!profiles.includes(settings.profile))
    return `channel.messenger.requests names profile "${settings.profile}", which profiles.json does not define`;
  if (settings.prefix.trim() === '') return 'channel.messenger.requests needs a prefix';
  return null;
}

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
