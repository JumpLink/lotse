/**
 * `lotse run <id> [--param k=v]... [--json]` — run one task now (ADR 0007 §9).
 *
 * Exit code: 0 done, 1 failed, 2 usage error, 3 a question is waiting for a person. The task's output
 * is printed on stdout; `--json` prints the result instead.
 */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import { parseParamPairs, TaskUsageError, type LotsePaths } from '@lotse/core';

import type { ServePaths } from '../../core/paths.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, out, pickArgv } from './output.ts';
import { readTasks, serveDeps, trackedAgents } from './serve-deps.ts';
import { reportText, runReport } from './task-commands.ts';

const command = (paths: LotsePaths, serve: ServePaths): CommandModule => ({
  command: 'run <id>',
  describe: _('run a task now'),
  builder: (yargs) =>
    yargs
      .positional('id', { type: 'string', describe: _('the task id, from `lotse tasks`') })
      .option('param', { type: 'string', array: true, describe: _('a parameter, like name=value') })
      .option('json', { type: 'boolean', describe: _('print the result as JSON') })
      .option('quiet', { type: 'boolean', describe: _("do not echo the agent's log lines") })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const id = String(pickArgv<string | number>(raw, 'id') ?? '');
    const json = pickArgv<boolean>(raw, 'json') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true || json;
    let params: Record<string, string>;
    try {
      params = parseParamPairs(pickArgv<string[]>(raw, 'param') ?? []);
    } catch (error) {
      if (!(error instanceof TaskUsageError)) throw error;
      err(error.message);
      process.exitCode = 2;
      return;
    }
    const loaded = readTasks(serve);
    if (!loaded) return;
    const agents = trackedAgents();
    const deps = serveDeps({ paths, serve, loaded, channel: stderrChannel(), open: agents.open, quiet });
    if (!deps) return;
    try {
      const report = await runReport(id, params, deps);
      if (json) out(JSON.stringify(report.result, null, 2));
      else if (report.code === 0) out(reportText(report));
      else err(reportText(report));
      process.exitCode = report.code;
    } finally {
      await agents.closeAll();
      // On GJS the agent's child-process handle keeps the main loop alive after the handler returns.
      process.exit(process.exitCode ?? 0);
    }
  },
});

export const runCommand = command;
