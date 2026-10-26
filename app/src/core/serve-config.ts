/**
 * Reading the task configuration for `lotse listen` (ADR 0003 §1).
 *
 * The file is read once, at start, together with every prompt file it names; the hash covers all of
 * them. `listen` recomputes the hash on every pass and stops when it differs, so an edit takes effect
 * on a restart the person performs, never under a run that is already going (ADR 0002 §3).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  configHash,
  isId,
  parseProfiles,
  parseSkillTask,
  skillFromTask,
  parseServeConfig,
  profilesFromTasks,
  tasksWithRemovedSchedule,
  type ServeConfig,
  type ServeTask,
  type SkillTask,
  TaskFileError,
} from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

export interface LoadedTasks {
  readonly config: ServeConfig;
  readonly hash: string;
  /** Present when the file can be read by someone other than its owner. */
  readonly warning: string | null;
  /** Tasks that still carry the removed `schedule`: read, ignored, and named once so the person can delete it. */
  readonly removedSchedules: readonly string[];
  promptFor(task: ServeTask): string;
  precheckPromptFor(task: ServeTask): string;
}

export class TasksFileMissingError extends Error {
  constructor(file: string) {
    super(
      `there is no task configuration at ${file}. Copy examples/tasks.example.json there, fill it in, ` +
        'and `chmod 600` it — docs/listen.md describes every field.',
    );
    this.name = 'TasksFileMissingError';
  }
}

/** A prompt file is resolved relative to the configuration file, so the two can move together. */
export function promptPath(tasksFile: string, promptFile: string): string {
  return isAbsolute(promptFile) ? promptFile : join(dirname(tasksFile), promptFile);
}

function texts(
  tasksFile: string,
  config: ServeConfig,
  first: string,
  profilesText: string | null,
): { all: string[]; prompts: Map<string, string>; prechecks: Map<string, string> } {
  const all = profilesText === null ? [first] : [first, profilesText];
  const read = (source: { prompt: string | null; promptFile: string | null }): string => {
    if (source.prompt !== null) return source.prompt;
    const text = readFileSync(promptPath(tasksFile, source.promptFile ?? ''), 'utf8');
    all.push(text);
    return text;
  };
  const prompts = new Map<string, string>();
  const prechecks = new Map<string, string>();
  for (const task of config.tasks) {
    prompts.set(task.id, read(task));
    if (task.precheck) prechecks.set(task.id, read(task.precheck));
  }
  return { all, prompts, prechecks };
}

/**
 * profiles.json from the profiles still in tasks.json, once (ADR 0007 §3). Only when profiles.json is
 * absent, never over an existing one, and tasks.json is only read. `true` when it wrote the file.
 */
export function migrateProfiles(tasksFile: string, profilesFile: string): boolean {
  if (existsSync(profilesFile) || !existsSync(tasksFile)) return false;
  const text = profilesFromTasks(readFileSync(tasksFile, 'utf8'));
  if (text === null) return false;
  writePrivateFile(profilesFile, text, 'profiles');
  return true;
}

/**
 * Write `tasks/<id>/SKILL.md` for every task of tasks.json that has no directory yet (ADR 0007 §7).
 * A directory that exists is never touched and tasks.json is only read. Returns the ids it wrote.
 */
export function migrateTasks(loaded: LoadedTasks, tasksDir: string): string[] {
  const written: string[] = [];
  for (const task of loaded.config.tasks) {
    const dir = join(tasksDir, task.id);
    if (existsSync(dir) || !isId(task.id)) continue;
    const precheck = task.precheck ? loaded.precheckPromptFor(task) : null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(join(dir, 'SKILL.md'), skillFromTask(task, loaded.promptFor(task), precheck), 'skill');
    written.push(task.id);
  }
  return written;
}

/** One task's SKILL.md, or `null` when there is no such directory. Throws `TaskFileError`. */
export function readSkill(tasksDir: string, id: string): SkillTask | null {
  if (!isId(id)) return null;
  const file = join(tasksDir, id, 'SKILL.md');
  if (!existsSync(file)) return null;
  return parseSkillTask(id, readFileSync(file, 'utf8'), { cwd: join(tasksDir, id) });
}

/** What `lotse tasks` shows for one task. */
export interface TaskEntry {
  readonly id: string;
  readonly source: 'skill' | 'tasks.json';
  readonly description: string;
  readonly params: readonly string[];
  /** Why a SKILL.md cannot be run, when it cannot. */
  readonly problem: string | null;
}

/** Every SKILL.md directory, then the tasks of tasks.json no directory shadows. */
export function listTasks(tasksDir: string, config: ServeConfig): TaskEntry[] {
  const entries: TaskEntry[] = [];
  const dirs = existsSync(tasksDir)
    ? readdirSync(tasksDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const id of dirs) {
    try {
      const skill = readSkill(tasksDir, id);
      if (!skill) continue;
      entries.push({
        id,
        source: 'skill',
        description: skill.description,
        params: skill.params.map((param) =>
          param.default === null ? param.name : `${param.name}=${param.default}`,
        ),
        problem: null,
      });
    } catch (error) {
      if (!(error instanceof TaskFileError)) throw error;
      entries.push({ id, source: 'skill', description: '', params: [], problem: error.message });
    }
  }
  for (const task of config.tasks) {
    if (dirs.includes(task.id)) continue;
    entries.push({ id: task.id, source: 'tasks.json', description: '', params: [], problem: null });
  }
  return entries;
}

function readProfilesText(profilesFile: string | undefined): string | null {
  return profilesFile !== undefined && existsSync(profilesFile) ? readFileSync(profilesFile, 'utf8') : null;
}

/**
 * Parse the file and read its prompt files, and the shared profiles of `profilesFile` when it exists.
 * Throws `ServeConfigError`, `ProfilesError` or `TasksFileMissingError`.
 */
export function loadTasks(tasksFile: string, profilesFile?: string): LoadedTasks {
  if (!existsSync(tasksFile)) throw new TasksFileMissingError(tasksFile);
  const text = readFileSync(tasksFile, 'utf8');
  const profilesText = readProfilesText(profilesFile);
  const config = parseServeConfig(
    text,
    profilesText === null ? {} : { profiles: parseProfiles(profilesText) },
  );
  const { all, prompts, prechecks } = texts(tasksFile, config, text, profilesText);
  const mode = statSync(tasksFile).mode & 0o777;
  return {
    config,
    hash: configHash(all),
    removedSchedules: tasksWithRemovedSchedule(text),
    warning:
      (mode & 0o077) !== 0
        ? `${tasksFile} is readable by others (mode ${mode.toString(8)}); \`chmod 600\` it`
        : null,
    promptFor: (task) => prompts.get(task.id) ?? '',
    precheckPromptFor: (task) => prechecks.get(task.id) ?? '',
  };
}

/** The hash as it is on disk now, for the same tasks; `null` when a file cannot be read any more. */
export function currentTasksHash(
  tasksFile: string,
  config: ServeConfig,
  profilesFile?: string,
): string | null {
  try {
    return configHash(
      texts(tasksFile, config, readFileSync(tasksFile, 'utf8'), readProfilesText(profilesFile)).all,
    );
  } catch {
    return null;
  }
}
