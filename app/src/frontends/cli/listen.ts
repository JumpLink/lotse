/**
 * `lotse listen` — the long-running receiver: it answers the person's chat requests (`/ask`, `/run`,
 * `/tasks`, `/status`) and carries their answers to the agents' questions (ADR 0003). It starts no
 * task on its own; a task starts with `lotse run` or `/run`.
 *
 * One process, one pass per minute: reload what changed, look at the request settings, sleep.
 * The messenger receive loop and the notification buttons do the actual work between passes.
 *
 * Before every pass the configuration hash is checked. A changed file is reloaded in place
 * (`listen-reload.ts`): runs that are going finish with the definition they started with, later runs use
 * the new one, and a file that no longer parses leaves the previous one in force.
 */

import { _, fmt } from '../../i18n.ts';
import { homedir } from 'node:os';

import type { CommandModule } from 'yargs';

import {
  answerQuestion,
  cancelOrphanedPermissions,
  chatRequests,
  recoverPending,
  connectMcp,
  requestSettings,
  sendToPeer,
  freeModelNotes,
  McpLink,
  messengerChannel,
  type MessengerChannel,
  messengerCommand,
  messengerProblem,
  runReceiveLoop,
  routeChannels,
  unreachableTaskNotes,
  type ChannelFailure,
  type ChannelRoute,
  type LotsePaths,
  type ServeChannel,
  type ServeConfig,
  type ServeDeps,
  type MessengerSettings,
} from '@lotse/core';

import { currentDialogCommand, openAnswerDialog } from '../../core/answer-dialog.ts';
import type { ListenPaths } from '../../core/paths.ts';
import { currentTasksHash, loadTasks } from '../../core/serve-config.ts';
import {
  fileCursorStore,
  fileRefStore,
  filePendingStore,
  messengerCursorFile,
  messengerRefsFile,
  pendingRequestsFile,
} from '../../core/messenger-state.ts';
import { activeChannels, desktopMode, messengerSettings, readSettings } from '../../core/settings.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, pickArgv } from './output.ts';
import { createReloader, liveDeps } from './listen-reload.ts';
import { createRequestsHolder } from './chat-requests.ts';
import { readTasks, reportRemovedSchedules, runDeps, trackedAgents } from './listen-deps.ts';
import {
  reportText,
  runReportFromText,
  statusReport,
  statusText,
  tasksOf,
  tasksText,
} from './task-commands.ts';

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
    err(fmt(_('  #{questionId}: {message}'), { questionId, message: result.message }));
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
          if (result.kind === 'failed')
            err(fmt(_('  #{questionId}: {reason}'), { questionId, reason: result.reason }));
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
      onProblem: (problem) => err(fmt(_('  {problem}'), { problem })),
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
  stateDir: string,
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
    if (problem) err(fmt(_('  messenger channel not started: {problem}'), { problem }));
    else {
      const link = new McpLink(
        () =>
          connectMcp(messengerCommand(config), {
            onStderr: (line) => err(fmt(_('  messenger: {line}'), { line })),
          }),
        (line) => err(fmt(_('  {line}'), { line })),
      );
      const channel = messengerChannel(link, config, { refs: fileRefStore(messengerRefsFile(stateDir)) });
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
    err(fmt(_('  {note}'), { note }));
  // A channel that failed while another delivered is told here, nowhere else: stderr and listen.log.
  const failed: ChannelFailure = (name, error) => {
    const message = error instanceof Error ? error.message : String(error);
    err(fmt(_('  {name}: {message}'), { name, message }));
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

/** How long a pass sleeps before it looks at the task file and the request settings again. */
const PASS_MS = 60_000;

const command = (paths: LotsePaths, listen: ListenPaths): CommandModule => ({
  command: 'listen',
  describe: _('answer chat requests and ask the person when an agent has a question'),
  builder: (yargs) =>
    yargs.option('quiet', { type: 'boolean', describe: _("do not echo the agents' log lines") }).strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;

    const loaded = readTasks(listen);
    if (!loaded) return;
    for (const note of freeModelNotes(loaded.config)) err(fmt(_('  {note}'), { note }));
    let ready: ServeDeps | null = null;
    let activeConfig = loaded.config;
    const opened = await openChannels(
      paths,
      listen.stateDir,
      () => activeConfig,
      () => ready,
    );
    const channel = opened.channel;
    const agents = trackedAgents();
    const deps = runDeps({ paths, listen, loaded, channel, open: agents.open, quiet });
    if (!deps) return;
    const reloader = createReloader(
      {
        tasksFile: listen.tasksFile,
        load: (file) => loadTasks(file, listen.profilesFile),
        hashNow: (file, config) => currentTasksHash(file, config, listen.profilesFile),
        build: (next) => {
          // Building deps resolves agents, which sets the exit code when one is missing; a refused
          // reload must not turn a listen that keeps running into a failed one.
          const exitCode = process.exitCode;
          const built = runDeps({ paths, listen, loaded: next, channel, open: agents.open, quiet });
          if (!built) process.exitCode = exitCode;
          return built;
        },
      },
      { loaded, deps },
    );
    // The receive loop and the notification buttons outlive a reload, so they read the current deps.
    const live = liveDeps(() => reloader.current().deps);
    ready = live;

    const dropped = cancelOrphanedPermissions(live);
    if (dropped > 0)
      err(fmt(_('  {dropped} permission question(s) from an earlier listen cancelled'), { dropped }));
    err(
      fmt(
        _('lotse listen — listening for chat requests and answers, questions via {channel}, state in {dir}'),
        {
          channel: channel.name,
          dir: listen.stateDir,
        },
      ),
    );

    let stopping = false;
    let wake: (() => void) | null = null;
    const abort = new AbortController();
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      err(fmt(_('  stopping: {why}'), { why }));
      abort.abort();
      wake?.();
    };
    const messenger = opened.messenger;
    const pending = filePendingStore(pendingRequestsFile(listen.stateDir));
    const holder = messenger
      ? createRequestsHolder({
          read: () => {
            const read = readSettings(paths.settingsFile);
            return read.problem ? null : requestSettings(messengerSettings(read.settings));
          },
          profiles: () => reloader.current().deps.config.profiles.map((profile) => profile.id),
          build: (settings) =>
            chatRequests({
              settings,
              deps: live,
              defaultCwd: homedir(),
              pending,
              send: (text) => sendToPeer(messenger.link, messenger.settings, text),
              log: (line) => err(fmt(_('  {line}'), { line })),
            }),
        })
      : null;
    const checkRequests = () => {
      const change = holder?.check();
      if (!change || change.kind === 'unchanged') return;
      err(fmt(_('  {line}'), { line: change.line }));
      live.log?.({
        event: 'reload',
        task: '-',
        detail: { requests: change.kind === 'changed' && change.on ? 'on' : 'off' },
      });
    };
    checkRequests();
    if (messenger && holder?.current()) {
      const left = await recoverPending(
        pending,
        (text) => sendToPeer(messenger.link, messenger.settings, text),
        (line) => err(fmt(_('  {line}'), { line })),
      );
      if (left > 0)
        err(
          fmt(_('  {left} chat request(s) from an earlier listen were not completed; the chat was told'), {
            left,
          }),
        );
    }
    const receive = (signal: AbortSignal) =>
      runReceiveLoop({
        link: messenger!.link,
        settings: messenger!.settings,
        channel: messenger!.channel,
        deps: live,
        cursor: fileCursorStore(messengerCursorFile(listen.stateDir)),
        refs: fileRefStore(messengerRefsFile(listen.stateDir)),
        requests: () => holder?.current(),
        commands: {
          run: async (args) => reportText(await runReportFromText(args, live)),
          tasks: () => tasksText(tasksOf(listen, live.config)),
          status: () => statusText(statusReport(listen)),
        },
        log: (line) => err(fmt(_('  {line}'), { line })),
        signal,
      }).catch((error: unknown) =>
        err(`  messenger: ${error instanceof Error ? error.message : String(error)}`),
      );
    const receiving = messenger ? receive(abort.signal) : null;
    const onSignal = () => stop('signal');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
      while (!stopping) {
        const change = reloader.check();
        if (change.kind === 'reloaded') {
          const { loaded: fresh, deps: freshDeps } = reloader.current();
          activeConfig = fresh.config;
          if (fresh.warning) err(fmt(_('  {warning}'), { warning: fresh.warning }));
          reportRemovedSchedules(fresh);
          err(fmt(_('  {file} reloaded'), { file: listen.tasksFile }));
          freshDeps.log?.({
            event: 'reload',
            task: '-',
            detail: { tasks: String(fresh.config.tasks.length) },
          });
        } else if (change.kind === 'rejected') {
          const message = fmt(_('{file} not reloaded, keeping the previous one: {problem}'), {
            file: listen.tasksFile,
            problem: change.message,
          });
          err(fmt(_('  {message}'), { message }));
          reloader.current().deps.log?.({
            event: 'error',
            task: '-',
            detail: { kind: 'reload', message: change.message.slice(0, 200) },
          });
        }
        checkRequests();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, PASS_MS);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
      // A stop ends the agents, which ends their runs as failed.
      await agents.closeAll();
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

export const listenCommand = command;
