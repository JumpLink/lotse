/**
 * The tasks: one `tasks/<id>/SKILL.md` each (ADR 0007 §6). Read per run, so an edit takes effect on
 * the next run without a restart.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isId, parseSkillTask, TaskFileError, type SkillTask } from '@lotse/core';

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
  readonly description: string;
  readonly params: readonly string[];
  /** Why a SKILL.md cannot be run, when it cannot. */
  readonly problem: string | null;
}

/** Every directory of `tasksDir` that holds a SKILL.md. */
export function listTasks(tasksDir: string): TaskEntry[] {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
    .flatMap((id): TaskEntry[] => {
      try {
        const skill = readSkill(tasksDir, id);
        if (!skill) return [];
        const params = skill.params.map((param) =>
          param.default === null ? param.name : `${param.name}=${param.default}`,
        );
        return [{ id, description: skill.description, params, problem: null }];
      } catch (error) {
        if (!(error instanceof TaskFileError)) throw error;
        return [{ id, description: '', params: [], problem: error.message }];
      }
    });
}
