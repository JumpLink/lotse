/**
 * Reading users.json and profiles.json for `lotse listen`, once, at start. Editing either takes
 * effect on a restart the person performs, never under a run that is already going (ADR 0002 §3).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  parseProfiles,
  parseUsers,
  ProfilesError,
  UsersError,
  userProblems,
  type Profile,
  type User,
} from '@lotse/core';

import type { ListenPaths } from './paths.ts';

export interface LoadedConfig {
  readonly users: readonly User[];
  readonly profiles: readonly Profile[];
  /** Present when a file can be read by someone other than its owner. */
  readonly warning: string | null;
}

export class ConfigMissingError extends Error {
  constructor(files: readonly string[]) {
    super(
      `there is no configuration at ${files.join(' and ')}. Copy examples/users.example.json and ` +
        'examples/profiles.example.json there, fill them in, and `chmod 600` them — docs/listen.md ' +
        'describes every field.',
    );
    this.name = 'ConfigMissingError';
  }
}

/** The file that could not be read, so the message can name it. */
export class ConfigFileError extends Error {
  readonly file: string;

  constructor(file: string, cause: Error) {
    super(cause.message, { cause });
    this.name = 'ConfigFileError';
    this.file = file;
  }
}

function parsed<T>(file: string, parse: (text: string) => T): T {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw error instanceof UsersError || error instanceof ProfilesError
      ? new ConfigFileError(file, error)
      : error;
  }
}

/** Throws `ConfigMissingError` or `ConfigFileError`. */
export function loadConfig(listen: ListenPaths): LoadedConfig {
  const missing = [listen.usersFile, listen.profilesFile].filter((file) => !existsSync(file));
  if (missing.length > 0) throw new ConfigMissingError(missing);
  const users = parsed(listen.usersFile, parseUsers);
  const profiles = parsed(listen.profilesFile, parseProfiles);
  const problems = userProblems(users, profiles);
  if (problems.length > 0) throw new ConfigFileError(listen.profilesFile, new UsersError(problems));
  const loose = [listen.usersFile, listen.profilesFile].find((file) => (statSync(file).mode & 0o077) !== 0);
  return {
    users,
    profiles,
    warning:
      loose === undefined
        ? null
        : `${loose} is readable by others (mode ${(statSync(loose).mode & 0o777).toString(8)}); \`chmod 600\` it`,
  };
}
