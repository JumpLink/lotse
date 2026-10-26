import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacy, parseProfiles, parseUsers } from '@lotse/core';

import { ConfigMissingError, loadConfig } from '../../../src/core/config-files.ts';
import { migrateLegacyFiles } from '../../../src/core/legacy-migration.ts';
import { readSkill } from '../../../src/core/skills.ts';
import { listenPaths } from '../../../src/core/paths.ts';

const LEGACY = JSON.stringify({
  version: 1,
  users: [{ id: 'me' }],
  profiles: [
    {
      id: 'work',
      user: 'me',
      model: 'provider/model',
      data: 'private',
      channels: ['desktop'],
      messengerDetail: 'notice',
    },
  ],
  tasks: [{ id: 'legacy', profile: 'work', prompt: 'Do the thing.', cwd: '/fixture', rights: 'released' }],
});

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-legacy-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pathsIn = (dir: string) => listenPaths({ XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, 'state') });

export default async () => {
  await describe('migrateLegacy', async () => {
    await it('derives users, profiles and one skill, carrying user and delivery over', async () => {
      const migration = migrateLegacy(LEGACY, () => null);
      expect(parseUsers(migration.users!)[0]!.id).toBe('me');
      const profile = parseProfiles(migration.profiles!)[0]!;
      expect(profile.model).toBe('provider/model');
      expect(profile.user).toBe('me');
      expect(profile.channels).toStrictEqual(['desktop']);
      expect(profile.messengerDetail).toBe('notice');
      expect(migration.skills.map((skill) => skill.id)).toStrictEqual(['legacy']);
      expect(migration.skills[0]!.text).toContain('Do the thing.');
    });

    await it('carries over nothing from text that is not usable', async () => {
      expect(migrateLegacy('{', () => null)).toStrictEqual({ users: null, profiles: null, skills: [] });
      expect(migrateLegacy('{"version":1}', () => null).skills.length).toBe(0);
    });
  });

  await describe('migrateLegacyFiles', async () => {
    await it('writes the new files once and leaves tasks.json alone', async () => {
      withDir((dir) => {
        const listen = pathsIn(dir);
        const before = LEGACY;
        mkdirSync(join(dir, 'lotse'), { recursive: true });
        writeFileSync(listen.tasksFile, before);
        expect(migrateLegacyFiles(listen)).toBe(true);
        expect(parseUsers(readFileSync(listen.usersFile, 'utf8'))[0]!.id).toBe('me');
        expect(parseProfiles(readFileSync(listen.profilesFile, 'utf8'))[0]!.id).toBe('work');
        expect(readSkill(listen.tasksDir, 'legacy')!.body).toBe('Do the thing.');
        expect(readFileSync(listen.tasksFile, 'utf8')).toBe(before);
        expect(migrateLegacyFiles(listen)).toBe(false);
        expect(readFileSync(listen.tasksFile, 'utf8')).toBe(before);
      });
    });

    await it('never overwrites a file or a task directory that exists', async () => {
      withDir((dir) => {
        const listen = pathsIn(dir);
        mkdirSync(join(listen.tasksDir, 'legacy'), { recursive: true });
        writeFileSync(join(listen.tasksDir, 'legacy', 'mine'), 'mine');
        writeFileSync(listen.usersFile, 'mine');
        writeFileSync(listen.tasksFile, LEGACY);
        migrateLegacyFiles(listen);
        expect(readFileSync(listen.usersFile, 'utf8')).toBe('mine');
        expect(existsSync(join(listen.tasksDir, 'legacy', 'SKILL.md'))).toBe(false);
        expect(existsSync(listen.profilesFile)).toBe(true);
      });
    });

    await it('writes nothing without a tasks.json', async () => {
      withDir((dir) => {
        const listen = pathsIn(dir);
        expect(migrateLegacyFiles(listen)).toBe(false);
        expect(existsSync(listen.usersFile)).toBe(false);
        expect(existsSync(listen.profilesFile)).toBe(false);
      });
    });
  });

  await describe('loadConfig', async () => {
    await it('starts from users.json and profiles.json with no tasks.json anywhere', async () => {
      withDir((dir) => {
        const listen = pathsIn(dir);
        mkdirSync(join(dir, 'lotse'), { recursive: true });
        writeFileSync(listen.usersFile, JSON.stringify({ version: 1, users: [{ id: 'me' }] }), {
          mode: 0o600,
        });
        writeFileSync(
          listen.profilesFile,
          JSON.stringify({ version: 1, profiles: [{ id: 'p', data: 'public' }] }),
          { mode: 0o600 },
        );
        expect(existsSync(listen.tasksFile)).toBe(false);
        const loaded = loadConfig(listen);
        expect(loaded.users.length).toBe(1);
        expect(loaded.profiles.length).toBe(1);
        expect(loaded.warning).toBe(null);
      });
    });

    await it('says which files are missing', async () => {
      withDir((dir) => {
        let caught: unknown = null;
        try {
          loadConfig(pathsIn(dir));
        } catch (error) {
          caught = error;
        }
        expect(caught instanceof ConfigMissingError).toBe(true);
      });
    });
  });
};
