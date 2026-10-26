import { runTask, type RunResult, type RunDeps } from '@lotse/core';

/** Runs the configured task `t` through `runTask` and returns the run it recorded. */
export async function runConfigured(deps: RunDeps, id = 't'): Promise<RunResult> {
  let recorded: RunResult | null = null;
  await runTask(id, {}, { ...deps, record: (result) => void (recorded = result) });
  if (!recorded) throw new Error('runTask recorded no run');
  return recorded;
}
