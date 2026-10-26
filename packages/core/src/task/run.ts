/**
 * One run of a task — ADR 0003 — and `runSession`, the part a run, an answer and a chat request share.
 *
 * **Two processes share the question store.** `lotse listen` holds a permission request open and polls
 * the store until the question is answered or expires; `lotse answer` is a second process that writes
 * the answer. That is why a waiting run reads the store rather than a variable, and why a permission
 * question whose run is gone is marked `cancelled` — a yes to it then has nothing to allow and is
 * dropped (ADR 0002 §8), instead of being applied to a session it was never about.
 */

import type { AcpClient, McpServer, SessionConfigOption, StopReason } from '@lotse/acp';

import { chunkToText } from '../policy.ts';
import { ProfileOptionError } from '../profile/apply.ts';
import { narrowRights, profileOf, withPreamble, type ProfileSession } from '../profile/resolve.ts';
import {
  ask,
  cancelHeldQuestions,
  ceilingReached,
  createReplyQuestion,
  personNeeded,
} from '../questions/ask.ts';
import { isQuestionText } from '../questions/question.ts';
import { runTurn, withAuthHint, type AgentHandle } from '../run.ts';
import { userOf } from '../users/users.ts';
import type { Task } from './task.ts';
import {
  ModelUnavailableError,
  REQUEST_TASK,
  result,
  type RunDeps,
  type RunOutcome,
  type RunResult,
} from './deps.ts';
import { taskGate, type GateDecision } from './gate.ts';
import { runPrecheck } from './precheck.ts';
import { pinSession, retryAfterUnavailable, serversFor, sessionOf } from './session.ts';
import { TaskFileError, TaskUsageError, renderTask, taskOf } from './skill.ts';

/** How a task run ended, for the caller to route (ADR 0007 §4). `runTask` sends nothing to a channel. */
export type TaskRun =
  | { readonly status: 'done'; readonly output: string }
  | { readonly status: 'needs-person'; readonly questionId: string }
  | { readonly status: 'failed'; readonly reason: string };

/** Why a run did not start: another run of the task holds its lock. */
export const LOCKED = 'locked';

const BUSY_REASON = 'another run of this task is still in progress';

function taskRunOf(run: RunResult): TaskRun {
  if (run.outcome === 'skipped' && run.reason === BUSY_REASON) return { status: 'failed', reason: LOCKED };
  switch (run.outcome) {
    case 'done':
      return { status: 'done', output: run.reply ?? '' };
    case 'nothing':
      return { status: 'done', output: run.reason ?? '' };
    case 'asked':
      return run.questionId
        ? { status: 'needs-person', questionId: run.questionId }
        : { status: 'failed', reason: 'the agent asked a question that was not recorded' };
    case 'declined':
      return { status: 'failed', reason: run.reason ?? 'a request was declined' };
    default:
      return { status: 'failed', reason: run.reason ?? run.outcome };
  }
}

/**
 * Run a task on demand: its SKILL.md with `params` filled in.
 * Profile, gate, questions, `person_needed`, precheck, the task's lock and the run record are the same
 * as for every run. Throws `TaskUsageError` for an unknown task or bad parameters.
 */
export async function runTask(
  id: string,
  params: Readonly<Record<string, string>>,
  deps: RunDeps,
): Promise<TaskRun> {
  let task: Task;
  try {
    const skill = deps.skill(id);
    if (!skill) throw new TaskUsageError(`there is no task "${id}"; \`lotse tasks\` lists them`);
    task = taskOf(skill, deps.profiles, renderTask(skill, params));
  } catch (error) {
    if (error instanceof TaskFileError) return { status: 'failed', reason: error.message };
    throw error;
  }
  const run = await runNewSession(task, deps);
  if (taskRunOf(run).status !== 'failed' || run.reason !== BUSY_REASON) deps.record?.(run);
  return taskRunOf(run);
}

/** One run of a task: a new session, the task's prompt, one turn. Only `runTask` starts it. */
async function runNewSession(task: Task, deps: RunDeps): Promise<RunResult> {
  const startedAt = deps.now();
  const reason = ceilingReached(task, deps.questions.read(), startedAt);
  if (reason) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling' } });
    return result(task, 'skipped', startedAt, deps.now(), { reason });
  }
  const release = deps.lock ? deps.lock(task.id) : () => {};
  if (!release) return busy(task, startedAt, deps);
  try {
    if (task.precheck) {
      const checked = await runPrecheck(task, deps);
      if (checked.verdict !== 'work') {
        return result(task, checked.verdict === 'nothing' ? 'nothing' : 'failed', startedAt, deps.now(), {
          sessionId: checked.sessionId,
          reason: checked.reason,
          precheck: checked.verdict,
        });
      }
    }
    const run = await runSession(task, deps, startedAt, async (client, extra, profile) => {
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...serversFor(task, profile), ...extra] }),
      );
      return {
        sessionId: session.sessionId,
        configOptions: session.configOptions ?? null,
        text: withPreamble(profile.preamble, task.prompt),
      };
    });
    return task.precheck ? { ...run, precheck: 'work' } : run;
  } finally {
    release();
  }
}

// ─── the shared part of a run and an answer ──────────────────────────────────────────────────

export interface Started {
  readonly sessionId: string;
  readonly configOptions: SessionConfigOption[] | null;
  readonly text: string;
}

/** How much of a run's final message the log keeps. */
export const SUMMARY_CHARS = 300;

/** The final message on one line, cut to `SUMMARY_CHARS`. */
export function summaryOf(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

export async function runSession(
  task: Task,
  deps: RunDeps,
  startedAt: Date,
  start: (client: AcpClient, extra: readonly McpServer[], profile: ProfileSession) => Promise<Started>,
  options: { readonly replyQuestions: boolean } = { replyQuestions: true },
): Promise<RunResult> {
  const profile = profileOf(deps.profiles, task);
  const resolved = sessionOf(deps, profile);
  const user = userOf(deps.users, profile);
  let handle: AgentHandle | null = null;
  let sessionId: string | null = null;
  let declined = false;
  // The profile's limit can only lower what the task asked for.
  const rights = narrowRights(task.rights, resolved.rights);
  const gate = taskGate({
    rights,
    released: [],
    now: () => deps.now().getTime(),
    ask: (request, action, text) => ask(task, user, request.sessionId, action, text, deps),
    onDecision: (decision: GateDecision) => {
      if (decision.answer === 'decline') declined = true;
      deps.log?.({
        event: 'gate',
        task: task.id,
        detail: {
          session: decision.sessionId,
          tool: decision.tool,
          digest: decision.digest.slice(0, 16),
          answer: decision.answer,
          why: decision.why,
        },
      });
    },
  });
  let person: { readonly server: McpServer; detach(): void } | null = null;
  deps.log?.({ event: 'run', task: task.id, detail: { phase: 'start' } });
  try {
    if (task.personNeeded.enabled && deps.personHost) {
      person = await deps.personHost.attach((input) =>
        personNeeded(task, profile, user, () => sessionId, input, deps),
      );
    }
    let started!: Started;
    for (let attempt = 0; ; attempt += 1) {
      handle = await deps.open({
        command: resolved.command,
        gate: { permission: gate },
        ...(deps.onAgentLog ? { onLog: deps.onAgentLog } : {}),
      });
      started = await start(handle.client, person ? [person.server] : [], resolved);
      sessionId = started.sessionId;
      try {
        await pinSession(handle.client, started.sessionId, started.configOptions, resolved);
        break;
      } catch (error) {
        if (!(error instanceof ModelUnavailableError) || attempt > 0) throw error;
        await retryAfterUnavailable(task, deps, handle, 'run');
        handle = null;
        sessionId = null;
      }
    }
    const agent = handle!;

    let message = '';
    const { stopReason } = await runTurn(agent.client, {
      sessionId: started.sessionId,
      text: started.text,
      onUpdate: (notification) => {
        if (notification.update.sessionUpdate === 'agent_message_chunk')
          message += chunkToText(notification.update.content);
      },
    });

    let questionId: string | null = null;
    if (options.replyQuestions && stopReason === 'end_turn' && isQuestionText(message)) {
      questionId = createReplyQuestion(task, user, started.sessionId, message.trim(), deps);
    }
    // An agent that hears "no" often still ends its turn normally; the run was declined all the same.
    const outcome: RunOutcome = questionId
      ? 'asked'
      : stopReason === 'end_turn' && !declined
        ? 'done'
        : 'declined';
    deps.log?.({
      event: 'run',
      task: task.id,
      detail: { phase: 'end', session: started.sessionId, stopReason, outcome },
    });
    if (task.id !== REQUEST_TASK && message.trim())
      deps.log?.({
        event: 'run-summary',
        task: task.id,
        detail: { session: started.sessionId, outcome, summary: summaryOf(message) },
      });
    return result(task, outcome, startedAt, deps.now(), {
      sessionId,
      stopReason,
      questionId,
      reply: message.trim() || null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.({
      event: 'error',
      task: task.id,
      detail: { kind: error instanceof Error ? error.name : 'Error' },
    });
    if (error instanceof ModelUnavailableError || error instanceof ProfileOptionError) {
      await deps.channel.send(user, {
        title: `lotse · ${task.id} stopped`,
        body: reason,
        questionId: null,
        task: task.id,
      });
    }
    return result(task, 'failed', startedAt, deps.now(), { sessionId, reason });
  } finally {
    person?.detach();
    if (sessionId) cancelHeldQuestions(deps, sessionId);
    await handle?.close();
  }
}

export function busy(task: Task, startedAt: Date, deps: RunDeps): RunResult {
  deps.log?.({ event: 'skip', task: task.id, detail: { why: 'running' } });
  return result(task, 'skipped', startedAt, deps.now(), {
    reason: BUSY_REASON,
  });
}
