import { parseProfiles, parseUsers, type Profile, type SkillTask, type User } from '@lotse/core';

/** What a run reads from the config: the users, the profiles and the one task `t`. */
export interface Fixture {
  readonly users: readonly User[];
  readonly profiles: readonly Profile[];
  readonly skill: (id: string) => SkillTask | null;
}

/**
 * A synthetic config: user `me`, profile `p` (public, owned by `me`) and the task `t` on it.
 * `profile` and `task` patch the two; `extraProfiles` adds more profiles.
 */
export function fixture(
  patch: {
    profile?: Record<string, unknown>;
    task?: Partial<SkillTask>;
    /** More tasks, each with the same defaults as `t`. */
    tasks?: Partial<SkillTask>[];
    extraProfiles?: Record<string, unknown>[];
  } = {},
): Fixture {
  const make = (patch: Partial<SkillTask>): SkillTask => ({
    id: 't',
    description: '',
    allowedTools: null,
    profile: 'p',
    rights: 'confirm',
    params: [],
    precheck: null,
    personNeeded: { enabled: false, timeoutMin: null },
    cwd: '/fixture',
    body: 'Do the thing.',
    ...patch,
  });
  const tasks = [make({ ...patch.task }), ...(patch.tasks ?? []).map(make)];
  return {
    users: parseUsers(JSON.stringify({ version: 1, users: [{ id: 'me' }] })),
    profiles: parseProfiles(
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'p', user: 'me', data: 'public', ...patch.profile }, ...(patch.extraProfiles ?? [])],
      }),
    ),
    skill: (id) => tasks.find((task) => task.id === id) ?? null,
  };
}
