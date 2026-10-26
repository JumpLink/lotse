/**
 * What `listen` and `answer` both need: the task configuration, the agent each profile runs on, the
 * state files, and the channel. Each step prints its reason and sets the exit code when it has
 * nothing to return, the same contract as `choose.ts`, so a handler only has to stop.
 */

import { _, fmt } from '../../i18n.ts';
import {
  createPersonHost,
  openAgent,
  ProfilesError,
  ServeConfigError,
  type AgentCommand,
  type AgentHandle,
  type LotsePaths,
  type QuestionChannel,
  requestSettings,
  type RunDeps,
} from '@lotse/core';
import { messengerSettings, readSettings } from '../../core/settings.ts';

import type { ListenPaths } from '../../core/paths.ts';
import { actionLog, questionBook, runState, taskLock } from '../../core/serve-state.ts';
import {
  loadTasks,
  migrateProfiles,
  migrateTasks,
  readSkill,
  TasksFileMissingError,
  type LoadedTasks,
} from '../../core/serve-config.ts';
import { agentForNew } from './choose.ts';
import { err } from './output.ts';

/** One line per task whose file still has the removed `schedule`. It is ignored; nothing fails. */
export function reportRemovedSchedules(loaded: LoadedTasks): void {
  for (const id of loaded.removedSchedules)
    err(fmt(_("tasks.json: 'schedule' is no longer supported and is ignored (task {id})"), { id }));
}

export function readTasks(listen: ListenPaths): LoadedTasks | null {
  try {
    if (migrateProfiles(listen.tasksFile, listen.profilesFile))
      err(
        fmt(
          _(
            'The profiles in tasks.json were copied to {file}, which every lotse host now shares. tasks.json keeps working; edit the profiles there.',
          ),
          { file: listen.profilesFile },
        ),
      );
    const loaded = loadTasks(listen.tasksFile, listen.profilesFile);
    if (migrateTasks(loaded, listen.tasksDir).length > 0)
      err(
        fmt(
          _(
            'The tasks in tasks.json were copied to {dir}, one SKILL.md each. tasks.json keeps working and is not changed; edit the tasks there.',
          ),
          { dir: listen.tasksDir },
        ),
      );
    if (loaded.warning) err(fmt(_('  {warning}'), { warning: loaded.warning }));
    reportRemovedSchedules(loaded);
    return loaded;
  } catch (error) {
    if (
      !(
        error instanceof ServeConfigError ||
        error instanceof ProfilesError ||
        error instanceof TasksFileMissingError
      )
    )
      throw error;
    err(
      error instanceof ServeConfigError
        ? `${listen.tasksFile}: ${error.message}`
        : error instanceof ProfilesError
          ? `${listen.profilesFile}: ${error.message}`
          : error.message,
    );
    process.exitCode = 1;
    return null;
  }
}

/** Every profile's agent, resolved once at start: a launcher that is missing stops `listen` before any run. */
function agentsFor(paths: LotsePaths, loaded: LoadedTasks): Map<string, AgentCommand> | null {
  const commands = new Map<string, AgentCommand>();
  for (const profile of loaded.config.profiles) {
    const resolved = agentForNew(paths, profile.agent ?? undefined);
    if (!resolved) return null;
    commands.set(profile.id, resolved.command);
  }
  return commands;
}

/** Agents still open, so a stopping `listen` can end them instead of leaving them behind. */
export interface OpenAgents {
  readonly open: RunDeps['open'];
  closeAll(): Promise<void>;
}

export function trackedAgents(): OpenAgents {
  const handles = new Set<AgentHandle>();
  return {
    open: async (options) => {
      const handle = await openAgent(options);
      handles.add(handle);
      return {
        client: handle.client,
        logLines: handle.logLines,
        agentInfo: handle.agentInfo,
        close: () => {
          handles.delete(handle);
          return handle.close();
        },
      };
    },
    closeAll: async () => {
      await Promise.all([...handles].map((handle) => handle.close()));
      handles.clear();
    },
  };
}

export interface DepsOptions {
  readonly paths: LotsePaths;
  readonly listen: ListenPaths;
  readonly loaded: LoadedTasks;
  readonly channel: QuestionChannel;
  readonly open: RunDeps['open'];
  readonly quiet: boolean;
}

function personDefaultMin(paths: LotsePaths): number {
  const read = readSettings(paths.settingsFile);
  return read.problem ? 30 : requestSettings(messengerSettings(read.settings)).personNeededMinutes;
}

export function runDeps(options: DepsOptions): RunDeps | null {
  const commands = agentsFor(options.paths, options.loaded);
  if (!commands) return null;
  const now = () => new Date();
  const { stateDir } = options.listen;
  return {
    config: options.loaded.config,
    open: options.open,
    commandFor: (profile) => {
      const command = commands.get(profile.id);
      if (!command) throw new Error(`profile "${profile.id}" has no resolved agent`);
      return command;
    },
    promptFor: (task) => options.loaded.promptFor(task),
    precheckPromptFor: (task) => options.loaded.precheckPromptFor(task),
    previousRun: (task) => runState(stateDir).all()[task] ?? null,
    skill: (id) => readSkill(options.listen.tasksDir, id),
    record: (result) => runState(stateDir).record(result),
    channel: options.channel,
    questions: questionBook(stateDir, now, (problem) => err(fmt(_('  {problem}'), { problem }))),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lock: taskLock(stateDir),
    personHost: createPersonHost(),
    personDefaultMin: personDefaultMin(options.paths),
    log: actionLog(stateDir, now),
    ...(options.quiet ? {} : { onAgentLog: (line: string) => err(fmt(_('  [agent] {line}'), { line })) }),
  };
}
