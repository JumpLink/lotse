import { describe, expect, it } from '@gjsify/unit';

import { dueTasks, parseServeConfig, type ServeConfig, type ServeDeps } from '@lotse/core';

import { createReloader, liveDeps } from '../../../src/frontends/cli/serve-reload.ts';
import type { LoadedTasks } from '../../../src/core/serve-config.ts';

const NOW = new Date('2026-10-10T12:00:00.000Z');

function config(tasks: Record<string, unknown>[]): ServeConfig {
  return parseServeConfig(
    JSON.stringify({
      version: 1,
      users: [{ id: 'me' }],
      profiles: [{ id: 'p', user: 'me', data: 'public' }],
      tasks: tasks.map((task) => ({ profile: 'p', prompt: 'Go.', cwd: '/fixture', ...task })),
    }),
  );
}

function loaded(tasks: Record<string, unknown>[], hash: string): LoadedTasks {
  return {
    config: config(tasks),
    hash,
    warning: null,
    promptFor: () => 'Go.',
    precheckPromptFor: () => '',
  };
}

/** A task file that is a variable: `file.hash` is what is "on disk", `file.tasks` what it parses to. */
function fixture(initial: Record<string, unknown>[]) {
  const file = { hash: 'h1', tasks: initial as Record<string, unknown>[] | 'invalid' };
  const logged: string[] = [];
  const build = (next: LoadedTasks): ServeDeps =>
    ({
      config: next.config,
      log: (entry: { event: string }) => logged.push(entry.event),
    }) as unknown as ServeDeps;
  const first = loaded(initial, 'h1');
  const reloader = createReloader(
    {
      tasksFile: '/fixture/tasks.json',
      load: () => {
        if (file.tasks === 'invalid') throw new Error('tasks[0].schedule: needs "every" or "at"');
        return loaded(file.tasks, file.hash);
      },
      hashNow: () => file.hash,
      build,
    },
    { loaded: first, deps: build(first) },
  );
  return { file, reloader, logged };
}

const EVERY = { id: 'a', schedule: { every: '1h' } };

export default async () => {
  await describe('serve reload', async () => {
    await it('reports nothing while the file is unchanged', async () => {
      const { reloader } = fixture([EVERY]);
      expect(reloader.check().kind).toBe('unchanged');
    });

    await it('applies an edit in place and says what changed', async () => {
      const { file, reloader } = fixture([EVERY, { id: 'gone', schedule: { every: '2h' } }]);
      file.hash = 'h2';
      file.tasks = [
        { ...EVERY, schedule: { every: '30m' } },
        { id: 'new', schedule: { every: '3h' } },
      ];
      const result = reloader.check();
      expect(result).toStrictEqual({ kind: 'reloaded', added: ['new'], removed: ['gone'], changed: ['a'] });
      expect(reloader.current().deps.config.tasks.map((task) => task.id)).toStrictEqual(['a', 'new']);
      expect(reloader.check().kind).toBe('unchanged');
    });

    await it('lets a run that started keep its definition, and starts the next one on the new', async () => {
      const { file, reloader } = fixture([{ ...EVERY, prompt: 'old' }]);
      const startedWith = reloader.current().deps;
      file.hash = 'h2';
      file.tasks = [{ ...EVERY, prompt: 'new' }];
      reloader.check();
      expect(startedWith.config.tasks[0]!.prompt).toBe('old');
      expect(reloader.current().deps.config.tasks[0]!.prompt).toBe('new');
      expect(reloader.current().deps).not.toBe(startedWith);
    });

    await it('does not start a removed task again', async () => {
      const { file, reloader } = fixture([EVERY, { id: 'b', schedule: { every: '1h' } }]);
      file.hash = 'h2';
      file.tasks = [{ id: 'b', schedule: { every: '1h' } }];
      reloader.check();
      const due = dueTasks(reloader.current().deps.config, () => null, new Set(['a']), NOW);
      expect(due.map((task) => task.id)).toStrictEqual(['b']);
    });

    await it('keeps the previous tasks when the file is invalid, and reports it once', async () => {
      const { file, reloader } = fixture([EVERY]);
      const before = reloader.current().deps;
      file.hash = 'h2';
      file.tasks = 'invalid';
      const first = reloader.check();
      expect(first.kind).toBe('rejected');
      expect(first.kind === 'rejected' ? first.message : '').toContain('needs "every" or "at"');
      expect(reloader.current().deps).toBe(before);
      expect(reloader.check().kind).toBe('unchanged');
    });

    await it('recovers when the file becomes valid again', async () => {
      const { file, reloader } = fixture([EVERY]);
      file.hash = 'h2';
      file.tasks = 'invalid';
      reloader.check();
      file.hash = 'h3';
      file.tasks = [{ id: 'fixed', schedule: { every: '1h' } }];
      expect(reloader.check().kind).toBe('reloaded');
      expect(reloader.current().deps.config.tasks[0]!.id).toBe('fixed');
    });

    await it('keeps the previous tasks when the deps cannot be built', async () => {
      const first = loaded([EVERY], 'h1');
      const deps = { config: first.config } as unknown as ServeDeps;
      const reloader = createReloader(
        {
          tasksFile: '/fixture/tasks.json',
          load: () => loaded([{ id: 'x', schedule: { every: '1h' } }], 'h2'),
          hashNow: () => 'h2',
          build: () => null,
        },
        { loaded: first, deps },
      );
      expect(reloader.check().kind).toBe('rejected');
      expect(reloader.current().deps).toBe(deps);
    });

    await it('does not fire a time-of-day task that has never run just because of the reload', async () => {
      const { file, reloader } = fixture([EVERY]);
      file.hash = 'h2';
      file.tasks = [EVERY, { id: 'morning', schedule: { at: '07:30' } }];
      reloader.check();
      const due = dueTasks(reloader.current().deps.config, (id) => (id === 'a' ? NOW : null), new Set(), NOW);
      expect(due.map((task) => task.id)).toStrictEqual([]);
    });

    await it('reads through a live view to whatever the current deps are', async () => {
      const { file, reloader } = fixture([EVERY]);
      const live = liveDeps(() => reloader.current().deps);
      expect(live.config.tasks.length).toBe(1);
      file.hash = 'h2';
      file.tasks = [EVERY, { id: 'b', schedule: { every: '1h' } }];
      reloader.check();
      expect(live.config.tasks.length).toBe(2);
    });
  });
};
