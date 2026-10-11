/**
 * Reading the task configuration for `lotse serve` (ADR 0003 §1).
 *
 * The file is read once, at start, together with every prompt file it names; the hash covers all of
 * them. `serve` recomputes the hash on every pass and stops when it differs, so an edit takes effect
 * on a restart the person performs, never under a run that is already going (ADR 0002 §3).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { configHash, parseServeConfig, type ServeConfig, type ServeTask } from '@lotse/core';

export interface LoadedTasks {
  readonly config: ServeConfig;
  readonly hash: string;
  /** Present when the file can be read by someone other than its owner. */
  readonly warning: string | null;
  promptFor(task: ServeTask): string;
  precheckPromptFor(task: ServeTask): string;
}

export class TasksFileMissingError extends Error {
  constructor(file: string) {
    super(
      `there is no task configuration at ${file}. Copy examples/tasks.example.json there, fill it in, ` +
        'and `chmod 600` it — docs/serve.md describes every field.',
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
): { all: string[]; prompts: Map<string, string>; prechecks: Map<string, string> } {
  const all = [first];
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

/** Parse the file and read its prompt files. Throws `ServeConfigError` or `TasksFileMissingError`. */
export function loadTasks(tasksFile: string): LoadedTasks {
  if (!existsSync(tasksFile)) throw new TasksFileMissingError(tasksFile);
  const text = readFileSync(tasksFile, 'utf8');
  const config = parseServeConfig(text);
  const { all, prompts, prechecks } = texts(tasksFile, config, text);
  const mode = statSync(tasksFile).mode & 0o777;
  return {
    config,
    hash: configHash(all),
    warning:
      (mode & 0o077) !== 0
        ? `${tasksFile} is readable by others (mode ${mode.toString(8)}); \`chmod 600\` it`
        : null,
    promptFor: (task) => prompts.get(task.id) ?? '',
    precheckPromptFor: (task) => prechecks.get(task.id) ?? '',
  };
}

/** The hash as it is on disk now, for the same tasks; `null` when a file cannot be read any more. */
export function currentTasksHash(tasksFile: string, config: ServeConfig): string | null {
  try {
    return configHash(texts(tasksFile, config, readFileSync(tasksFile, 'utf8')).all);
  } catch {
    return null;
  }
}
