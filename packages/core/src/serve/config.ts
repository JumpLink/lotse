/**
 * The task configuration `lotse serve` runs from — users, profiles, tasks — and its validation.
 *
 * **Configuration, not code** (ADR 0002 §3). lotse knows no task, no person and no address; all of
 * that arrives here as JSON from a private file outside the repository. This module only says whether
 * the file is well-formed and what it means, and it says it at start: a task naming a profile nobody
 * defined, a released area under a read-only task — each is a sentence before the first run, not a
 * surprise at 3 a.m. Which model a profile runs on is the person's choice and never a problem here;
 * a private profile on a free model earns a note (`freeModelNotes`), not a refusal.
 *
 * The keys each object may have come from `SERVE_CONFIG_SCHEMA` (`schema.ts`), so the schema a
 * settings page edits and the parser cannot drift apart.
 *
 * **Read once, hashed.** `configHash` covers the file and every prompt file it names. `serve` keeps
 * the hash and stops when it changes, so an edit — by the person or by a session that should not have
 * been able to make it — takes effect on a restart the person performs (ADR 0002 §3, §6).
 */

import { createHash } from 'node:crypto';

import type { McpServer } from '@lotse/acp';

import { isFreeModel } from '../free-models.ts';
import { CHANNEL_NAMES, type ChannelName } from '../messenger/settings.ts';
import { parseDuration } from './duration.ts';
import { SERVE_CONFIG_SCHEMA, schemaKeys } from './schema.ts';

/** A person `serve` works for. `addresses` are channel addresses; the desktop channel needs none. */
export interface ServeUser {
  readonly id: string;
  readonly addresses: readonly string[];
}

/**
 * Who a task runs as and on what. A named model is pinned: there is no fallback when the agent does not
 * offer it (ADR 0002 §5). No model: lotse sends none and the agent's own default applies.
 */
export interface ServeProfile {
  readonly id: string;
  readonly user: string;
  /** A launcher id (`opencode`). Absent: the same resolution `lotse start` uses. */
  readonly agent: string | null;
  /** A value of the agent's `model` config option. `null`: the agent's own default. */
  readonly model: string | null;
  /** A label for the person. It never blocks a run (ADR 0002, amendment of 2026-10-11). */
  readonly data: 'private' | 'public';
  /** The channels its tasks' messages may use. `null`: every active one. A task's own list can only narrow it. */
  readonly channels: readonly ChannelName[] | null;
  /** How much of a question the messenger gets. `null`: `full`. `notice` on the task or here wins. */
  readonly messengerDetail: MessengerDetail | null;
}

/** `full`: the question goes to the chat. `notice`: only that one waits, and where to read it. */
export type MessengerDetail = 'full' | 'notice';

/** Where one task's messages go, its own settings narrowing its profile's. */
export interface TaskDelivery {
  /** `null`: every active channel. */
  readonly channels: readonly ChannelName[] | null;
  readonly messengerDetail: MessengerDetail;
}

/**
 * A cheaper turn before the task: it ends with `WORK` or `NOTHING` on its last line, and only `WORK`
 * starts the task. It gets the task's `mcpServers` and a gate that declines every permission request.
 */
export interface ServePrecheck {
  /** The profile it runs on. `null`: the task's agent, with no model sent (the agent's default). */
  readonly profile: string | null;
  /** Exactly one of the two, like a task's. */
  readonly prompt: string | null;
  readonly promptFile: string | null;
}

/**
 * The three rights levels (ADR 0002 §6). `read` declines every permission request without asking,
 * `confirm` asks for each, `released` allows the listed areas once per call and asks for the rest.
 */
export type RightsLevel = 'read' | 'confirm' | 'released';

/**
 * An area the person released without questions: a tool, matched by the exact title the agent gives
 * the call, optionally narrowed by its kind. The person's decision, recorded here and nowhere else.
 */
export interface ReleasedArea {
  readonly tool: string;
  readonly kind: string | null;
}

export interface QuestionLimits {
  /** How long a question stays open before it is answered `cancelled`. */
  readonly expiresMs: number;
  /** More open questions than this and the task is skipped without a model call. */
  readonly maxOpen: number;
  /** More questions created in the last hour than this and the task is skipped. */
  readonly maxPerHour: number;
}

export interface ServeTask {
  readonly id: string;
  readonly profile: string;
  /** Exactly one of the two. A prompt file is resolved by the app, relative to the config file. */
  readonly prompt: string | null;
  readonly promptFile: string | null;
  readonly cwd: string;
  /** Passed to `session/new` as is — MCP is passed through, not known. */
  readonly mcpServers: readonly McpServer[];
  /**
   * The servers for the turn that continues a reply question, instead of `mcpServers`. `null`: the
   * same ones. A task can hand the agent a read-only server to ask with and a writing one only after
   * the person has said yes — the write tools do not exist before the answer.
   */
  readonly answerMcpServers: readonly McpServer[] | null;
  readonly precheck: ServePrecheck | null;
  readonly rights: RightsLevel;
  readonly released: readonly ReleasedArea[];
  readonly questions: QuestionLimits;
  /** `questions`: notify only when the agent asks. `always`: also send the run's answer. */
  readonly notify: 'questions' | 'always';
  /** The `person_needed` tool. `timeoutMin` `null`: the settings' default. */
  readonly personNeeded: PersonNeededConfig;
  /** Narrows the profile's `channels` (the intersection); `null`: the profile's. */
  readonly channels: readonly ChannelName[] | null;
  /** `notice` tightens the profile's `messengerDetail`, never loosens it; `null`: the profile's. */
  readonly messengerDetail: MessengerDetail | null;
}

export interface PersonNeededConfig {
  readonly enabled: boolean;
  readonly timeoutMin: number | null;
}

export const PERSON_NEEDED_OFF: PersonNeededConfig = { enabled: false, timeoutMin: null };

export interface ServeConfig {
  readonly users: readonly ServeUser[];
  readonly profiles: readonly ServeProfile[];
  readonly tasks: readonly ServeTask[];
}

export const DEFAULT_QUESTION_LIMITS: QuestionLimits = {
  expiresMs: 12 * 3_600_000,
  maxOpen: 3,
  maxPerHour: 6,
};

/** Every problem in the file at once, so one edit fixes all of them. */
export class ServeConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`the task configuration has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ServeConfigError';
    this.problems = problems;
  }
}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * One sentence per private profile on a free model, for `serve` to print at start. A free model may be
 * unvetted for private data; choosing one is the person's call, so this informs and blocks nothing.
 */
export function freeModelNotes(config: ServeConfig): string[] {
  return config.profiles
    .filter((profile) => profile.data === 'private' && profile.model && isFreeModel(profile.model))
    .map(
      (profile) =>
        `profile "${profile.id}" is private and runs on the free model "${profile.model}" — your choice, noted`,
    );
}

const KEYS = {
  top: schemaKeys(SERVE_CONFIG_SCHEMA),
  user: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.user),
  profile: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.profile),
  task: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.task),
  precheck: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.precheck),
  released: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.task.properties.released.items),
  questions: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.task.properties.questions),
  personNeeded: schemaKeys(SERVE_CONFIG_SCHEMA.$defs.task.properties.personNeeded),
};

/** Tasks used to carry a `schedule`; an old file that still does is read and the field ignored. */
const REMOVED_TASK_KEY = 'schedule';

/** The ids of the tasks in this file that still carry the removed `schedule`, for one notice each. */
export function tasksWithRemovedSchedule(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const tasks = isRecord(raw) && Array.isArray(raw['tasks']) ? raw['tasks'] : [];
  return tasks.flatMap((task, index) =>
    isRecord(task) && REMOVED_TASK_KEY in task
      ? [typeof task['id'] === 'string' && task['id'] ? task['id'] : `#${index + 1}`]
      : [],
  );
}

/** Parse and validate. Throws `ServeConfigError` listing every problem. */
export function parseServeConfig(text: string): ServeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ServeConfigError([`not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const problems: string[] = [];
  if (!isRecord(raw)) throw new ServeConfigError(['the top level must be an object']);
  if (raw['version'] !== 1) problems.push('"version" must be 1');
  for (const key of Object.keys(raw)) {
    if (!KEYS.top.includes(key)) problems.push(`unknown key "${key}"`);
  }

  const users = list(raw['users'], 'users', problems).map((value, index) =>
    parseUser(value, `users[${index}]`, problems),
  );
  const profiles = list(raw['profiles'], 'profiles', problems).map((value, index) =>
    parseProfile(value, `profiles[${index}]`, problems),
  );
  const tasks = list(raw['tasks'], 'tasks', problems).map((value, index) =>
    parseTask(value, `tasks[${index}]`, problems),
  );

  duplicates(users, 'user', problems);
  duplicates(profiles, 'profile', problems);
  duplicates(tasks, 'task', problems);
  for (const profile of profiles) {
    if (profile.id && !users.some((user) => user.id === profile.user)) {
      problems.push(`profile "${profile.id}" names user "${profile.user}", which is not defined`);
    }
  }
  for (const task of tasks) {
    if (task.id && !profiles.some((profile) => profile.id === task.profile)) {
      problems.push(`task "${task.id}" names profile "${task.profile}", which is not defined`);
    }
    const checkProfile = task.precheck?.profile;
    if (task.id && checkProfile && !profiles.some((profile) => profile.id === checkProfile)) {
      problems.push(`task "${task.id}".precheck names profile "${checkProfile}", which is not defined`);
    }
  }

  if (problems.length > 0) throw new ServeConfigError(problems);
  return { users, profiles, tasks };
}

/** The hash `serve` keeps: the file and every prompt file, in order, each length-prefixed. */
export function configHash(texts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const text of texts) hash.update(`${text.length}:${text}\n`);
  return hash.digest('hex');
}

export function profileOf(config: ServeConfig, task: ServeTask): ServeProfile {
  const profile = config.profiles.find((candidate) => candidate.id === task.profile);
  if (!profile) throw new Error(`task "${task.id}" has no profile "${task.profile}"`);
  return profile;
}

/**
 * The channels and the messenger detail a task's messages get. A task can only narrow its profile:
 * the channels are the intersection of both lists, and the stricter detail (`notice`) wins — so a
 * profile that keeps private documents off a channel cannot be undone by one task. An unknown task
 * gets the defaults.
 */
export function deliveryOf(config: ServeConfig, taskId: string): TaskDelivery {
  const task = config.tasks.find((candidate) => candidate.id === taskId);
  const profile = task ? config.profiles.find((candidate) => candidate.id === task.profile) : undefined;
  const own = task?.channels ?? null;
  const inherited = profile?.channels ?? null;
  const channels = own && inherited ? own.filter((name) => inherited.includes(name)) : (own ?? inherited);
  const notice = task?.messengerDetail === 'notice' || profile?.messengerDetail === 'notice';
  return { channels, messengerDetail: notice ? 'notice' : 'full' };
}

/**
 * One sentence per task that cannot reach what it asks for: it names a channel its profile excludes
 * (ignored, never widened), or none of its channels is active so its questions reach nobody.
 */
export function unreachableTaskNotes(config: ServeConfig, active: readonly ChannelName[]): string[] {
  return config.tasks.flatMap((task) => {
    const notes: string[] = [];
    const profile = config.profiles.find((candidate) => candidate.id === task.profile);
    const excluded = (task.channels ?? []).filter(
      (name) => profile?.channels && !profile.channels.includes(name),
    );
    if (excluded.length > 0)
      notes.push(
        `task "${task.id}" names ${excluded.join(', ')}, which its profile "${task.profile}" excludes — a task can only narrow its profile, so it is ignored`,
      );
    const { channels } = deliveryOf(config, task.id);
    if (channels && !channels.some((name) => active.includes(name)))
      notes.push(
        channels.length === 0
          ? `task "${task.id}" has no channel left after its profile's list — its questions are in \`lotse questions\` only`
          : `task "${task.id}" may use only ${channels.join(', ')}, which is not active — its questions are in \`lotse questions\` only`,
      );
    return notes;
  });
}

function parseDelivery(
  record: Record<string, unknown>,
  where: string,
  problems: string[],
): { channels: ChannelName[] | null; messengerDetail: MessengerDetail | null } {
  let channels: ChannelName[] | null = null;
  const rawChannels = record['channels'];
  if (rawChannels !== undefined) {
    const valid =
      Array.isArray(rawChannels) &&
      rawChannels.length > 0 &&
      rawChannels.every((name) => CHANNEL_NAMES.includes(name as ChannelName));
    if (valid) channels = [...new Set(rawChannels as ChannelName[])];
    else
      problems.push(
        `${where}.channels must be a non-empty list of ${CHANNEL_NAMES.map((name) => `"${name}"`).join(', ')} — leave it out for every channel`,
      );
  }
  const detail = record['messengerDetail'];
  if (detail !== undefined && detail !== 'full' && detail !== 'notice') {
    problems.push(`${where}.messengerDetail must be "full" or "notice"`);
  }
  return { channels, messengerDetail: detail === 'full' || detail === 'notice' ? detail : null };
}

function parseUser(value: unknown, where: string, problems: string[]): ServeUser {
  const record = object(value, where, problems, KEYS.user);
  const addresses = record['addresses'] === undefined ? [] : record['addresses'];
  const valid = Array.isArray(addresses) && addresses.every((address) => typeof address === 'string');
  if (!valid) problems.push(`${where}.addresses must be a list of strings`);
  return { id: id(record['id'], where, problems), addresses: valid ? (addresses as string[]) : [] };
}

function parseProfile(value: unknown, where: string, problems: string[]): ServeProfile {
  const record = object(value, where, problems, KEYS.profile);
  const profileId = id(record['id'], where, problems);
  const agent = optionalString(record['agent'], `${where}.agent`, problems);
  const model = optionalString(record['model'], `${where}.model`, problems);
  const data = record['data'];
  if (data !== 'private' && data !== 'public') {
    problems.push(`${where}.data must be "private" or "public" — say which, there is no default`);
  }
  return {
    id: profileId,
    user: typeof record['user'] === 'string' ? record['user'] : '',
    agent,
    model,
    data: data === 'public' ? 'public' : 'private',
    ...parseDelivery(record, where, problems),
  };
}

function parseTask(value: unknown, where: string, problems: string[]): ServeTask {
  const record = object(value, where, problems, [...KEYS.task, REMOVED_TASK_KEY]);
  const taskId = id(record['id'], where, problems);
  const label = taskId ? `task "${taskId}"` : where;

  const prompt = optionalString(record['prompt'], `${label}.prompt`, problems);
  const promptFile = optionalString(record['promptFile'], `${label}.promptFile`, problems);
  if ((prompt === null) === (promptFile === null)) {
    problems.push(`${label} needs exactly one of "prompt" and "promptFile"`);
  }

  const cwd = record['cwd'];
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) problems.push(`${label}.cwd must be an absolute path`);

  const mcpServers = record['mcpServers'] === undefined ? [] : record['mcpServers'];
  const serversValid =
    Array.isArray(mcpServers) &&
    mcpServers.every((server) => isRecord(server) && typeof server['name'] === 'string');
  if (!serversValid) problems.push(`${label}.mcpServers must be a list of MCP servers, each with a "name"`);

  const answerServers = record['answerMcpServers'];
  const answerServersValid =
    answerServers === undefined ||
    (Array.isArray(answerServers) &&
      answerServers.every((server) => isRecord(server) && typeof server['name'] === 'string'));
  if (!answerServersValid) {
    problems.push(`${label}.answerMcpServers must be a list of MCP servers, each with a "name"`);
  }

  const precheck = parsePrecheck(record['precheck'], label, problems);

  const rights = record['rights'] ?? 'confirm';
  if (rights !== 'read' && rights !== 'confirm' && rights !== 'released') {
    problems.push(`${label}.rights must be "read", "confirm" or "released"`);
  }
  const released = parseReleased(record['released'], label, problems);
  if (rights === 'released' && released.length === 0) {
    problems.push(`${label} has rights "released" but releases nothing`);
  }
  if (rights !== 'released' && released.length > 0) {
    problems.push(`${label} lists "released" areas but its rights are "${String(rights)}"`);
  }

  const notify = record['notify'] ?? 'questions';
  if (notify !== 'questions' && notify !== 'always') {
    problems.push(`${label}.notify must be "questions" or "always"`);
  }

  return {
    id: taskId,
    profile: typeof record['profile'] === 'string' ? record['profile'] : '',
    prompt,
    promptFile,
    cwd: typeof cwd === 'string' ? cwd : '',
    mcpServers: serversValid ? (mcpServers as McpServer[]) : [],
    answerMcpServers:
      answerServers !== undefined && answerServersValid ? (answerServers as McpServer[]) : null,
    precheck,
    rights: rights === 'read' || rights === 'released' ? rights : 'confirm',
    released,
    questions: parseLimits(record['questions'], label, problems),
    notify: notify === 'always' ? 'always' : 'questions',
    personNeeded: parsePersonNeeded(record['personNeeded'], label, problems),
    ...parseDelivery(record, label, problems),
  };
}

function parsePersonNeeded(value: unknown, label: string, problems: string[]): PersonNeededConfig {
  if (value === undefined) return PERSON_NEEDED_OFF;
  const where = `${label}.personNeeded`;
  const record = object(value, where, problems, KEYS.personNeeded);
  const enabled = record['enabled'] ?? false;
  if (typeof enabled !== 'boolean') problems.push(`${where}.enabled must be true or false`);
  const timeout = record['timeoutMin'];
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1))
    problems.push(`${where}.timeoutMin must be a whole number of minutes, 1 or more`);
  return {
    enabled: enabled === true,
    timeoutMin: typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 ? timeout : null,
  };
}

function parsePrecheck(value: unknown, label: string, problems: string[]): ServePrecheck | null {
  if (value === undefined || value === null) return null;
  const where = `${label}.precheck`;
  const record = object(value, where, problems, KEYS.precheck);
  const prompt = optionalString(record['prompt'], `${where}.prompt`, problems);
  const promptFile = optionalString(record['promptFile'], `${where}.promptFile`, problems);
  if ((prompt === null) === (promptFile === null)) {
    problems.push(`${where} needs exactly one of "prompt" and "promptFile"`);
  }
  return { profile: optionalString(record['profile'], `${where}.profile`, problems), prompt, promptFile };
}

function parseReleased(value: unknown, label: string, problems: string[]): ReleasedArea[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${label}.released must be a list`);
    return [];
  }
  return value.flatMap((entry, index) => {
    const where = `${label}.released[${index}]`;
    const record = object(entry, where, problems, KEYS.released);
    if (typeof record['tool'] !== 'string' || record['tool'].trim() === '') {
      problems.push(`${where}.tool must name the tool`);
      return [];
    }
    return [{ tool: record['tool'], kind: optionalString(record['kind'], `${where}.kind`, problems) }];
  });
}

function parseLimits(value: unknown, label: string, problems: string[]): QuestionLimits {
  if (value === undefined) return DEFAULT_QUESTION_LIMITS;
  const where = `${label}.questions`;
  const record = object(value, where, problems, KEYS.questions);
  let expiresMs = DEFAULT_QUESTION_LIMITS.expiresMs;
  if (record['expiresIn'] !== undefined) {
    const parsed = typeof record['expiresIn'] === 'string' ? parseDuration(record['expiresIn']) : null;
    if (parsed === null) problems.push(`${where}.expiresIn must be a duration like 30m, 12h or 2d`);
    else expiresMs = parsed;
  }
  return {
    expiresMs,
    maxOpen: count(record['maxOpen'], `${where}.maxOpen`, DEFAULT_QUESTION_LIMITS.maxOpen, problems),
    maxPerHour: count(
      record['maxPerHour'],
      `${where}.maxPerHour`,
      DEFAULT_QUESTION_LIMITS.maxPerHour,
      problems,
    ),
  };
}

function count(value: unknown, where: string, fallback: number, problems: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    problems.push(`${where} must be a whole number of at least 1`);
    return fallback;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(
  value: unknown,
  where: string,
  problems: string[],
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${where} has unknown key "${key}"`);
  }
  return value;
}

function list(value: unknown, where: string, problems: string[]): unknown[] {
  if (!Array.isArray(value)) {
    problems.push(`"${where}" must be a list`);
    return [];
  }
  return value;
}

function id(value: unknown, where: string, problems: string[]): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    problems.push(`${where}.id must be lowercase letters, digits, "-" or "_" (at most 40)`);
    return '';
  }
  return value;
}

function optionalString(value: unknown, where: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where} must be a non-empty string`);
    return null;
  }
  return value;
}

function duplicates(items: readonly { id: string }[], what: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) problems.push(`${what} "${item.id}" is defined twice`);
    seen.add(item.id);
  }
}
