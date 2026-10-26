/**
 * Applying an edited task file to a running `listen` (docs/listen.md, "Editing the task file").
 *
 * The file is looked at once per pass. A change that parses becomes the new configuration for every
 * run that STARTS afterwards; a run already going keeps the `ServeDeps` it was handed, which is what
 * lets it finish with the definition it started with. A change that does not parse is reported and
 * ignored, and the previous configuration stays in force until the file is valid again.
 */

import type { ServeConfig, ServeDeps } from '@lotse/core';

import type { LoadedTasks } from '../../core/serve-config.ts';

export type ReloadResult =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'reloaded';
      readonly added: string[];
      readonly removed: string[];
      readonly changed: string[];
    }
  | { readonly kind: 'rejected'; readonly message: string };

export interface ReloaderOptions {
  readonly tasksFile: string;
  /** Parse the file and its prompt files. Throws when it cannot. */
  readonly load: (tasksFile: string) => LoadedTasks;
  /** The hash as the file is now, for `config`'s prompt files; `null` when something cannot be read. */
  readonly hashNow: (tasksFile: string, config: ServeConfig) => string | null;
  /** The deps for a loaded configuration; `null` when they cannot be built (an agent is missing). */
  readonly build: (loaded: LoadedTasks) => ServeDeps | null;
}

export interface Reloader {
  /** The configuration new runs start with. A run keeps the object it was started with. */
  current(): { readonly loaded: LoadedTasks; readonly deps: ServeDeps };
  check(): ReloadResult;
}

/** Ids whose task text differs between two configurations, by structure rather than by object. */
function diffTasks(before: ServeConfig, after: ServeConfig) {
  const old = new Map(before.tasks.map((task) => [task.id, JSON.stringify(task)]));
  const next = new Map(after.tasks.map((task) => [task.id, JSON.stringify(task)]));
  return {
    added: [...next.keys()].filter((id) => !old.has(id)),
    removed: [...old.keys()].filter((id) => !next.has(id)),
    changed: [...next.keys()].filter((id) => old.has(id) && old.get(id) !== next.get(id)),
  };
}

export function createReloader(
  options: ReloaderOptions,
  initial: { readonly loaded: LoadedTasks; readonly deps: ServeDeps },
): Reloader {
  let state = initial;
  // The state of the file we already refused, so one bad save is reported once, not once per pass.
  let refused: string | null = null;
  return {
    current: () => state,
    check() {
      const now = options.hashNow(options.tasksFile, state.loaded.config);
      if (now !== null && now === state.loaded.hash) {
        refused = null;
        return { kind: 'unchanged' };
      }
      if (refused === (now ?? '')) return { kind: 'unchanged' };
      try {
        const loaded = options.load(options.tasksFile);
        const deps = options.build(loaded);
        if (!deps) throw new Error('the agent for a profile could not be resolved');
        const result = { kind: 'reloaded' as const, ...diffTasks(state.loaded.config, loaded.config) };
        state = { loaded, deps };
        refused = null;
        return result;
      } catch (error) {
        refused = now ?? '';
        return { kind: 'rejected', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** An object that always reads through to the current deps, for the parts that outlive a reload. */
export function liveDeps(current: () => ServeDeps): ServeDeps {
  return new Proxy({} as ServeDeps, { get: (_target, key) => Reflect.get(current(), key) });
}
