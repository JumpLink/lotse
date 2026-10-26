/** `lotse tasks [--json]` — the tasks `lotse run` knows: SKILL.md directories, then tasks.json (ADR 0007 §9). */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import type { LotsePaths } from '@lotse/core';

import type { ListenPaths } from '../../core/paths.ts';
import { out, pickArgv } from './output.ts';
import { readTasks } from './listen-deps.ts';
import { tasksOf, tasksText } from './task-commands.ts';

const command = (_paths: LotsePaths, listen: ListenPaths): CommandModule => ({
  command: 'tasks',
  describe: _('list the tasks that can be run'),
  builder: (yargs) =>
    yargs.option('json', { type: 'boolean', describe: _('print the tasks as JSON') }).strict(),
  handler: (argv) => {
    const loaded = readTasks(listen);
    if (!loaded) return;
    const entries = tasksOf(listen, loaded.config);
    if (pickArgv<boolean>(argv as Record<string, unknown>, 'json') === true)
      out(JSON.stringify(entries, null, 2));
    else out(tasksText(entries));
  },
});

export const tasksCommand = command;
