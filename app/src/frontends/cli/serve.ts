/**
 * `lotse serve` — run the configured tasks on their schedules (ADR 0003).
 *
 * One process, one pass per wake-up: look for due tasks, start each that is not already running,
 * record how it ended, sleep until the next one is due. Runs of different tasks overlap; runs of the
 * same task never do (the `running` set here, the lock file across processes).
 *
 * Before every pass the configuration hash is checked. A changed file stops `serve` — with exit
 * code 0 and a message on the channel — because an edit is meant to take effect on a restart the
 * person performs (ADR 0002 §3), and the shipped unit restarts only on failure.
 */

import type { CommandModule } from 'yargs';

import {
  answerQuestion,
  attemptClock,
  cancelOrphanedPermissions,
  dueTasks,
  freeModelNotes,
  nextWakeMs,
  runTask,
  type LotsePaths,
  type ServeChannel,
  type ServeDeps,
  type ServeTask,
} from '@lotse/core';

import { currentDialogCommand, openAnswerDialog } from '../../core/answer-dialog.ts';
import type { ServePaths } from '../../core/paths.ts';
import { currentTasksHash } from '../../core/serve-config.ts';
import { runState } from '../../core/serve-state.ts';
import { desktopMode, readSettings } from '../../core/settings.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, pickArgv } from './output.ts';
import { readTasks, serveDeps, trackedAgents } from './serve-deps.ts';

const FAILED = new Set(['unknown', 'dropped', 'expired', 'busy', 'invalid']);

/**
 * What a click on a notification does: answer through `answerQuestion`, exactly as `lotse answer`.
 * `deps` is read late — the channel exists before them, because they carry it.
 */
function answerHandlers(paths: LotsePaths, deps: () => ServeDeps | null) {
  const windows = new Set<string>();
  const answer = async (questionId: string, text: string) => {
    const current = deps();
    if (!current) return;
    const result = await answerQuestion(questionId, text, current);
    err(`  #${questionId}: ${result.message}`);
    if (!FAILED.has(result.mode)) return;
    const owner = result.question?.user;
    for (const user of current.config.users) {
      if (owner && user.id !== owner) continue;
      await current.channel.send(user, {
        title: 'lotse: answer not taken',
        body: result.message,
        questionId: null,
      });
    }
  };
  const report = (questionId: string, error: unknown) =>
    err(`  #${questionId}: ${error instanceof Error ? error.message : String(error)}`);
  return {
    mode: () => desktopMode(readSettings(paths.settingsFile).settings),
    onAnswer: (questionId: string, text: string) => {
      answer(questionId, text).catch((error: unknown) => report(questionId, error));
    },
    onDialog: (questionId: string) => {
      const command = currentDialogCommand();
      if ('problem' in command || windows.has(questionId)) return;
      windows.add(questionId);
      openAnswerDialog(command.command, questionId)
        .then(async (result) => {
          if (result.kind === 'failed') err(`  #${questionId}: ${result.reason}`);
          if (result.kind === 'answer') await answer(questionId, result.text);
        })
        .catch((error: unknown) => report(questionId, error))
        .finally(() => windows.delete(questionId));
    },
  };
}

async function openChannel(paths: LotsePaths, deps: () => ServeDeps | null): Promise<ServeChannel> {
  try {
    const { desktopChannel } = await import('../../core/desktop-channel.ts');
    return desktopChannel({
      onProblem: (problem) => err(`  ${problem}`),
      dialog: !('problem' in currentDialogCommand()),
      ...answerHandlers(paths, deps),
    });
  } catch (error) {
    err(
      `  no desktop session bus (${error instanceof Error ? error.message : String(error)}); questions go to stderr`,
    );
    return stderrChannel();
  }
}

const command = (paths: LotsePaths, serve: ServePaths): CommandModule => ({
  command: 'serve',
  describe: 'run the scheduled tasks and ask the person when an agent has a question',
  builder: (yargs) =>
    yargs
      .option('once', {
        type: 'boolean',
        describe: 'run the tasks that are due now, wait for them, and exit',
      })
      .option('quiet', { type: 'boolean', describe: "do not echo the agents' log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const once = pickArgv<boolean>(raw, 'once') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;

    const loaded = readTasks(serve);
    if (!loaded) return;
    for (const note of freeModelNotes(loaded.config)) err(`  ${note}`);
    let ready: ServeDeps | null = null;
    const channel = await openChannel(paths, () => ready);
    const agents = trackedAgents();
    const deps = serveDeps({ paths, serve, loaded, channel, open: agents.open, quiet });
    if (!deps) return;
    ready = deps;
    const runs = runState(serve.stateDir);
    const clock = attemptClock((id) => runs.lastRun(id));

    const dropped = cancelOrphanedPermissions(deps);
    if (dropped > 0) err(`  ${dropped} permission question(s) from an earlier serve cancelled`);
    err(
      `lotse serve — ${loaded.config.tasks.length} task(s), questions via ${channel.name}, state in ${serve.stateDir}`,
    );

    let stopping = false;
    let wake: (() => void) | null = null;
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      err(`  stopping: ${why}`);
      wake?.();
    };
    const onSignal = () => stop('signal');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const running = new Map<string, Promise<void>>();
    const start = (task: ServeTask) => {
      const done = runTask(task, deps)
        .then((result) => {
          if (result.outcome === 'skipped') clock.skipped(task.id, new Date(result.startedAt));
          else runs.record(result);
          const tail = result.reason
            ? `: ${result.reason}`
            : result.questionId
              ? ` (#${result.questionId})`
              : '';
          err(`  ${task.id}: ${result.outcome}${tail}`);
        })
        .catch((error: unknown) =>
          err(`  ${task.id}: ${error instanceof Error ? error.message : String(error)}`),
        )
        .finally(() => {
          running.delete(task.id);
          wake?.();
        });
      running.set(task.id, done);
    };

    try {
      while (!stopping) {
        if (currentTasksHash(serve.tasksFile, loaded.config) !== loaded.hash) {
          const why = `${serve.tasksFile} changed; restart serve to use it`;
          for (const user of loaded.config.users) {
            await channel.send(user, { title: 'lotse serve stopped', body: why, questionId: null });
          }
          stop(why);
          break;
        }
        const now = deps.now();
        for (const task of dueTasks(loaded.config, clock.lastRun, new Set(running.keys()), now)) start(task);
        if (once) break;
        const ms = nextWakeMs(loaded.config, clock.lastRun, deps.now());
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, ms);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
      // `--once` waits for its runs; a stop ends the agents, which ends their runs as failed.
      if (stopping) await agents.closeAll();
      await Promise.all(running.values());
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await agents.closeAll();
    }
  },
});

export const serveCommand = command;
