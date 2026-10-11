/**
 * `lotse serve` — run the configured tasks on their schedules (ADR 0003).
 *
 * One process, one pass per wake-up: look for due tasks, start each that is not already running,
 * record how it ended, sleep until the next one is due. Runs of different tasks overlap; runs of the
 * same task never do (the `running` set here, the lock file across processes).
 *
 * Before every pass the configuration hash is checked. A changed file is reloaded in place
 * (`serve-reload.ts`): runs that are going finish with the definition they started with, later runs use
 * the new one, and a file that no longer parses leaves the previous tasks in force.
 */

import type { CommandModule } from 'yargs';

import {
  answerQuestion,
  attemptClock,
  cancelOrphanedPermissions,
  connectMcp,
  dueTasks,
  freeModelNotes,
  McpLink,
  messengerChannel,
  type MessengerChannel,
  messengerCommand,
  messengerProblem,
  nextWakeMs,
  runReceiveLoop,
  routeChannels,
  runTask,
  unreachableTaskNotes,
  type ChannelFailure,
  type ChannelRoute,
  type LotsePaths,
  type ServeChannel,
  type ServeConfig,
  type ServeDeps,
  type MessengerSettings,
  type ServeTask,
} from '@lotse/core';

import { currentDialogCommand, openAnswerDialog } from '../../core/answer-dialog.ts';
import type { ServePaths } from '../../core/paths.ts';
import { currentTasksHash, loadTasks } from '../../core/serve-config.ts';
import { runState } from '../../core/serve-state.ts';
import { fileCursorStore, messengerCursorFile } from '../../core/messenger-state.ts';
import { activeChannels, desktopMode, messengerSettings, readSettings } from '../../core/settings.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, pickArgv } from './output.ts';
import { createReloader, liveDeps } from './serve-reload.ts';
import { readTasks, serveDeps, trackedAgents } from './serve-deps.ts';

const FAILED = new Set(['unknown', 'dropped', 'expired', 'busy', 'invalid']);

/**
 * What a click on a notification does: answer through `answerQuestion`, exactly as `lotse answer`.
 * `deps` is read late — the channel exists before them, because they carry it.
 */
function answerHandlers(
  paths: LotsePaths,
  deps: () => ServeDeps | null,
  feedback: () => ServeChannel | null,
) {
  const windows = new Set<string>();
  const answer = async (questionId: string, text: string) => {
    const current = deps();
    if (!current) return;
    const result = await answerQuestion(questionId, text, current);
    err(`  #${questionId}: ${result.message}`);
    if (!FAILED.has(result.mode)) return;
    // Feedback goes to the desktop, not the combined channel: the messenger's own receive loop
    // answers its person in the chat, and a click here must not post "not taken" there.
    const channel = feedback();
    if (!channel) return;
    const owner = result.question?.user;
    for (const user of current.config.users) {
      if (owner && user.id !== owner) continue;
      await channel.send(user, {
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

async function openDesktop(
  paths: LotsePaths,
  deps: () => ServeDeps | null,
  feedback: () => ServeChannel | null,
): Promise<ServeChannel> {
  try {
    const { desktopChannel } = await import('../../core/desktop-channel.ts');
    return desktopChannel({
      onProblem: (problem) => err(`  ${problem}`),
      dialog: !('problem' in currentDialogCommand()),
      ...answerHandlers(paths, deps, feedback),
    });
  } catch (error) {
    err(
      `  no desktop session bus (${error instanceof Error ? error.message : String(error)}); questions go to stderr`,
    );
    return stderrChannel();
  }
}

interface OpenedChannels {
  readonly channel: ServeChannel;
  /** Present when the messenger is active and complete: the receive loop runs on this link. */
  readonly messenger: {
    readonly link: McpLink;
    readonly settings: MessengerSettings;
    readonly channel: MessengerChannel;
  } | null;
}

/**
 * The channels settings.json asks for, read once at start (a change needs a restart), each message
 * routed by its task's `channels` and `messengerDetail`.
 */
async function openChannels(
  paths: LotsePaths,
  config: () => ServeConfig,
  deps: () => ServeDeps | null,
): Promise<OpenedChannels> {
  const settings = readSettings(paths.settingsFile).settings;
  const active = activeChannels(settings);
  let desktop: ServeChannel | null = null;
  const useDesktop = active.includes('desktop');
  const opened: ChannelRoute[] = [];
  let messenger: OpenedChannels['messenger'] = null;
  if (active.includes('messenger')) {
    const config = messengerSettings(settings);
    const problem = messengerProblem(config);
    if (problem) err(`  messenger channel not started: ${problem}`);
    else {
      const link = new McpLink(() =>
        connectMcp(messengerCommand(config), { onStderr: (line) => err(`  messenger: ${line}`) }),
      );
      const channel = messengerChannel(link, config);
      messenger = { link, settings: config, channel };
      opened.push({ name: 'messenger', channel });
    }
  }
  if (useDesktop || opened.length === 0) {
    desktop = await openDesktop(paths, deps, () => desktop);
    opened.unshift({ name: 'desktop', channel: desktop });
  }
  for (const note of unreachableTaskNotes(
    config(),
    opened.map((route) => route.name),
  ))
    err(`  ${note}`);
  // A channel that failed while another delivered is told here, nowhere else: stderr and serve.log.
  const failed: ChannelFailure = (name, error) => {
    const message = error instanceof Error ? error.message : String(error);
    err(`  ${name}: ${message}`);
    deps()?.log?.({
      event: 'error',
      task: '-',
      detail: {
        channel: name,
        kind: error instanceof Error ? error.name : 'Error',
        message: message.slice(0, 200),
      },
    });
  };
  return { channel: routeChannels(opened, config, failed), messenger };
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
    let activeConfig = loaded.config;
    const opened = await openChannels(
      paths,
      () => activeConfig,
      () => ready,
    );
    const channel = opened.channel;
    const agents = trackedAgents();
    const deps = serveDeps({ paths, serve, loaded, channel, open: agents.open, quiet });
    if (!deps) return;
    const reloader = createReloader(
      {
        tasksFile: serve.tasksFile,
        load: loadTasks,
        hashNow: currentTasksHash,
        build: (next) => {
          // Building deps resolves agents, which sets the exit code when one is missing; a refused
          // reload must not turn a serve that keeps running into a failed one.
          const exitCode = process.exitCode;
          const built = serveDeps({ paths, serve, loaded: next, channel, open: agents.open, quiet });
          if (!built) process.exitCode = exitCode;
          return built;
        },
      },
      { loaded, deps },
    );
    // The receive loop and the notification buttons outlive a reload, so they read the current deps.
    const live = liveDeps(() => reloader.current().deps);
    ready = live;
    const runs = runState(serve.stateDir);
    const clock = attemptClock((id) => runs.lastRun(id));

    const dropped = cancelOrphanedPermissions(live);
    if (dropped > 0) err(`  ${dropped} permission question(s) from an earlier serve cancelled`);
    err(
      `lotse serve — ${loaded.config.tasks.length} task(s), questions via ${channel.name}, state in ${serve.stateDir}`,
    );

    let stopping = false;
    let wake: (() => void) | null = null;
    const abort = new AbortController();
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      err(`  stopping: ${why}`);
      abort.abort();
      wake?.();
    };
    // `--once` ends before a person could reply, so the receive loop belongs to the long-running serve.
    const receiving =
      opened.messenger && !once
        ? runReceiveLoop({
            link: opened.messenger.link,
            settings: opened.messenger.settings,
            channel: opened.messenger.channel,
            serve: live,
            cursor: fileCursorStore(messengerCursorFile(serve.stateDir)),
            signal: abort.signal,
            log: (line) => err(`  ${line}`),
          }).catch((error: unknown) =>
            err(`  messenger: ${error instanceof Error ? error.message : String(error)}`),
          )
        : null;
    const onSignal = () => stop('signal');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const running = new Map<string, Promise<void>>();
    const start = (task: ServeTask, runDeps: ServeDeps) => {
      const done = runTask(task, runDeps)
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
        const change = reloader.check();
        if (change.kind === 'reloaded') {
          const { loaded: fresh, deps: freshDeps } = reloader.current();
          activeConfig = fresh.config;
          if (fresh.warning) err(`  ${fresh.warning}`);
          const parts = [
            change.added.length > 0 ? `added ${change.added.join(', ')}` : '',
            change.removed.length > 0
              ? `removed ${change.removed.join(', ')} (a run in progress finishes)`
              : '',
            change.changed.length > 0 ? `changed ${change.changed.join(', ')} (from its next run)` : '',
          ].filter(Boolean);
          err(
            `  ${serve.tasksFile} reloaded — ${fresh.config.tasks.length} task(s)${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`,
          );
          freshDeps.log?.({
            event: 'reload',
            task: '-',
            detail: { tasks: String(fresh.config.tasks.length) },
          });
        } else if (change.kind === 'rejected') {
          const message = `${serve.tasksFile} not reloaded, keeping the previous tasks: ${change.message}`;
          err(`  ${message}`);
          reloader.current().deps.log?.({
            event: 'error',
            task: '-',
            detail: { kind: 'reload', message: change.message.slice(0, 200) },
          });
        }
        const current = reloader.current().deps;
        const now = current.now();
        for (const task of dueTasks(current.config, clock.lastRun, new Set(running.keys()), now)) {
          start(task, current);
        }
        if (once) break;
        const ms = nextWakeMs(current.config, clock.lastRun, current.now());
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
      abort.abort();
      await receiving;
      await opened.messenger?.link.close();
      await agents.closeAll();
    }
  },
});

export const serveCommand = command;
