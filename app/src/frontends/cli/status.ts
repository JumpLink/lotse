/** `lotse status [--json]` — what is running, the last run of each task, the open questions (ADR 0007 §9). */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import type { LotsePaths } from '@lotse/core';

import type { ListenPaths } from '../../core/paths.ts';
import { out, pickArgv } from './output.ts';
import { knownTasks, statusReport, statusText } from './task-commands.ts';

const command = (_paths: LotsePaths, listen: ListenPaths): CommandModule => ({
  command: 'status',
  describe: _('show running tasks, recent runs and open questions'),
  builder: (yargs) =>
    yargs.option('json', { type: 'boolean', describe: _('print the status as JSON') }).strict(),
  handler: (argv) => {
    const report = statusReport(listen);
    if (pickArgv<boolean>(argv as Record<string, unknown>, 'json') === true)
      out(JSON.stringify(report, null, 2));
    else out(statusText(report, { known: knownTasks(listen.tasksDir) }));
  },
});

export const statusCommand = command;
