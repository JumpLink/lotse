/**
 * A task as a SKILL.md — ADR 0007 §4–§6.
 *
 * `$XDG_CONFIG_HOME/lotse/tasks/<id>/SKILL.md` follows the Agent Skills layout: YAML frontmatter, then
 * the prompt. `name` is the id and must equal the directory; lotse's own settings live under
 * `metadata` as `lotse-*` strings, so the file stays a valid skill for any other reader. Core does
 * not read files: the host passes the text in, like the task file and the profiles file.
 *
 * The frontmatter is a deliberate subset of YAML — flat `key: value` lines, one `metadata:` map,
 * plain or quoted scalars — so no YAML dependency is needed. Anything outside it is a problem the
 * person is told about, never silently dropped.
 *
 * **A task only narrows its profile.** `allowed-tools` names MCP servers of the profile; one the
 * profile does not have is an error, never an addition. Rights narrow in the runner (`narrowRights`).
 */

import type { McpServer } from '@lotse/acp';

import { isId } from '../parse.ts';
import {
  DEFAULT_QUESTION_LIMITS,
  PERSON_NEEDED_OFF,
  type PersonNeededConfig,
  type ServeConfig,
  type ServeTask,
} from '../serve/config.ts';

/** The metadata keys lotse reads. Any other `lotse-*` key is reported as a typo. */
export const TASK_METADATA = {
  profile: 'lotse-profile',
  rights: 'lotse-rights',
  params: 'lotse-params',
  precheck: 'lotse-precheck',
  personNeeded: 'lotse-person-needed',
  cwd: 'lotse-cwd',
} as const;

export interface TaskParam {
  readonly name: string;
  /** `null`: the parameter is required. */
  readonly default: string | null;
}

export interface SkillTask {
  readonly id: string;
  readonly description: string;
  /** MCP server names of the profile this task may use. `null`: all of them. */
  readonly allowedTools: readonly string[] | null;
  /** A profile id of tasks.json. `null`: the only profile there is. */
  readonly profile: string | null;
  readonly rights: 'read' | 'confirm';
  readonly params: readonly TaskParam[];
  /** One-line prompt of the precheck turn. `null`: none. */
  readonly precheck: string | null;
  readonly personNeeded: PersonNeededConfig;
  readonly cwd: string;
  /** The prompt, with `{{param}}` placeholders. */
  readonly body: string;
}

/** The SKILL.md or its narrowing is wrong. Every problem at once. */
export class TaskFileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 1 ? problems[0]! : `${problems.length} problems:\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'TaskFileError';
    this.problems = problems;
  }
}

/** The caller asked wrongly: an unknown task, an unknown or missing parameter. */
export class TaskUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskUsageError';
  }
}

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const SERVER_NAME = /^[A-Za-z0-9_.-]+$/;
const TOP_KEYS = new Set(['name', 'description', 'allowed-tools', 'metadata', 'license', 'compatibility']);

function scalar(raw: string, where: string, problems: string[]): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // reported below
    }
    problems.push(`${where}: a double-quoted value must be a valid one-line JSON string`);
    return '';
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      problems.push(`${where}: a single-quoted value must end with a quote`);
      return '';
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

interface Frontmatter {
  readonly top: Record<string, string>;
  readonly metadata: Record<string, string>;
  readonly body: string;
}

function splitFrontmatter(text: string, problems: string[]): Frontmatter | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    problems.push('SKILL.md must start with a "---" frontmatter line');
    return null;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) {
    problems.push('the frontmatter is not closed by a "---" line');
    return null;
  }
  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  lines.slice(1, end).forEach((line, index) => {
    const where = `frontmatter line ${index + 2}`;
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const match = /^(\s*)([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!match) {
      problems.push(`${where} is not "key: value"`);
      return;
    }
    const key = match[2]!;
    const rest = match[3]!;
    if (match[1] === '') {
      inMetadata = key === 'metadata';
      if (!TOP_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
      else if (key in top) problems.push(`${where}: "${key}" is given twice`);
      else if (inMetadata) {
        if (rest.trim() !== '') problems.push(`${where}: "metadata" must be a map of indented lines`);
        top[key] = '';
      } else top[key] = scalar(rest, where, problems);
    } else if (inMetadata) {
      if (key in metadata) problems.push(`${where}: "${key}" is given twice`);
      metadata[key] = scalar(rest, where, problems);
    } else {
      problems.push(`${where}: unexpected indentation`);
    }
  });
  return {
    top,
    metadata,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

function parseParams(value: string | undefined, problems: string[]): TaskParam[] {
  if (value === undefined || value.trim() === '') return [];
  const params: TaskParam[] = [];
  for (const entry of value.split(',')) {
    const cut = entry.indexOf('=');
    const name = (cut < 0 ? entry : entry.slice(0, cut)).trim();
    if (!PARAM_NAME.test(name)) {
      problems.push(`${TASK_METADATA.params}: "${name}" is not a parameter name (letters, digits, "_")`);
      continue;
    }
    if (params.some((param) => param.name === name)) {
      problems.push(`${TASK_METADATA.params}: "${name}" is declared twice`);
      continue;
    }
    params.push({ name, default: cut < 0 ? null : entry.slice(cut + 1).trim() });
  }
  return params;
}

function parsePersonNeeded(value: string | undefined, problems: string[]): PersonNeededConfig {
  if (value === undefined || value === 'false') return PERSON_NEEDED_OFF;
  if (value === 'true') return { enabled: true, timeoutMin: null };
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1) {
    problems.push(`${TASK_METADATA.personNeeded} must be "true", "false" or a number of minutes`);
    return PERSON_NEEDED_OFF;
  }
  return { enabled: true, timeoutMin: minutes };
}

export interface ParseSkillOptions {
  /** The working directory when the task names none, usually the task's own directory. */
  readonly cwd?: string;
}

/** Parse one SKILL.md. Throws `TaskFileError` listing every problem. */
export function parseSkillTask(id: string, text: string, options: ParseSkillOptions = {}): SkillTask {
  const problems: string[] = [];
  const front = splitFrontmatter(text, problems);
  if (!front) throw new TaskFileError(problems);
  const { top, metadata } = front;

  if (!isId(id))
    problems.push(`"${id}" is not a task id (lowercase letters, digits, "-" or "_", at most 40)`);
  if (top['name'] !== id) problems.push(`"name" must be "${id}", the name of the task's directory`);
  const description = top['description']?.trim() ?? '';
  if (description === '') problems.push('"description" is required');

  let allowedTools: string[] | null = null;
  if ('allowed-tools' in top) {
    allowedTools = top['allowed-tools']!.split(/\s+/).filter(Boolean);
    if (allowedTools.length === 0)
      problems.push('"allowed-tools" is empty; leave it out to allow every server');
    for (const name of allowedTools) {
      if (!SERVER_NAME.test(name))
        problems.push(`allowed-tools: "${name}" is not an MCP server name (tool names are not supported)`);
    }
  }

  for (const key of Object.keys(metadata)) {
    if (key.startsWith('lotse-') && !Object.values<string>(TASK_METADATA).includes(key))
      problems.push(`unknown metadata key "${key}"`);
  }
  const profile = metadata[TASK_METADATA.profile]?.trim() || null;
  if (profile !== null && !isId(profile)) problems.push(`${TASK_METADATA.profile} is not a profile id`);
  const rights = metadata[TASK_METADATA.rights] ?? 'confirm';
  if (rights !== 'read' && rights !== 'confirm')
    problems.push(`${TASK_METADATA.rights} must be "read" or "confirm"`);
  const cwd = metadata[TASK_METADATA.cwd] ?? options.cwd;
  if (cwd === undefined || !cwd.startsWith('/'))
    problems.push(`${TASK_METADATA.cwd} must be an absolute path`);

  const params = parseParams(metadata[TASK_METADATA.params], problems);
  const precheck = metadata[TASK_METADATA.precheck]?.trim() || null;
  if (front.body === '') problems.push('the prompt (the text after the frontmatter) is empty');
  for (const text of [front.body, precheck ?? '']) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!params.some((param) => param.name === match[1]))
        problems.push(`the prompt uses {{${match[1]}}}, which ${TASK_METADATA.params} does not declare`);
    }
  }
  const personNeeded = parsePersonNeeded(metadata[TASK_METADATA.personNeeded], problems);
  if (problems.length > 0) throw new TaskFileError([...new Set(problems)]);

  return {
    id,
    description,
    allowedTools,
    profile,
    rights: rights === 'read' ? 'read' : 'confirm',
    params,
    precheck,
    personNeeded,
    cwd: cwd!,
    body: front.body,
  };
}

/** `--param k=v` pairs (or the words after `/run <id>`) as a map. Throws `TaskUsageError`. */
export function parseParamPairs(pairs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const cut = pair.indexOf('=');
    const name = cut < 0 ? '' : pair.slice(0, cut);
    if (!PARAM_NAME.test(name)) throw new TaskUsageError(`"${pair}" is not a parameter like name=value`);
    if (name in params) throw new TaskUsageError(`parameter "${name}" is given twice`);
    params[name] = pair.slice(cut + 1);
  }
  return params;
}

/** Words of a chat line; `"…"` and `'…'` keep spaces inside one word, `k="a b"` included. */
export function splitWords(text: string): string[] {
  const words = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return words.map((word) =>
    word.replace(/"([^"]*)"|'([^']*)'/g, (_whole, a?: string, b?: string) => a ?? b ?? ''),
  );
}

/** What follows `/run` in the chat: the task id, then `k=v` words. Throws `TaskUsageError`. */
export function parseRunArgs(text: string): { id: string; params: Record<string, string> } {
  const [id, ...rest] = splitWords(text);
  if (!id || !isId(id)) throw new TaskUsageError('say which task to run, like: /run <task> name=value');
  return { id, params: parseParamPairs(rest) };
}

/**
 * The prompt and the precheck prompt of one run, `{{param}}` filled. Unknown and missing parameters
 * are a usage error. One pass: a value that looks like a placeholder is not expanded again.
 */
export function renderTask(
  skill: SkillTask,
  given: Readonly<Record<string, string>>,
): { prompt: string; precheck: string | null } {
  for (const name of Object.keys(given)) {
    if (!skill.params.some((param) => param.name === name))
      throw new TaskUsageError(
        `task "${skill.id}" has no parameter "${name}"` +
          (skill.params.length > 0
            ? ` (it takes ${skill.params.map((param) => param.name).join(', ')})`
            : ''),
      );
  }
  const values: Record<string, string> = {};
  for (const param of skill.params) {
    const value = given[param.name] ?? param.default;
    if (value === null) throw new TaskUsageError(`task "${skill.id}" needs the parameter "${param.name}"`);
    values[param.name] = value;
  }
  const fill = (text: string) => text.replace(PLACEHOLDER, (_whole, name: string) => values[name] ?? '');
  return { prompt: fill(skill.body), precheck: skill.precheck === null ? null : fill(skill.precheck) };
}

/**
 * The servers of `available` that `allowed` names. A name `available` lacks is an error: a task
 * narrows its profile and can never add to it. `null`: every server.
 */
export function narrowServers(
  available: readonly McpServer[],
  allowed: readonly string[] | null,
): McpServer[] {
  if (allowed === null) return [...available];
  const missing = allowed.filter((name) => !available.some((server) => server.name === name));
  if (missing.length > 0)
    throw new TaskFileError([
      `allowed-tools names ${missing.join(', ')}, which the profile does not have — a task can only narrow its profile`,
    ]);
  return available.filter((server) => allowed.includes(server.name));
}

/**
 * The `ServeTask` a SKILL.md stands for, bound to a profile of `config`. Throws `TaskFileError` when
 * the profile is unknown or `allowed-tools` would widen it.
 */
export function serveTaskOf(skill: SkillTask, config: ServeConfig): ServeTask {
  const profile = skill.profile
    ? config.profiles.find((candidate) => candidate.id === skill.profile)
    : config.profiles.length === 1
      ? config.profiles[0]
      : undefined;
  if (!profile)
    throw new TaskFileError([
      skill.profile
        ? `${TASK_METADATA.profile} "${skill.profile}" is not a profile of tasks.json`
        : `${TASK_METADATA.profile} is required when tasks.json has more than one profile`,
    ]);
  return {
    id: skill.id,
    profile: profile.id,
    prompt: skill.body,
    promptFile: null,
    cwd: skill.cwd,
    mcpServers: narrowServers(profile.base?.mcpServers ?? [], skill.allowedTools),
    answerMcpServers: null,
    precheck: skill.precheck ? { profile: null, prompt: skill.precheck, promptFile: null } : null,
    rights: skill.rights,
    released: [],
    questions: DEFAULT_QUESTION_LIMITS,
    notify: 'questions',
    personNeeded: skill.personNeeded,
    channels: null,
    messengerDetail: null,
  };
}

/** The SKILL.md a task of tasks.json becomes (the migration, ADR 0007 §7). */
export function skillFromTask(task: ServeTask, prompt: string, precheck: string | null): string {
  const q = (value: string) => JSON.stringify(value);
  const metadata = [
    `  ${TASK_METADATA.profile}: ${q(task.profile)}`,
    `  ${TASK_METADATA.rights}: ${q(task.rights === 'read' ? 'read' : 'confirm')}`,
    `  ${TASK_METADATA.cwd}: ${q(task.cwd)}`,
    ...(task.personNeeded.enabled
      ? [`  ${TASK_METADATA.personNeeded}: ${q(String(task.personNeeded.timeoutMin ?? 'true'))}`]
      : []),
    ...(precheck ? [`  ${TASK_METADATA.precheck}: ${q(precheck.replace(/\s+/g, ' ').trim())}`] : []),
  ];
  return [
    '---',
    `name: ${task.id}`,
    `description: ${q(`Migrated from tasks.json (task ${task.id})`)}`,
    ...(task.mcpServers.length > 0 ? [`allowed-tools: ${task.mcpServers.map((s) => s.name).join(' ')}`] : []),
    'metadata:',
    ...metadata,
    '---',
    '',
    `${prompt.trim()}`,
    '',
  ].join('\n');
}
