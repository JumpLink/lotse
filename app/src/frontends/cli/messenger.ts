/**
 * `lotse messenger` — the chat requests of `serve`, shown and set.
 *
 * The same file the settings page writes: every flag changes one key of `channel.messenger.requests`
 * and keeps the rest, so the CLI and the GUI never reset each other. Without a flag it only reports.
 */

import type { CommandModule } from 'yargs';

import { messengerProblem, requestSettings, type LotsePaths, type RequestSettings } from '@lotse/core';
import {
  formatServerSpecs,
  messengerSettings,
  parseServerSpecs,
  readSettings,
  saveSettings,
  withRequests,
  type Settings,
} from '../../core/settings.ts';

import { err, out, pickArgv } from './output.ts';

/** The flags as yargs hands them over; every one optional. */
export interface RequestFlags {
  readonly requests?: string;
  readonly profile?: string;
  readonly prefix?: string;
  readonly preamble?: string;
  readonly cwd?: string;
  readonly rights?: string;
  readonly mcpServers?: string;
  readonly followUpMinutes?: number;
  readonly maxConcurrent?: number;
}

/** `current` with the given flags applied, or what is wrong with one. Pure. */
export function applyRequestFlags(
  current: RequestSettings,
  flags: RequestFlags,
): RequestSettings | { readonly problem: string } {
  let next: RequestSettings = { ...current };
  if (flags.requests !== undefined) {
    if (flags.requests !== 'on' && flags.requests !== 'off') return { problem: '--requests takes on or off' };
    next = { ...next, enabled: flags.requests === 'on' };
  }
  for (const key of ['profile', 'preamble', 'cwd'] as const) {
    const value = flags[key];
    if (value !== undefined) next = { ...next, [key]: value };
  }
  if (flags.prefix !== undefined) {
    if (flags.prefix.trim() === '') return { problem: '--request-prefix must not be empty' };
    next = { ...next, prefix: flags.prefix.trim() };
  }
  if (flags.rights !== undefined) {
    if (flags.rights !== 'read' && flags.rights !== 'confirm')
      return { problem: '--request-rights takes read or confirm' };
    next = { ...next, rights: flags.rights };
  }
  if (flags.mcpServers !== undefined) {
    const servers = parseServerSpecs(flags.mcpServers);
    if ('problem' in servers) return { problem: `--request-mcp-server: ${servers.problem}` };
    next = { ...next, mcpServers: servers };
  }
  if (flags.followUpMinutes !== undefined) {
    const minutes = flags.followUpMinutes;
    if (!Number.isInteger(minutes) || minutes < 0)
      return { problem: '--follow-up-minutes takes a whole number, 0 or more' };
    next = { ...next, followUpMinutes: minutes };
  }
  if (flags.maxConcurrent !== undefined) {
    const count = flags.maxConcurrent;
    if (!Number.isInteger(count) || count < 1)
      return { problem: '--max-concurrent takes a whole number, 1 or more' };
    next = { ...next, maxConcurrent: count };
  }
  return next;
}

/** What the file says about the messenger and its requests, as text. Pure. */
export function messengerReport(file: string, settings: Settings, problem: string | null): string[] {
  const messenger = messengerSettings(settings);
  const requests = requestSettings(messenger);
  const lines = [
    `messenger: ${messenger.peer || '(no peer)'} via ${messenger.command} ${messenger.args.join(' ')}`.trimEnd(),
    `requests:  ${requests.enabled ? 'on' : 'off'}`,
    `  prefix            ${requests.prefix}`,
    `  profile           ${requests.profile || '(none)'}`,
    `  preamble          ${requests.preamble || '(none)'}`,
    `  cwd               ${requests.cwd || '(home directory)'}`,
    `  rights            ${requests.rights}`,
    `  mcp servers       ${requests.mcpServers.length > 0 ? formatServerSpecs(requests.mcpServers) : 'none'}`,
    `  follow-up minutes ${requests.followUpMinutes}`,
    `  max concurrent    ${requests.maxConcurrent}`,
    `settings file: ${file}`,
  ];
  const missing = messengerProblem(messenger);
  if (missing) lines.push(`messenger problem: ${missing}`);
  if (problem) lines.push(`settings problem: ${problem}`);
  return lines;
}

const command = (paths: LotsePaths): CommandModule => ({
  command: 'messenger',
  describe: 'show or set the requests serve takes from the chat',
  builder: (yargs) =>
    yargs
      .option('requests', { type: 'string', describe: 'start an agent run for a chat message: on or off' })
      .option('request-profile', { type: 'string', describe: 'the tasks.json profile a request runs with' })
      .option('request-prefix', {
        type: 'string',
        describe: 'a message starting with this is always a request',
      })
      .option('request-preamble', {
        type: 'string',
        describe: 'text put before the first message of a session',
      })
      .option('request-cwd', { type: 'string', describe: 'working directory of a request; empty: home' })
      .option('request-rights', {
        type: 'string',
        describe: 'read: decline every permission request; confirm: ask in the chat',
      })
      .option('request-mcp-server', {
        type: 'string',
        describe: 'MCP servers for a request: name=command arg …; separated by ";", or none',
      })
      .option('follow-up-minutes', {
        type: 'number',
        describe: 'how long after an answer a message continues that session; 0: never',
      })
      .option('max-concurrent', { type: 'number', describe: 'requests running at the same time' })
      .strict(),
  handler: (argv) => {
    const file = paths.settingsFile;
    const raw = argv as Record<string, unknown>;
    const flags: RequestFlags = {
      requests: pickArgv<string>(raw, 'requests'),
      profile: pickArgv<string>(raw, 'requestProfile', 'request-profile'),
      prefix: pickArgv<string>(raw, 'requestPrefix', 'request-prefix'),
      preamble: pickArgv<string>(raw, 'requestPreamble', 'request-preamble'),
      cwd: pickArgv<string>(raw, 'requestCwd', 'request-cwd'),
      rights: pickArgv<string>(raw, 'requestRights', 'request-rights'),
      mcpServers: pickArgv<string>(raw, 'requestMcpServer', 'request-mcp-server'),
      followUpMinutes: pickArgv<number>(raw, 'followUpMinutes', 'follow-up-minutes'),
      maxConcurrent: pickArgv<number>(raw, 'maxConcurrent', 'max-concurrent'),
    };
    if (Object.values(flags).some((value) => value !== undefined)) {
      const current = readSettings(file).settings;
      const next = applyRequestFlags(requestSettings(messengerSettings(current)), flags);
      if ('problem' in next) {
        err(next.problem);
        process.exitCode = 1;
        return;
      }
      try {
        const { backup } = saveSettings(file, withRequests(current, next));
        if (backup) err(`the earlier settings file was moved to ${backup}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        err(
          code ? `could not write ${file}: ${code}` : error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
        return;
      }
    }
    const { settings, problem } = readSettings(file);
    for (const line of messengerReport(file, settings, problem)) out(line);
  },
});

export const messengerCommand = command;
