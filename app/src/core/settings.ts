/**
 * What a person chose, kept between runs: which agent to start, and how `lotse serve` puts a question
 * on the desktop (`channel.desktop.mode`).
 *
 * **No secret can live here, by construction.** `parseSettings` is an allowlist — `version`, `agent`
 * (an `id` and a `source`) and `channel.desktop.mode` — so a `token`, `apiKey` or `password` is rejected as an
 * unknown field (and named as secret-looking, so the message says why). lotse stores no credential
 * (AGENTS.md § Privacy); a setting is a preference, and the file is `derived`: choosing again
 * recreates it.
 *
 * **A bad file never stops startup.** `readSettings` returns the defaults plus a `problem` the caller
 * reports; only a write that fails throws, because that one is a person's explicit action.
 *
 * **A file lotse could not read is never destroyed by a save.** `readSettings` also says what kind of
 * problem it was, and `saveDecision` turns that into one of three answers: write, move the old file to
 * `settings.json.bak` first, or refuse (a newer lotse wrote it, or it could not be read at all — in both
 * cases lotse does not know what is in it). `saveSettings` is the one writer that applies it.
 *
 * `AgentChoice` names a launcher id *and* a source, so "the bundled opencode" and "my opencode" are two
 * different choices: they keep separate logins and histories (`core/agents/isolation.ts`). The choice
 * itself, and `describeChoice`, are in `@lotse/core` with the resolution that reads them; this file is
 * only the file it is kept in.
 */

import { chmodSync, readFileSync, renameSync } from 'node:fs';

import {
  CHANNEL_NAMES,
  MESSENGER_DEFAULTS,
  REQUEST_DEFAULTS,
  type AgentChoice,
  type ChannelName,
  type MessengerSettings,
  type RequestEnvVariable,
  type RequestMcpServer,
  type RequestSettings,
} from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

/**
 * How the desktop channel asks: `notification` (a notification whose buttons answer or open the dialog)
 * or `dialog` (the answer window opens as soon as a question arrives). `serve` reads it per question, so
 * a change needs no restart.
 */
export type DesktopMode = 'notification' | 'dialog';

export const DESKTOP_MODES: readonly DesktopMode[] = ['notification', 'dialog'];

export const DEFAULT_DESKTOP_MODE: DesktopMode = 'notification';

export interface ChannelSettings {
  readonly desktop: { readonly mode: DesktopMode };
  /** Which channels `serve` asks on. Absent: the desktop only. Read at start, so a change needs a restart. */
  readonly active?: readonly ChannelName[];
  /** The messenger's MCP server, account and peer. Absent: its defaults (curlew) with no account. */
  readonly messenger?: MessengerSettings;
}

export const DEFAULT_ACTIVE_CHANNELS: readonly ChannelName[] = ['desktop'];

export interface Settings {
  readonly version: 1;
  readonly agent: AgentChoice | null;
  /** Absent: every channel on its default. */
  readonly channel?: ChannelSettings;
}

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = { version: SETTINGS_VERSION, agent: null };

/**
 * What was wrong with a settings file. `newer-version`: a higher `version` number, so a newer lotse wrote
 * it. `unreadable`: the file exists and could not be read. `invalid`: anything else — bad JSON, an unknown
 * or secret-looking key, a malformed choice, a version that is not a number above this one.
 */
export type SettingsProblemKind = 'newer-version' | 'invalid' | 'unreadable';

export type ParsedSettings =
  | { readonly settings: Settings }
  | { readonly problem: string; readonly kind: SettingsProblemKind };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_LOOKING = /token|secret|password|passwd|credential|auth|api[-_]?key|key/i;

function unknownField(path: string, key: string): string {
  return SECRET_LOOKING.test(key)
    ? `unknown field "${path}${key}" — settings hold no credential, so a secret-looking field is never accepted`
    : `unknown field "${path}${key}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The settings in a file's text. Pure: a clear `problem` for anything this version does not know —
 * invalid JSON, an unknown version, an unknown field — never a throw.
 */
export function parseSettings(raw: string): ParsedSettings {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      problem: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      kind: 'invalid',
    };
  }
  if (!isRecord(value)) return { problem: 'not a settings object', kind: 'invalid' };
  // A newer lotse may also have added keys, so the kind is decided by the version alone; the message
  // still names whichever problem comes first.
  const version = value['version'];
  const kind: SettingsProblemKind =
    typeof version === 'number' && version > SETTINGS_VERSION ? 'newer-version' : 'invalid';
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'agent' && key !== 'channel')
      return { problem: unknownField('', key), kind };
  }
  if (version !== SETTINGS_VERSION) {
    return {
      problem: `settings version ${JSON.stringify(version)} is not known (this lotse reads version ${SETTINGS_VERSION})`,
      kind,
    };
  }
  const channel = parseChannel(value['channel']);
  if (typeof channel === 'string') return { problem: channel, kind };
  const withChannel = (agent: AgentChoice | null): ParsedSettings => ({
    settings: { version: SETTINGS_VERSION, agent, ...(channel ? { channel } : {}) },
  });
  const agent = value['agent'];
  if (agent === undefined || agent === null) return withChannel(null);
  if (!isRecord(agent)) {
    return { problem: '"agent" must be an object with an id and a source, or null', kind };
  }
  for (const key of Object.keys(agent)) {
    if (key !== 'id' && key !== 'source') return { problem: unknownField('agent.', key), kind };
  }
  const { id, source } = agent;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { problem: '"agent.id" must be a launcher id such as "opencode"', kind };
  }
  if (source !== 'host' && source !== 'bundled') {
    return { problem: '"agent.source" must be "host" or "bundled"', kind };
  }
  return withChannel({ id, source });
}

const MESSENGER_KEYS = [
  'command',
  'args',
  'account',
  'peer',
  'sendTool',
  'waitTool',
  'capabilitiesTool',
  'requests',
] as const;

const REQUEST_KEYS = [
  'enabled',
  'prefix',
  'profile',
  'preamble',
  'cwd',
  'mcpServers',
  'rights',
  'followUpMinutes',
  'maxConcurrent',
  'personNeededMinutes',
] as const;

const REQUEST_SERVER_KEYS = ['name', 'command', 'args', 'env'] as const;

function parseRequestServer(value: unknown, index: number): RequestMcpServer | string {
  const path = `channel.messenger.requests.mcpServers[${index}]`;
  if (!isRecord(value)) return `"${path}" must be an object with a name, a command and args`;
  for (const key of Object.keys(value)) {
    if (!(REQUEST_SERVER_KEYS as readonly string[]).includes(key)) return unknownField(`${path}.`, key);
  }
  const { name, command } = value;
  const args = value['args'] ?? [];
  if (typeof name !== 'string' || name.trim() === '') return `"${path}.name" must be a non-empty string`;
  if (typeof command !== 'string' || command.trim() === '')
    return `"${path}.command" must be a non-empty string`;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
    return `"${path}.args" must be a list of strings`;
  const env = parseEnv(value['env'], `${path}.env`);
  if (typeof env === 'string') return env;
  return { name, command, args: args as string[], ...(env.length > 0 ? { env } : {}) };
}

/** `env` as tasks.json declares it, a list of `{name, value}`; a secret-looking name is refused. */
function parseEnv(value: unknown, path: string): RequestEnvVariable[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `"${path}" must be a list of {name, value}`;
  const env: RequestEnvVariable[] = [];
  for (const [index, item] of value.entries()) {
    const where = `${path}[${index}]`;
    if (!isRecord(item)) return `"${where}" must be an object with a name and a value`;
    for (const key of Object.keys(item)) {
      if (key !== 'name' && key !== 'value') return unknownField(`${where}.`, key);
    }
    const { name, value: text } = item;
    if (typeof name !== 'string' || !ENV_NAME.test(name)) return `"${where}.name" must be a variable name`;
    if (typeof text !== 'string') return `"${where}.value" must be a string`;
    if (SECRET_LOOKING.test(name))
      return `"${where}.name" looks like a credential — settings hold none, so it is never accepted`;
    env.push({ name, value: text });
  }
  return env;
}

/** `channel.messenger.requests`: every key optional, the rest from `REQUEST_DEFAULTS`. */
function parseRequests(value: unknown): RequestSettings | string {
  const path = 'channel.messenger.requests';
  if (!isRecord(value)) return `"${path}" must be an object`;
  for (const key of Object.keys(value)) {
    if (!(REQUEST_KEYS as readonly string[]).includes(key)) return unknownField(`${path}.`, key);
  }
  const pick = <K extends keyof RequestSettings>(key: K): unknown => value[key] ?? REQUEST_DEFAULTS[key];
  const enabled = pick('enabled');
  if (typeof enabled !== 'boolean') return `"${path}.enabled" must be true or false`;
  const text: Record<string, string> = {};
  for (const key of ['prefix', 'profile', 'preamble', 'cwd'] as const) {
    const field = pick(key);
    if (typeof field !== 'string') return `"${path}.${key}" must be a string`;
    text[key] = field;
  }
  const rights = pick('rights');
  if (rights !== 'read' && rights !== 'confirm') return `"${path}.rights" must be "read" or "confirm"`;
  const followUpMinutes = pick('followUpMinutes');
  if (typeof followUpMinutes !== 'number' || !Number.isInteger(followUpMinutes) || followUpMinutes < 0)
    return `"${path}.followUpMinutes" must be a whole number of minutes, 0 or more`;
  const maxConcurrent = pick('maxConcurrent');
  if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    return `"${path}.maxConcurrent" must be a whole number, 1 or more`;
  const personNeededMinutes = pick('personNeededMinutes');
  if (
    typeof personNeededMinutes !== 'number' ||
    !Number.isInteger(personNeededMinutes) ||
    personNeededMinutes < 1
  )
    return `"${path}.personNeededMinutes" must be a whole number of minutes, 1 or more`;
  const rawServers = pick('mcpServers');
  if (!Array.isArray(rawServers)) return `"${path}.mcpServers" must be a list`;
  const mcpServers: RequestMcpServer[] = [];
  for (const [index, raw] of rawServers.entries()) {
    const server = parseRequestServer(raw, index);
    if (typeof server === 'string') return server;
    mcpServers.push(server);
  }
  return {
    enabled,
    prefix: text['prefix']!,
    profile: text['profile']!,
    preamble: text['preamble']!,
    cwd: text['cwd']!,
    mcpServers,
    rights,
    followUpMinutes,
    maxConcurrent,
    personNeededMinutes,
  };
}

function parseMessenger(value: unknown): MessengerSettings | string {
  if (!isRecord(value)) return '"channel.messenger" must be an object';
  for (const key of Object.keys(value)) {
    if (!(MESSENGER_KEYS as readonly string[]).includes(key)) return unknownField('channel.messenger.', key);
  }
  let requests: RequestSettings | undefined;
  if (value['requests'] !== undefined && value['requests'] !== null) {
    const parsed = parseRequests(value['requests']);
    if (typeof parsed === 'string') return parsed;
    requests = parsed;
  }
  const text = (key: 'command' | 'account' | 'peer' | 'sendTool' | 'waitTool'): string | null => {
    const field = value[key];
    if (field === undefined) return MESSENGER_DEFAULTS[key];
    return typeof field === 'string' ? field : null;
  };
  const out: Record<string, string> = {};
  for (const key of ['command', 'account', 'peer', 'sendTool', 'waitTool'] as const) {
    const field = text(key);
    if (field === null) return `"channel.messenger.${key}" must be a string`;
    out[key] = field;
  }
  const capabilitiesTool = value['capabilitiesTool'];
  if (capabilitiesTool !== undefined && typeof capabilitiesTool !== 'string') {
    return '"channel.messenger.capabilitiesTool" must be a string';
  }
  const args = value['args'] === undefined ? MESSENGER_DEFAULTS.args : value['args'];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return '"channel.messenger.args" must be a list of strings';
  }
  return {
    ...(out as unknown as MessengerSettings),
    args: args as string[],
    ...(typeof capabilitiesTool === 'string' && capabilitiesTool.trim() !== '' ? { capabilitiesTool } : {}),
    ...(requests ? { requests } : {}),
  };
}

/**
 * `channel` as it may appear in the file: absent, or an object with any of `desktop: {mode}`, `active`
 * and `messenger`. A string is the problem.
 */
function parseChannel(channel: unknown): ChannelSettings | null | string {
  if (channel === undefined || channel === null) return null;
  if (!isRecord(channel)) return '"channel" must be an object';
  for (const key of Object.keys(channel)) {
    if (key !== 'desktop' && key !== 'active' && key !== 'messenger') return unknownField('channel.', key);
  }
  let mode: DesktopMode | undefined;
  const desktop = channel['desktop'];
  if (desktop !== undefined && desktop !== null) {
    if (!isRecord(desktop)) return '"channel.desktop" must be an object';
    for (const key of Object.keys(desktop)) {
      if (key !== 'mode') return unknownField('channel.desktop.', key);
    }
    const value = desktop['mode'];
    if (value !== undefined) {
      if (!DESKTOP_MODES.includes(value as DesktopMode)) {
        return `"channel.desktop.mode" must be one of ${DESKTOP_MODES.map((m) => `"${m}"`).join(', ')}`;
      }
      mode = value as DesktopMode;
    }
  }
  let active: ChannelName[] | undefined;
  const rawActive = channel['active'];
  if (rawActive !== undefined && rawActive !== null) {
    const valid =
      Array.isArray(rawActive) && rawActive.every((name) => CHANNEL_NAMES.includes(name as ChannelName));
    if (!valid) {
      return `"channel.active" must be a list of ${CHANNEL_NAMES.map((n) => `"${n}"`).join(', ')}`;
    }
    active = [...new Set(rawActive as ChannelName[])];
  }
  let messenger: MessengerSettings | undefined;
  const rawMessenger = channel['messenger'];
  if (rawMessenger !== undefined && rawMessenger !== null) {
    const parsed = parseMessenger(rawMessenger);
    if (typeof parsed === 'string') return parsed;
    messenger = parsed;
  }
  if (mode === undefined && active === undefined && messenger === undefined) return null;
  return {
    desktop: { mode: mode ?? DEFAULT_DESKTOP_MODE },
    ...(active ? { active } : {}),
    ...(messenger ? { messenger } : {}),
  };
}

/** The desktop mode a settings value means: its own, else the default. */
export function desktopMode(settings: Settings): DesktopMode {
  return settings.channel?.desktop.mode ?? DEFAULT_DESKTOP_MODE;
}

/**
 * `settings` with one part replaced and everything else kept — what both writers (the agent choice and the
 * desktop mode) save, so choosing one never resets the other.
 */
export function withAgent(settings: Settings, agent: AgentChoice | null): Settings {
  return { ...settings, agent };
}

export function withDesktopMode(settings: Settings, mode: DesktopMode): Settings {
  return { ...settings, channel: { ...settings.channel, desktop: { mode } } };
}

/** The channels `serve` asks on: the settings' own list, else the desktop alone. */
export function activeChannels(settings: Settings): readonly ChannelName[] {
  return settings.channel?.active ?? DEFAULT_ACTIVE_CHANNELS;
}

/** The messenger settings a value means: its own, else the defaults. */
export function messengerSettings(settings: Settings): MessengerSettings {
  return settings.channel?.messenger ?? MESSENGER_DEFAULTS;
}

/** Which channels are active and how the messenger is set up — what the settings page saves together. */
export function withMessenger(
  settings: Settings,
  active: readonly ChannelName[],
  messenger: MessengerSettings,
): Settings {
  const desktop = settings.channel?.desktop ?? { mode: DEFAULT_DESKTOP_MODE };
  return { ...settings, channel: { desktop, active: [...new Set(active)], messenger } };
}

/**
 * `name=command arg …`, several separated by `;` — how the CLI and the settings page write a request's
 * MCP servers. Empty text or `none`: no servers. Arguments split on whitespace; one with a space in it
 * belongs in settings.json directly.
 */
export function parseServerSpecs(text: string): RequestMcpServer[] | { readonly problem: string } {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === 'none') return [];
  const servers: RequestMcpServer[] = [];
  for (const spec of trimmed.split(';')) {
    if (spec.trim() === '') continue;
    const match = /^\s*([^=\s]+)\s*=\s*(\S+)(.*)$/.exec(spec);
    if (!match) return { problem: `"${spec.trim()}" is not name=command [args]` };
    servers.push({
      name: match[1]!,
      command: match[2]!,
      args: match[3]!.trim().split(/\s+/).filter(Boolean),
    });
  }
  return servers;
}

/**
 * `server:NAME=value`, several separated by `;` — the environment of the request's MCP servers, written
 * beside `parseServerSpecs` because a value may hold spaces. Empty text or `none`: no variables.
 */
export function parseEnvSpecs(
  text: string,
): ReadonlyMap<string, RequestEnvVariable[]> | { readonly problem: string } {
  const trimmed = text.trim();
  const byServer = new Map<string, RequestEnvVariable[]>();
  if (trimmed === '' || trimmed === 'none') return byServer;
  for (const spec of trimmed.split(';')) {
    if (spec.trim() === '') continue;
    const match = /^\s*([^:=\s]+)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(spec);
    if (!match) return { problem: `"${spec.trim()}" is not server:NAME=value` };
    if (SECRET_LOOKING.test(match[2]!))
      return { problem: `${match[2]} looks like a credential — settings hold none` };
    byServer.set(match[1]!, [
      ...(byServer.get(match[1]!) ?? []),
      { name: match[2]!, value: match[3]!.trim() },
    ]);
  }
  return byServer;
}

/** `servers` with the environment replaced from `byServer`; a name no server has is a problem. */
export function withServerEnv(
  servers: readonly RequestMcpServer[],
  byServer: ReadonlyMap<string, RequestEnvVariable[]>,
): RequestMcpServer[] | { readonly problem: string } {
  for (const name of byServer.keys()) {
    if (!servers.some((server) => server.name === name)) return { problem: `no MCP server named "${name}"` };
  }
  return servers.map(({ env: _old, ...server }) => {
    const env = byServer.get(server.name) ?? [];
    return env.length > 0 ? { ...server, env } : server;
  });
}

/** Freshly parsed servers with the environment `previous` already had for the same names. */
export function keepServerEnv(
  servers: readonly RequestMcpServer[],
  previous: readonly RequestMcpServer[],
): RequestMcpServer[] {
  return servers.map((server) => {
    const env = previous.find((old) => old.name === server.name)?.env;
    return env && env.length > 0 ? { ...server, env } : server;
  });
}

/** The environment as `parseEnvSpecs` reads it. */
export function formatEnvSpecs(servers: readonly RequestMcpServer[]): string {
  return servers
    .flatMap((server) => (server.env ?? []).map((item) => `${server.name}:${item.name}=${item.value}`))
    .join('; ');
}

export function formatServerSpecs(servers: readonly RequestMcpServer[]): string {
  return servers.map((server) => [`${server.name}=${server.command}`, ...server.args].join(' ')).join('; ');
}

/** The messenger's request settings replaced, everything else of the messenger and the channels kept. */
export function withRequests(settings: Settings, requests: RequestSettings): Settings {
  const desktop = settings.channel?.desktop ?? { mode: DEFAULT_DESKTOP_MODE };
  return {
    ...settings,
    channel: { ...settings.channel, desktop, messenger: { ...messengerSettings(settings), requests } },
  };
}

/**
 * `<id>`, `<id>:host`, `<id>:bundled` — the spelling `lotse agents --use` takes. A bare id means the
 * person's own install. `none` clears the choice (the GUI calls that Automatic). `known` limits the ids a person may *write*; the
 * file itself may still name an id this build lacks, and that is reported at resolution, not here.
 */
export function parseChoiceSpec(
  spec: string,
  known: readonly string[],
): { readonly choice: AgentChoice | null } | { readonly problem: string } {
  const text = spec.trim();
  if (text === 'none') return { choice: null };
  const [id = '', source = 'host', ...rest] = text.split(':');
  if (rest.length > 0 || (source !== 'host' && source !== 'bundled')) {
    return { problem: `"${spec}" is not <id>, <id>:host or <id>:bundled` };
  }
  if (!known.includes(id)) {
    return { problem: `"${id}" is not an agent launcher — try one of: ${known.join(', ')}` };
  }
  return { choice: { id, source } };
}

export interface SettingsRead {
  readonly settings: Settings;
  /** Why the file was not used, or `null`. Defaults stand in whenever this is set. */
  readonly problem: string | null;
  /** What kind of problem, or `null` exactly when `problem` is. */
  readonly problemKind: SettingsProblemKind | null;
}

/** The settings at `path`. A missing file is the defaults with no problem; a bad one is the defaults and a problem. */
export function readSettings(path: string): SettingsRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { settings: DEFAULT_SETTINGS, problem: null, problemKind: null };
    return {
      settings: DEFAULT_SETTINGS,
      problem: `${path} could not be read (${error instanceof Error ? error.message : String(error)}) — using defaults`,
      problemKind: 'unreadable',
    };
  }
  const parsed = parseSettings(raw);
  if ('problem' in parsed) {
    return {
      settings: DEFAULT_SETTINGS,
      problem: `${path}: ${parsed.problem} — using defaults`,
      problemKind: parsed.kind,
    };
  }
  return { settings: parsed.settings, problem: null, problemKind: null };
}

export type SaveDecision = 'write' | 'backup-then-write' | 'refuse';

/**
 * What a save may do to the file it finds, from what `readSettings` said about it. Pure, and the whole of
 * the rule: no problem → write; a file lotse read but did not accept → keep a copy, then write; a file it
 * does not understand (written by a newer lotse) or could not read → leave it alone.
 */
export function saveDecision(kind: SettingsProblemKind | null): SaveDecision {
  if (kind === null) return 'write';
  return kind === 'invalid' ? 'backup-then-write' : 'refuse';
}

/** Where the old file goes: next to it, `.bak` appended. */
export function backupPath(path: string): string {
  return `${path}.bak`;
}

/**
 * Save a choice the way `saveDecision` says. Returns where the old file was moved, or `null` when there was
 * nothing to move; throws when the decision is to refuse, naming why. The `.bak` is `0600` and replaces an
 * older one — one generation, so a repeated mistake cannot grow a pile of copies.
 */
export function saveSettings(path: string, settings: Settings): { readonly backup: string | null } {
  const read = readSettings(path);
  const decision = saveDecision(read.problemKind);
  if (decision === 'refuse') {
    throw new Error(`${read.problem ?? path} — not overwriting it`);
  }
  let backup: string | null = null;
  if (decision === 'backup-then-write') {
    backup = backupPath(path);
    renameSync(path, backup);
    chmodSync(backup, 0o600);
  }
  writeSettings(path, settings);
  return { backup };
}

/**
 * Write the settings: a sibling temp file, fsync, rename — the session store's recipe, so a crash leaves
 * the old file or the new one. File `0600`, a directory lotse creates `0700`. An existing directory is
 * left alone: `LOTSE_SETTINGS_FILE` may point into a shared one, and narrowing its mode is not ours to do.
 */
export function writeSettings(path: string, settings: Settings): void {
  writePrivateFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'settings');
}
