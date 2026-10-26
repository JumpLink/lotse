/**
 * The session a run or an answer talks to: continuing one, pinning the profile's model and options,
 * and the one retry when the agent has not offered the model yet.
 */

import {
  ERROR_CODES,
  RpcError,
  UnsupportedCapabilityError,
  type AcpClient,
  type McpServer,
  type SessionConfigOption,
} from '@lotse/acp';

import { projectConfigOptions } from '../config.ts';
import { applyConfigOptions } from '../profile/apply.ts';
import type { Profile } from '../profile/profile.ts';
import { resolveProfile, type ProfileSession } from '../profile/resolve.ts';
import { withAuthHint, type AgentHandle } from '../run.ts';
import type { Task } from './task.ts';
import { ModelUnavailableError, type RunDeps } from './deps.ts';

const DEFAULT_MODEL_RETRY_MS = 15_000;

/** `session/load`, else `session/resume`; `null` when the agent offers neither. */
export async function continueSession(
  client: AcpClient,
  cwd: string,
  sessionId: string,
  servers: readonly McpServer[],
  extra: readonly McpServer[],
): Promise<{ how: 'loaded' | 'resumed'; configOptions: SessionConfigOption[] | null } | null> {
  const params = { cwd, mcpServers: [...servers, ...extra] };
  if (client.supportsLoadSession) {
    try {
      const loaded = await withAuthHint('session/load', () => client.loadSession({ sessionId, ...params }));
      return { how: 'loaded', configOptions: loaded.configOptions ?? null };
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
  }
  if (client.supportsResumeSession) {
    try {
      const resumed = await withAuthHint('session/resume', () =>
        client.resumeSession({ sessionId, ...params }),
      );
      return { how: 'resumed', configOptions: resumed.configOptions ?? null };
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
  }
  return null;
}

export function isUnsupported(error: unknown): boolean {
  return (
    error instanceof UnsupportedCapabilityError ||
    (error instanceof RpcError && error.code === ERROR_CODES.METHOD_NOT_FOUND)
  );
}

/**
 * The agent may refresh its model list while a session starts, so a model it offers can be missing
 * for a moment. Close this agent and wait; the caller opens a fresh session with the SAME model —
 * still no fallback (ADR 0002 §5).
 */
export async function retryAfterUnavailable(
  task: Task,
  deps: RunDeps,
  handle: AgentHandle,
  phase: 'run' | 'precheck',
): Promise<void> {
  deps.log?.({ event: 'retry', task: task.id, detail: { kind: 'ModelUnavailableError', phase } });
  await handle.close();
  await deps.sleep(deps.modelRetryMs ?? DEFAULT_MODEL_RETRY_MS);
}

/** The profile resolved for this run; the launcher is the app's, found by `commandFor`. */
export function sessionOf(deps: RunDeps, profile: Profile): ProfileSession {
  return resolveProfile(profile, { agent: () => deps.commandFor(profile) });
}

/**
 * The servers a turn's new or continued session gets. The task's own list replaces the profile's —
 * a task that names servers has decided which tools it gets.
 */
export function serversFor(task: Task, profile: ProfileSession): McpServer[] {
  return [...(task.mcpServers.length > 0 ? task.mcpServers : profile.mcpServers)];
}

/** The profile's model, then its other options, on a session that just started. */
export async function pinSession(
  client: AcpClient,
  sessionId: string,
  options: SessionConfigOption[] | null,
  profile: ProfileSession,
): Promise<void> {
  let current = options;
  if (profile.model) current = await pinModel(client, sessionId, current, profile.model);
  if (Object.keys(profile.configOptions).length > 0) {
    await applyConfigOptions(client, sessionId, current, profile.configOptions);
  }
}

export async function pinModel(
  client: AcpClient,
  sessionId: string,
  options: SessionConfigOption[] | null,
  model: string,
): Promise<SessionConfigOption[] | null> {
  const control = projectConfigOptions(options).find((candidate) => candidate.category === 'model');
  if (!control || control.kind !== 'select' || !control.values.some((value) => value.value === model)) {
    throw new ModelUnavailableError(model);
  }
  if (control.currentValue === model) return options;
  const answer = await client.setConfigOption({ sessionId, configId: control.id, value: model });
  return (
    answer.configOptions ??
    (options ?? []).map((option) => (option.id === control.id ? { ...option, currentValue: model } : option))
  );
}
