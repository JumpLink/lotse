import { runTask, type RunResult, type RunDeps, type ServeTask } from '@lotse/core';

/** Runs a configured task through `runTask` and returns the run it recorded. */
export async function runConfigured(task: ServeTask, deps: RunDeps): Promise<RunResult> {
  let recorded: RunResult | null = null;
  await runTask(task.id, {}, { ...deps, record: (result) => void (recorded = result) });
  if (!recorded) throw new Error('runTask recorded no run');
  return recorded;
}
