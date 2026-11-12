/**
 * Where lotsman keeps things — this app's answer, resolved from the environment.
 *
 * The one promise: **nothing is ever written inside the repository.** A session file holds the text
 * of a person's conversations with an agent, and this repository is public — a stray session file
 * would be a permanent leak. `.gitignore` is the second line of defence; not writing there is the
 * first, and it lives here.
 *
 * Every function takes the environment as an argument, so a test says "with `XDG_DATA_HOME` set to
 * this" instead of mutating the world to find out where the code writes.
 *
 * The `LotsmanPaths` shape itself, and `lotsmanPathsUnder(root)` for a host that hands lotsman a
 * directory, are in `@lotsman/core`: core takes the paths and never resolves them, and XDG plus the
 * `LOTSMAN_*` overrides are a decision only an app gets to make.
 *
 * Every override is read with `envKnob`, so the `LOTSMAN_*` name a machine was set up with before
 * the rename still works and the `LOTSMAN_*` one wins.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { envKnob, type LotsmanPaths } from '@lotsman/core';

/** `$XDG_DATA_HOME`, or the XDG default. An explicit value must be absolute, per the spec. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['XDG_DATA_HOME']?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.local', 'share');
}

/** The per-user data directory. `LOTSMAN_DATA_DIR` overrides it — for a test, or a second install. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return envKnob(env, 'DATA_DIR') || join(xdgDataHome(env), 'lotsman');
}

/**
 * The session file. Mode `0600`, in a `0700` directory — set explicitly by the store, not
 * inherited from an umask that belongs to whoever started the process.
 */
export function sessionsFile(env: NodeJS.ProcessEnv = process.env): string {
  return envKnob(env, 'SESSIONS_FILE') || join(dataDir(env), 'sessions.json');
}

/** `$XDG_CONFIG_HOME`, or the XDG default. An explicit value must be absolute, per the spec. */
export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['XDG_CONFIG_HOME']?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.config');
}

/** The per-user config directory. Named here rather than inlined, because the migration moves it. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdgConfigHome(env), 'lotsman');
}

/**
 * The settings file: a preference, so config rather than data. Mode `0600` in a `0700` directory, like
 * the session file, though it holds no credential and no conversation (`core/settings.ts`).
 */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return envKnob(env, 'SETTINGS_FILE') || join(configDir(env), 'settings.json');
}

/**
 * The dismissed-notices file: ids only, in the data directory. `LOTSMAN_NOTICES_FILE` overrides it.
 */
export function noticesFile(env: NodeJS.ProcessEnv = process.env): string {
  return envKnob(env, 'NOTICES_FILE') || join(dataDir(env), 'notices.json');
}

/** `$XDG_STATE_HOME`, or the XDG default. An explicit value must be absolute, per the spec. */
export function xdgStateHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['XDG_STATE_HOME']?.trim();
  return explicit && explicit.startsWith('/') ? explicit : join(homedir(), '.local', 'state');
}

/** Where `lotsman listen` keeps its question store, run state, action log and locks (ADR 0003 §7). */
export interface ListenPaths {
  readonly stateDir: string;
  /** The people `listen` works for: private, outside the repository, read once at start. */
  readonly usersFile: string;
  /** The profiles every host shares (ADR 0007), read once at start. */
  readonly profilesFile: string;
  /** The legacy file users, profiles and tasks used to share. Only the one-shot migration reads it. */
  readonly tasksFile: string;
  /** One directory per task, each with a SKILL.md (ADR 0007 §6). */
  readonly tasksDir: string;
}

/** `LOTSMAN_STATE_DIR`, `LOTSMAN_USERS_FILE`, `LOTSMAN_PROFILES_FILE`, `LOTSMAN_TASKS_DIR` and `LOTSMAN_TASKS_FILE` (the legacy file) override the XDG defaults. */
export function listenPaths(env: NodeJS.ProcessEnv = process.env): ListenPaths {
  return {
    stateDir: envKnob(env, 'STATE_DIR') || join(xdgStateHome(env), 'lotsman'),
    usersFile: envKnob(env, 'USERS_FILE') || join(configDir(env), 'users.json'),
    profilesFile: envKnob(env, 'PROFILES_FILE') || join(configDir(env), 'profiles.json'),
    tasksDir: envKnob(env, 'TASKS_DIR') || join(configDir(env), 'tasks'),
    tasksFile: envKnob(env, 'TASKS_FILE') || join(configDir(env), 'tasks.json'),
  };
}

/** The app's defaults: XDG, with the `LOTSMAN_*` overrides, exactly as the functions above resolve them. */
export function lotsmanPaths(env: NodeJS.ProcessEnv = process.env): LotsmanPaths {
  return {
    dataDir: dataDir(env),
    configDir: configDir(env),
    sessionsFile: sessionsFile(env),
    settingsFile: settingsFile(env),
    noticesFile: noticesFile(env),
  };
}
