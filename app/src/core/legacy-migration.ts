/**
 * The one-shot move out of a legacy tasks.json (ADR 0007): users.json, profiles.json and one
 * `tasks/<id>/SKILL.md` each, derived by core's `migrateLegacy`.
 *
 * Only a target that is missing is written, so running it again changes nothing, and tasks.json is
 * only ever read — never changed, never deleted. After this nothing reads it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { isId, migrateLegacy } from '@lotse/core';

import type { ListenPaths } from './paths.ts';
import { ensureDir, writePrivateFile } from './private-file.ts';

/** A prompt file is resolved relative to the tasks.json that names it. */
export function promptPath(tasksFile: string, promptFile: string): string {
  return isAbsolute(promptFile) ? promptFile : join(dirname(tasksFile), promptFile);
}

/** `true` when it wrote at least one file, so the caller says so once. */
export function migrateLegacyFiles(listen: ListenPaths): boolean {
  const needsUsers = !existsSync(listen.usersFile);
  const needsProfiles = !existsSync(listen.profilesFile);
  if (!existsSync(listen.tasksFile)) return false;
  const migration = migrateLegacy(readFileSync(listen.tasksFile, 'utf8'), (file) => {
    try {
      return readFileSync(promptPath(listen.tasksFile, file), 'utf8');
    } catch {
      return null;
    }
  });
  let wrote = false;
  if (needsUsers && migration.users !== null) {
    writePrivateFile(listen.usersFile, migration.users, 'users');
    wrote = true;
  }
  if (needsProfiles && migration.profiles !== null) {
    writePrivateFile(listen.profilesFile, migration.profiles, 'profiles');
    wrote = true;
  }
  for (const skill of migration.skills) {
    const dir = join(listen.tasksDir, skill.id);
    if (!isId(skill.id) || existsSync(dir)) continue;
    ensureDir(dir);
    writePrivateFile(join(dir, 'SKILL.md'), skill.text, 'skill');
    wrote = true;
  }
  return wrote;
}
