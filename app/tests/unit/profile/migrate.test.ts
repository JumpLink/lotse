import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProfiles } from '@lotse/core';

import { migrateProfiles } from '../../../src/core/serve-config.ts';

const TASKS = JSON.stringify({
  version: 1,
  users: [{ id: 'me' }],
  profiles: [{ id: 'work', user: 'me', model: 'provider/model', data: 'private' }],
  tasks: [],
});

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-profiles-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('migrateProfiles', async () => {
    await it('writes profiles.json once and leaves tasks.json alone', async () => {
      withDir((dir) => {
        const tasks = join(dir, 'tasks.json');
        const profiles = join(dir, 'profiles.json');
        writeFileSync(tasks, TASKS);
        expect(migrateProfiles(tasks, profiles)).toBe(true);
        expect(parseProfiles(readFileSync(profiles, 'utf8'))[0]!.model).toBe('provider/model');
        expect(readFileSync(tasks, 'utf8')).toBe(TASKS);
        expect(migrateProfiles(tasks, profiles)).toBe(false);
      });
    });

    await it('never overwrites an existing profiles.json', async () => {
      withDir((dir) => {
        const tasks = join(dir, 'tasks.json');
        const profiles = join(dir, 'profiles.json');
        writeFileSync(tasks, TASKS);
        writeFileSync(profiles, 'mine');
        expect(migrateProfiles(tasks, profiles)).toBe(false);
        expect(readFileSync(profiles, 'utf8')).toBe('mine');
      });
    });

    await it('writes nothing without a tasks.json or without profiles in it', async () => {
      withDir((dir) => {
        const profiles = join(dir, 'profiles.json');
        expect(migrateProfiles(join(dir, 'tasks.json'), profiles)).toBe(false);
        writeFileSync(join(dir, 'tasks.json'), '{"version":1}');
        expect(migrateProfiles(join(dir, 'tasks.json'), profiles)).toBe(false);
        expect(existsSync(profiles)).toBe(false);
      });
    });
  });
};
