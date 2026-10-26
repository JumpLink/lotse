/**
 * What `lotse run`, `lotse tasks` and `lotse status` do, and what the chat commands `/run`, `/tasks`
 * and `/status` say: one implementation, two surfaces (ADR 0007 §9–11). Nothing here calls a model
 * except `runTask` itself.
 */

import { _, fmt } from '../../i18n.ts';

import {
  formatQuestionId,
  isOpen,
  parseRunArgs,
  runTask,
  TaskUsageError,
  type ServeConfig,
  type ServeDeps,
  type TaskRun,
} from '@lotse/core';

import type { ServePaths } from '../../core/paths.ts';
import { listTasks, type TaskEntry } from '../../core/serve-config.ts';
import { questionBook, runningTasks, runState, type RunRecord } from '../../core/serve-state.ts';

/** `lotse run`'s exit codes: done, failed, usage error, needs a person. */
export const EXIT = { done: 0, failed: 1, usage: 2, 'needs-person': 3 } as const;

export type RunReport =
  | { readonly code: 0 | 1 | 3; readonly result: TaskRun }
  | { readonly code: 2; readonly result: { readonly status: 'usage'; readonly reason: string } };

/** Run one task; a unknown task or a bad parameter is code 2, not an exception. */
export async function runReport(
  id: string,
  params: Readonly<Record<string, string>>,
  deps: ServeDeps,
): Promise<RunReport> {
  try {
    const result = await runTask(id, params, deps);
    return { code: EXIT[result.status], result };
  } catch (error) {
    if (error instanceof TaskUsageError)
      return { code: 2, result: { status: 'usage', reason: error.message } };
    throw error;
  }
}

/** The words after `/run`, run like `lotse run`. */
export async function runReportFromText(args: string, deps: ServeDeps): Promise<RunReport> {
  try {
    const { id, params } = parseRunArgs(args);
    return await runReport(id, params, deps);
  } catch (error) {
    if (error instanceof TaskUsageError)
      return { code: 2, result: { status: 'usage', reason: error.message } };
    throw error;
  }
}

export function reportText(report: RunReport): string {
  const { result } = report;
  switch (result.status) {
    case 'done':
      return result.output || _('Done.');
    case 'needs-person':
      return fmt(_('Waiting for you: {id}. Answer it with `lotse answer {id} <text>`.'), {
        id: formatQuestionId(result.questionId),
      });
    case 'usage':
      return fmt(_('Not started: {reason}'), { reason: result.reason });
    default:
      return fmt(_('Failed: {reason}'), { reason: result.reason });
  }
}

export function tasksText(entries: readonly TaskEntry[]): string {
  if (entries.length === 0) return _('No tasks.');
  return entries
    .map((entry) => {
      const params = entry.params.length > 0 ? ` (${entry.params.join(', ')})` : '';
      const note = entry.problem ? ` — ${entry.problem}` : entry.description ? ` — ${entry.description}` : '';
      return `${entry.id}${params}${note}`;
    })
    .join('\n');
}

export interface StatusReport {
  readonly running: readonly string[];
  readonly recent: Readonly<Record<string, RunRecord>>;
  readonly questions: readonly { id: string; task: string; kind: string; expiresAt: string }[];
}

export function statusReport(serve: ServePaths, now: Date = new Date()): StatusReport {
  const book = questionBook(
    serve.stateDir,
    () => now,
    () => {},
  ).read();
  return {
    running: runningTasks(serve.stateDir),
    recent: runState(serve.stateDir).all(),
    questions: book
      .filter((question) => isOpen(question, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, task, kind, expiresAt }) => ({ id: formatQuestionId(id), task, kind, expiresAt })),
  };
}

export function statusText(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(
    report.running.length > 0
      ? fmt(_('Running: {tasks}'), { tasks: report.running.join(', ') })
      : _('Nothing is running.'),
  );
  const recent = Object.entries(report.recent).sort((a, b) => b[1].endedAt.localeCompare(a[1].endedAt));
  for (const [task, run] of recent.slice(0, 10))
    lines.push(fmt(_('{task}: {outcome} at {time}'), { task, outcome: run.outcome, time: run.endedAt }));
  for (const question of report.questions)
    lines.push(
      fmt(_('Open: {id} ({task}) until {time}'), {
        id: question.id,
        task: question.task,
        time: question.expiresAt,
      }),
    );
  return lines.join('\n');
}

export const tasksOf = (serve: ServePaths, config: ServeConfig): TaskEntry[] =>
  listTasks(serve.tasksDir, config);
