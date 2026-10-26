/** `lotse tasks [--json]` — the tasks `lotse run` knows: SKILL.md directories (ADR 0007 §9). */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import type { LotsePaths } from '@lotse/core';

import type { ListenPaths } from '../../core/paths.ts';
import { out, pickArgv } from './output.ts';
import { listTasks } from '../../core/skills.ts';
import { migrateConfig } from './listen-deps.ts';
import { tasksText } from './task-commands.ts';

const command = (_paths: LotsePaths, listen: ListenPaths): CommandModule => ({
  command: 'tasks',
  describe: _('list the tasks that can be run'),
  builder: (yargs) =>
    yargs.option('json', { type: 'boolean', describe: _('print the tasks as JSON') }).strict(),
  handler: (argv) => {
    migrateConfig(listen);
    const entries = listTasks(listen.tasksDir);
    if (pickArgv<boolean>(argv as Record<string, unknown>, 'json') === true)
      out(JSON.stringify(entries, null, 2));
    else out(tasksText(entries));
  },
});

export const tasksCommand = command;
