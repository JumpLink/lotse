/** The precheck of a task: one read-only turn that decides whether the task has anything to do. */

import type { AcpClient } from '@lotse/acp';

import { chunkToText } from '../policy.ts';
import { userOf } from '../questions/ask.ts';
import { runTurn, withAuthHint, type AgentHandle } from '../run.ts';
import { profileOf, type ServeProfile, type ServeTask } from './config.ts';
import { ModelUnavailableError, type PrecheckVerdict, type RunDeps } from './deps.ts';
import { taskGate, type GateDecision } from './gate.ts';
import { pinSession, retryAfterUnavailable, sessionOf } from './session.ts';

/**
 * The precheck's verdict: the message's last non-empty line, without markdown emphasis or a full
 * stop, is `WORK` or `NOTHING`. Anything else is `null` — no verdict, and the task does not run.
 */
export function parseVerdict(message: string): PrecheckVerdict | null {
  const last = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const word = last?.replace(/[*_`.!:\s]/g, '').toUpperCase();
  return word === 'WORK' ? 'work' : word === 'NOTHING' ? 'nothing' : null;
}

/**
 * The precheck's prompt with the task's last run in front of it: the agent cannot read `runs.json`,
 * and "newer than the last run" is the question most prechecks ask. The prompt stays last, so its
 * closing instruction about the verdict line stays last too.
 */
export function precheckText(
  prompt: string,
  previous: { readonly startedAt: string; readonly outcome: string } | null,
): string {
  const context = previous
    ? `Last run of this task: ${previous.startedAt} (outcome: ${previous.outcome}).`
    : 'This task has not run before.';
  return `${context}\n\n${prompt}`;
}

/**
 * One turn that decides whether the task has anything to do. It sees the task's `mcpServers` and a
 * gate with `read` rights, so every permission request is declined without a question, and it never
 * creates a question of its own. Its model is its own profile's, or none (the agent's default).
 */
export async function runPrecheck(
  task: ServeTask,
  deps: RunDeps,
): Promise<{ verdict: PrecheckVerdict | null; sessionId: string | null; reason: string | null }> {
  const check = task.precheck!;
  const taskProfile = profileOf(deps.config, task);
  const named = check.profile
    ? deps.config.profiles.find((candidate) => candidate.id === check.profile)
    : null;
  const profile: ServeProfile = named ?? { ...taskProfile, model: null };
  const resolved = sessionOf(deps, profile);
  const user = userOf(deps.config, taskProfile);
  let handle: AgentHandle | null = null;
  let sessionId: string | null = null;
  const gate = taskGate({
    rights: 'read',
    released: [],
    now: () => deps.now().getTime(),
    ask: async () => 'refused',
    onDecision: (decision: GateDecision) =>
      deps.log?.({
        event: 'gate',
        task: task.id,
        detail: {
          session: decision.sessionId,
          tool: decision.tool,
          answer: decision.answer,
          why: 'precheck',
        },
      }),
  });
  deps.log?.({ event: 'precheck', task: task.id, detail: { phase: 'start', profile: profile.id } });
  try {
    let session!: Awaited<ReturnType<AcpClient['newSession']>>;
    for (let attempt = 0; ; attempt += 1) {
      handle = await deps.open({
        command: resolved.command,
        gate: { permission: gate },
        ...(deps.onAgentLog ? { onLog: deps.onAgentLog } : {}),
      });
      // Only the task's own servers: the precheck stays read-only, so it inherits nothing from a profile.
      session = await withAuthHint('session/new', () =>
        handle!.client.newSession({ cwd: task.cwd, mcpServers: [...task.mcpServers] }),
      );
      sessionId = session.sessionId;
      try {
        await pinSession(handle.client, session.sessionId, session.configOptions ?? null, resolved);
        break;
      } catch (error) {
        if (!(error instanceof ModelUnavailableError) || attempt > 0) throw error;
        await retryAfterUnavailable(task, deps, handle, 'precheck');
        handle = null;
        sessionId = null;
      }
    }
    const agentClient = handle!.client;
    let message = '';
    const { stopReason } = await runTurn(agentClient, {
      sessionId: session.sessionId,
      text: precheckText(
        deps.precheckPromptFor ? deps.precheckPromptFor(task) : (check.prompt ?? ''),
        deps.previousRun?.(task.id) ?? null,
      ),
      onUpdate: (notification) => {
        if (notification.update.sessionUpdate === 'agent_message_chunk')
          message += chunkToText(notification.update.content);
      },
    });
    const verdict = stopReason === 'end_turn' ? parseVerdict(message) : null;
    deps.log?.({
      event: 'precheck',
      task: task.id,
      detail: { phase: 'end', session: session.sessionId, stopReason, verdict: verdict ?? 'none' },
    });
    return {
      verdict,
      sessionId,
      reason:
        verdict === 'nothing'
          ? 'the precheck found nothing new'
          : verdict === null
            ? `the precheck ended without a WORK or NOTHING line (${stopReason}); the task did not run`
            : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.({
      event: 'error',
      task: task.id,
      detail: { phase: 'precheck', kind: error instanceof Error ? error.name : 'Error' },
    });
    if (error instanceof ModelUnavailableError) {
      await deps.channel.send(user, {
        title: `lotse · ${task.id} precheck stopped`,
        body: reason,
        questionId: null,
        task: task.id,
      });
    }
    return { verdict: null, sessionId, reason: `the precheck failed: ${reason}` };
  } finally {
    await handle?.close();
  }
}
