/**
 * What `listen` and `answer` both need: the task configuration, the agent each profile runs on, the
 * state files, and the channel. Each step prints its reason and sets the exit code when it has
 * nothing to return, the same contract as `choose.ts`, so a handler only has to stop.
 */

import { dirname } from 'node:path';

import { _, fmt } from '../../i18n.ts';
import {
  createPersonHost,
  openAgent,
  type AgentCommand,
  type AgentHandle,
  type LotsePaths,
  type QuestionChannel,
  requestSettings,
  type RunDeps,
} from '@lotse/core';
import { messengerSettings, readSettings } from '../../core/settings.ts';

import type { ListenPaths } from '../../core/paths.ts';
import { actionLog } from '../../core/action-log.ts';
import {
  ConfigFileError,
  ConfigMissingError,
  loadConfig,
  type LoadedConfig,
} from '../../core/config-files.ts';
import { migrateLegacyFiles } from '../../core/legacy-migration.ts';
import { questionBook } from '../../core/question-state.ts';
import { runState, taskLock } from '../../core/run-state.ts';
import { readSkill } from '../../core/skills.ts';
import { agentForNew } from './choose.ts';
import { err } from './output.ts';

/**
 * Bring users.json, profiles.json and the tasks directory up to date from a legacy tasks.json —
 * with one notice when it wrote anything. Every command that reads them calls it first.
 */
export function migrateConfig(listen: ListenPaths): void {
  if (migrateLegacyFiles(listen))
    err(
      fmt(
        _(
          'The users, profiles and tasks of tasks.json were copied to {dir}, one file or directory each. tasks.json is not read any more and not changed; edit the new files.',
        ),
        { dir: dirname(listen.usersFile) },
      ),
    );
}

/** Migrate, then read users.json and profiles.json. Prints why and sets the exit code when it cannot. */
export function readConfig(listen: ListenPaths): LoadedConfig | null {
  try {
    migrateConfig(listen);
    const loaded = loadConfig(listen);
    if (loaded.warning) err(fmt(_('  {warning}'), { warning: loaded.warning }));
    return loaded;
  } catch (error) {
    if (!(error instanceof ConfigMissingError || error instanceof ConfigFileError)) throw error;
    err(error instanceof ConfigFileError ? `${error.file}: ${error.message}` : error.message);
    process.exitCode = 1;
    return null;
  }
}

/** Every profile's agent, resolved once at start: a launcher that is missing stops `listen` before any run. */
function agentsFor(paths: LotsePaths, loaded: LoadedConfig): Map<string, AgentCommand> | null {
  const commands = new Map<string, AgentCommand>();
  for (const profile of loaded.profiles) {
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
  readonly loaded: LoadedConfig;
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
    users: options.loaded.users,
    profiles: options.loaded.profiles,
    open: options.open,
    commandFor: (profile) => {
      const command = commands.get(profile.id);
      if (!command) throw new Error(`profile "${profile.id}" has no resolved agent`);
      return command;
    },
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
