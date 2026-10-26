/**
 * One run of a task and one answer to a question — ADR 0003.
 *
 * Everything with a side effect arrives as an argument: the agent (`open`, the same seam
 * `AgentSession` uses), the question store, the channel, the clock and the sleep. The app wires the
 * real ones; a test wires a `FixtureAgent` and an array, and the whole path — prompt, permission
 * question, yes, resume — runs on Node and GJS with no process anywhere.
 *
 * **Two processes share the question store.** `serve` holds a permission request open and polls the
 * store until the question is answered or expires; `lotse answer` is a second process that writes
 * the answer. That is why a waiting run reads the store rather than a variable, and why a permission
 * question whose run is gone is marked `cancelled` — a yes to it then has nothing to allow and is
 * dropped (ADR 0002 §8), instead of being applied to a session it was never about.
 */

import {
  ERROR_CODES,
  RpcError,
  UnsupportedCapabilityError,
  type AcpClient,
  type McpServer,
  type SessionConfigOption,
  type StopReason,
} from '@lotse/acp';

import type { AgentCommand } from '../agents/stdio.ts';
import { projectConfigOptions } from '../config.ts';
import { chunkToText } from '../policy.ts';
import { applyConfigOptions, ProfileOptionError } from '../profile/apply.ts';
import {
  narrowRights,
  profileFromServe,
  resolveProfile,
  withPreamble,
  type ProfileSession,
} from '../profile/resolve.ts';
import { runTurn, withAuthHint, type AgentHandle, type OpenAgentOptions } from '../run.ts';
import type { ServeChannel } from './channel.ts';
import {
  DEFAULT_QUESTION_LIMITS,
  PERSON_NEEDED_OFF,
  profileOf,
  type ServeConfig,
  type ServeProfile,
  type ServeTask,
  type ServeUser,
} from './config.ts';
import { serveGate, type AskOutcome, type GateDecision } from './gate.ts';
import {
  createdSince,
  findQuestions,
  formatQuestionId,
  isQuestionText,
  nextQuestionId,
  normalizeQuestionId,
  openQuestions,
  parseAnswer,
  type Question,
  type QuestionAction,
  type QuestionKind,
} from './questions.ts';
import {
  DEFAULT_PERSON_TIMEOUT_MIN,
  holdPerson,
  isHeld,
  offerCode,
  parsePersonReply,
  peekCode,
  personRefusal,
  personText,
  releasePerson,
  type PersonHost,
  type PersonNeededInput,
  type PersonOutcome,
} from './person.ts';
import { STRINGS, msg } from '../messenger/strings.ts';
import { TaskFileError, renderTask, serveTaskOf, type SkillTask } from '../task/skill.ts';
import { TaskUsageError } from '../task/skill.ts';

/** The question list, wherever it lives. Read fresh on every look: another process writes it too. */
export interface QuestionBook {
  read(): Question[];
  write(questions: Question[]): void;
}

/** One line of the action log. Ids and kinds only — never a prompt, a message or call arguments. */
export interface ServeLogEntry {
  readonly event:
    | 'run'
    | 'precheck'
    | 'skip'
    | 'question'
    | 'answer'
    | 'gate'
    | 'expired'
    | 'dropped'
    | 'reload'
    | 'request'
    | 'run-summary'
    | 'retry'
    | 'error';
  readonly task: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ServeDeps {
  readonly config: ServeConfig;
  readonly open: (options: OpenAgentOptions) => Promise<AgentHandle>;
  /** The agent a profile runs on, resolved by the app at start. */
  readonly commandFor: (profile: ServeProfile) => AgentCommand;
  /** The task's prompt, read by the app at start (and covered by the config hash). */
  readonly promptFor: (task: ServeTask) => string;
  /** The precheck's prompt, read by the app at start. Absent: the inline `precheck.prompt`. */
  readonly precheckPromptFor?: (task: ServeTask) => string;
  /** The task's last recorded run, which the precheck is told about. Absent: it hears "never". */
  readonly previousRun?: (task: string) => { readonly startedAt: string; readonly outcome: string } | null;
  readonly channel: ServeChannel;
  readonly questions: QuestionBook;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** How often a waiting permission request looks for an answer. Default 2 s. */
  readonly pollMs?: number;
  /** Where a run's agent finds `person_needed`. Absent: the tool is not offered. */
  readonly personHost?: PersonHost;
  /** Minutes `person_needed` waits when neither the call nor the task says. Default 30. */
  readonly personDefaultMin?: number;
  /** How long to wait before the one retry after the agent did not offer the model. Default 15 s. */
  readonly modelRetryMs?: number;
  /** A SKILL.md task by id, or `null` when there is none. Throws `TaskFileError` for one that does not parse. */
  readonly skill?: (id: string) => SkillTask | null;
  /** Keeps the run for `lotse status` and the precheck's "last run". Absent: not kept. */
  readonly record?: (result: RunResult) => void;
  /** Take the task's run lock; `null` when another run of it holds it. Absent: no cross-process lock. */
  readonly lock?: (task: string) => (() => void) | null;
  readonly log?: (entry: ServeLogEntry) => void;
  readonly onAgentLog?: (line: string) => void;
}

/** `nothing`: the precheck found nothing to do, so the task itself never ran. */
export type RunOutcome = 'done' | 'asked' | 'declined' | 'nothing' | 'skipped' | 'failed';

/** The precheck's last line, read without a model. */
export type PrecheckVerdict = 'work' | 'nothing';

export interface RunResult {
  readonly task: string;
  readonly outcome: RunOutcome;
  readonly sessionId: string | null;
  readonly stopReason: StopReason | null;
  /** The reply question the run ended with, if it asked one. */
  readonly questionId: string | null;
  /** The agent's final message. Handed to the caller, never written to the run state or the log. */
  readonly reply: string | null;
  /** Why a run was skipped or failed, as a sentence. */
  readonly reason: string | null;
  /** What the precheck answered; `null` when the task has none or it gave no verdict. */
  readonly precheck: PrecheckVerdict | null;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** How `lotse answer` continued a session, or why it did not. */
export type AnswerMode =
  | 'allowed'
  | 'declined'
  | 'loaded'
  | 'resumed'
  | 'follow-up'
  | 'dropped'
  | 'expired'
  | 'unknown'
  | 'busy'
  | 'invalid';

export interface AnswerResult {
  readonly mode: AnswerMode;
  /** One sentence for the person: what happened and why. */
  readonly message: string;
  readonly question: Question | null;
  readonly run: RunResult | null;
}

/** The agent does not offer the model a profile names. No fallback (ADR 0002 §5). */
export class ModelUnavailableError extends Error {
  constructor(model: string) {
    super(`the agent does not offer the model "${model}" this profile names; there is no fallback`);
    this.name = 'ModelUnavailableError';
  }
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MODEL_RETRY_MS = 15_000;
const HOUR_MS = 3_600_000;

export function userOf(config: ServeConfig, profile: ServeProfile): ServeUser {
  const user = config.users.find((candidate) => candidate.id === profile.user);
  if (!user) throw new Error(`profile "${profile.id}" has no user "${profile.user}"`);
  return user;
}

/** The ceiling that stops a task before any model call, or `null` (ADR 0002 §2). */
export function ceilingReached(task: ServeTask, questions: readonly Question[], now: Date): string | null {
  const open = openQuestions(questions, now).filter((question) => question.task === task.id).length;
  if (open >= task.questions.maxOpen) return `${open} open question(s), the most this task may have`;
  const lastHour = createdSince(questions, task.id, new Date(now.getTime() - HOUR_MS));
  if (lastHour >= task.questions.maxPerHour)
    return `${lastHour} question(s) in the last hour, the most this task may ask`;
  return null;
}

/**
 * Mark every open permission question `cancelled`: the run that held its request is gone. `serve`
 * calls this at start, so a yes after a restart is dropped rather than applied to anything.
 */
export function cancelOrphanedPermissions(deps: Pick<ServeDeps, 'questions' | 'now' | 'log'>): number {
  const book = deps.questions.read();
  let count = 0;
  const next = book.map((question) => {
    if (question.kind !== 'permission' || question.status !== 'open') return question;
    count += 1;
    deps.log?.({ event: 'dropped', task: question.task, detail: { question: question.id, why: 'restart' } });
    return {
      ...question,
      status: 'cancelled' as const,
      resolution: 'serve restarted; the request it would answer is gone',
    };
  });
  if (count > 0) deps.questions.write(next);
  return count;
}

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
 * Run a task on demand: its SKILL.md (else the task of tasks.json of that id) with `params` filled in.
 * Profile, gate, questions, `person_needed`, precheck, the task's lock and the run record are the same
 * as for every run. Throws `TaskUsageError` for an unknown task or bad parameters.
 */
export async function runTask(
  id: string,
  params: Readonly<Record<string, string>>,
  deps: ServeDeps,
): Promise<TaskRun> {
  let task: ServeTask;
  let scoped: ServeDeps = deps;
  try {
    const skill = deps.skill?.(id) ?? null;
    if (skill) {
      const text = renderTask(skill, params);
      task = serveTaskOf(skill, deps.config);
      scoped = { ...deps, promptFor: () => text.prompt, precheckPromptFor: () => text.precheck ?? '' };
    } else {
      const legacy = deps.config.tasks.find((candidate) => candidate.id === id);
      if (!legacy) throw new TaskUsageError(`there is no task "${id}"; \`lotse tasks\` lists them`);
      if (Object.keys(params).length > 0) throw new TaskUsageError(`task "${id}" takes no parameters`);
      task = legacy;
    }
  } catch (error) {
    if (error instanceof TaskFileError) return { status: 'failed', reason: error.message };
    throw error;
  }
  const run = await runConfigured(task, scoped);
  if (taskRunOf(run).status !== 'failed' || run.reason !== BUSY_REASON) deps.record?.(run);
  return taskRunOf(run);
}

/** One run of a task: a new session, the task's prompt, one turn. Only `runTask` starts it. */
async function runConfigured(task: ServeTask, deps: ServeDeps): Promise<RunResult> {
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
        text: withPreamble(profile.preamble, deps.promptFor(task)),
      };
    });
    return task.precheck ? { ...run, precheck: 'work' } : run;
  } finally {
    release();
  }
}

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
async function runPrecheck(
  task: ServeTask,
  deps: ServeDeps,
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
  const gate = serveGate({
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

/**
 * `lotse answer <id> <text>`.
 *
 * A permission question records yes or no in the store, where the run holding the request reads
 * it. A reply question continues the session with the text: `session/load`, else `session/resume`,
 * else a new session that carries the question and the answer as context — and says which.
 */
export async function answerQuestion(idText: string, text: string, deps: ServeDeps): Promise<AnswerResult> {
  const id = normalizeQuestionId(idText);
  const none = (mode: AnswerMode, message: string, question: Question | null = null): AnswerResult => ({
    mode,
    message,
    question,
    run: null,
  });
  if (!id) return none('unknown', `"${idText}" is not a question id like #A1`);
  const found = findQuestions(deps.questions.read(), id);
  const question = found[0];
  if (!question) return none('unknown', `there is no question ${formatQuestionId(id)}`);
  if (new Set(found.map((candidate) => candidate.user)).size > 1) {
    return none('unknown', `${formatQuestionId(id)} exists for several users; this build serves one`);
  }
  const label = formatQuestionId(question.id);
  if (question.status !== 'open') {
    deps.log?.({
      event: 'dropped',
      task: question.task,
      detail: { question: question.id, why: question.status },
    });
    return none(
      'dropped',
      `${label} is ${question.status}${question.resolution ? ` (${question.resolution})` : ''}; nothing waits for this answer`,
      question,
    );
  }
  const now = deps.now();
  if (Date.parse(question.expiresAt) <= now.getTime()) {
    const expired = update(deps, question, { status: 'expired', resolution: 'expired before an answer' });
    deps.log?.({ event: 'expired', task: question.task, detail: { question: question.id } });
    return none('expired', `${label} expired at ${question.expiresAt}; the answer was dropped`, expired);
  }

  const parsed = parseAnswer(text);
  if (question.kind === 'permission') {
    if (parsed.kind === 'text')
      return none('invalid', `${label} asks to allow one action; answer yes or no`, question);
    const answered = update(deps, question, {
      status: 'answered',
      answer: parsed.kind,
      answeredAt: now.toISOString(),
      resolution: parsed.kind === 'yes' ? 'allowed once' : 'declined',
    });
    deps.log?.({
      event: 'answer',
      task: question.task,
      detail: { question: question.id, answer: parsed.kind },
    });
    return {
      mode: parsed.kind === 'yes' ? 'allowed' : 'declined',
      message: `${label} ${parsed.kind === 'yes' ? 'allowed once' : 'declined'}; the waiting run picks it up`,
      question: answered,
      run: null,
    };
  }

  let personDone = false;
  if (question.kind === 'person') {
    const reply = parsePersonReply(text, question.acceptsCode === true);
    if (reply.kind === 'invalid')
      return none(
        'invalid',
        msg(STRINGS.personNeedsAnswer, {
          id: label,
          orCode: question.acceptsCode && !question.deferred ? ' or the code' : '',
        }),
        question,
      );
    const held = isHeld(question.user, question.id);
    // Not held and not deferred: the waiting call lives in another process (`serve`), which reads the store.
    if (held || !question.deferred) {
      if (reply.kind === 'code') {
        if (!held || !offerCode(question.user, question.id, reply.code))
          return none('invalid', msg(STRINGS.personCodeRefused, { id: label }), question);
      }
      const answer = reply.kind === 'declined' ? 'no' : reply.kind === 'code' ? 'text' : 'yes';
      const answered = update(deps, question, {
        status: 'answered',
        answer,
        answeredAt: now.toISOString(),
        resolution: reply.kind === 'code' ? 'code received' : reply.kind === 'declined' ? 'declined' : 'done',
      });
      deps.log?.({ event: 'answer', task: question.task, detail: { question: question.id, answer } });
      return {
        mode: reply.kind === 'declined' ? 'declined' : 'allowed',
        message: `${label} ${reply.kind === 'code' ? 'code received' : reply.kind}; the waiting run picks it up`,
        question: answered,
        run: null,
      };
    }
    if (reply.kind === 'code')
      return none('invalid', msg(STRINGS.personCodeRefused, { id: label }), question);
    if (reply.kind === 'declined') {
      const closed = update(deps, question, {
        status: 'answered',
        answer: 'no',
        answeredAt: now.toISOString(),
        resolution: 'declined',
      });
      deps.log?.({ event: 'answer', task: question.task, detail: { question: question.id, answer: 'no' } });
      return { mode: 'declined', message: `${label} declined`, question: closed, run: null };
    }
    personDone = true;
  }

  const task = taskById(deps, question.task);
  if (!task) {
    update(deps, question, { status: 'cancelled', resolution: 'its task is no longer configured' });
    return none(
      'dropped',
      `${label} belongs to task "${question.task}", which is no longer configured`,
      question,
    );
  }
  const release = deps.lock ? deps.lock(task.id) : () => {};
  if (!release)
    return none(
      'busy',
      `task "${task.id}" is running right now; answer ${label} again when it is done`,
      question,
    );
  try {
    // Answered before the turn, so a second `lotse answer` cannot continue the same session twice.
    update(deps, question, {
      status: 'answered',
      answer: parsed.kind,
      answeredAt: now.toISOString(),
      resolution: 'continuing the session',
    });
    deps.log?.({ event: 'answer', task: task.id, detail: { question: question.id, answer: parsed.kind } });
    let how: 'loaded' | 'resumed' | 'follow-up' = 'loaded';
    const answerText = personDone
      ? 'I have done it myself; you can continue.'
      : parsed.kind === 'text'
        ? parsed.text
        : text.trim();
    const run = await runSession(task, deps, now, async (client, extra, profile) => {
      const servers = serversFor(task, profile, 'answer');
      const continued = await continueSession(client, task.cwd, question.sessionId, servers, extra);
      if (continued) {
        how = continued.how;
        return { sessionId: question.sessionId, configOptions: continued.configOptions, text: answerText };
      }
      how = 'follow-up';
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...servers, ...extra] }),
      );
      return {
        sessionId: session.sessionId,
        configOptions: session.configOptions ?? null,
        text: withPreamble(profile.preamble, followUpPrompt(task, question, answerText)),
      };
    });
    const said = {
      loaded: 'resumed the session with session/load',
      resumed: 'resumed the session with session/resume',
      'follow-up':
        'the agent can neither load nor resume it, so a follow-up run started with the question as context',
    }[how];
    const message =
      run.outcome === 'failed' ? `${label}: ${said}, but the run failed: ${run.reason}` : `${label}: ${said}`;
    update(deps, question, { resolution: message });
    return {
      mode: how,
      message,
      question: findQuestions(deps.questions.read(), question.id)[0] ?? question,
      run,
    };
  } finally {
    release();
  }
}

/**
 * The task id an ad-hoc run from the chat appears under — in the log, on its questions. The `@` is
 * outside what a task id of tasks.json may hold, so it never collides with one.
 */
export const REQUEST_TASK = '@chat';

/** One request from the chat, as `runRequest` takes it. */
export interface RequestRun {
  /** A profile id of tasks.json: agent, model and user. */
  readonly profile: string;
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  readonly rights: 'read' | 'confirm';
  /** Put in front of `text` when the session is new. */
  readonly preamble: string;
  readonly text: string;
  /** The session to continue; `null`: a new one. */
  readonly sessionId: string | null;
}

/**
 * `new` and the two continuations as in `answerQuestion`; `fresh` when a session was to be continued
 * but the agent can neither load nor resume it, so a new one started.
 */
export type RequestMode = 'new' | 'loaded' | 'resumed' | 'fresh';

export interface RequestRunResult {
  readonly run: RunResult;
  readonly how: RequestMode;
}

/** The task an ad-hoc run is: no reply questions, its permission questions to every channel. */
export function requestTask(request: Omit<RequestRun, 'text' | 'sessionId' | 'preamble'>): ServeTask {
  return {
    id: REQUEST_TASK,
    profile: request.profile,
    prompt: null,
    promptFile: null,
    cwd: request.cwd,
    mcpServers: request.mcpServers,
    answerMcpServers: null,
    precheck: null,
    rights: request.rights,
    released: [],
    questions: DEFAULT_QUESTION_LIMITS,
    notify: 'questions',
    personNeeded: PERSON_NEEDED_OFF,
    channels: null,
    messengerDetail: null,
  };
}

/**
 * One request from the chat: a turn in a new session, or in `sessionId` continued by `session/load`,
 * else `session/resume`, else a new session. The agent's final message comes back as `run.reply` for
 * the caller to deliver; the run never turns it into a reply question. Throws when the profile is not
 * configured.
 */
export async function runRequest(request: RequestRun, deps: ServeDeps): Promise<RequestRunResult> {
  const task = requestTask(request);
  profileOf(deps.config, task);
  let how: RequestMode = 'new';
  const run = await runSession(
    task,
    deps,
    deps.now(),
    async (client, extra, profile) => {
      const servers = serversFor(task, profile);
      // The request's own preamble replaces the profile's, like its servers do.
      const opening = withPreamble(request.preamble.trim() || profile.preamble, request.text);
      if (request.sessionId) {
        const continued = await continueSession(client, task.cwd, request.sessionId, servers, extra);
        if (continued) {
          how = continued.how;
          return { sessionId: request.sessionId, configOptions: continued.configOptions, text: request.text };
        }
        how = 'fresh';
      }
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...servers, ...extra] }),
      );
      return { sessionId: session.sessionId, configOptions: session.configOptions ?? null, text: opening };
    },
    { replyQuestions: false },
  );
  return { run, how };
}

// ─── the shared part of a run and an answer ──────────────────────────────────────────────────

interface Started {
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

async function runSession(
  task: ServeTask,
  deps: ServeDeps,
  startedAt: Date,
  start: (client: AcpClient, extra: readonly McpServer[], profile: ProfileSession) => Promise<Started>,
  options: { readonly replyQuestions: boolean } = { replyQuestions: true },
): Promise<RunResult> {
  const profile = profileOf(deps.config, task);
  const resolved = sessionOf(deps, profile);
  const user = userOf(deps.config, profile);
  let handle: AgentHandle | null = null;
  let sessionId: string | null = null;
  let declined = false;
  // The profile's limit can only lower what the task asked for; the areas of `released` go with it.
  const rights = narrowRights(task.rights, resolved.rights);
  const gate = serveGate({
    rights,
    released: rights === 'released' ? task.released : [],
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
    } else if (stopReason === 'end_turn' && task.notify === 'always' && message.trim()) {
      await deps.channel.send(user, {
        title: `lotse · ${task.id}`,
        body: message.trim(),
        questionId: null,
        task: task.id,
      });
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

/** `session/load`, else `session/resume`; `null` when the agent offers neither. */
async function continueSession(
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

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof UnsupportedCapabilityError ||
    (error instanceof RpcError && error.code === ERROR_CODES.METHOD_NOT_FOUND)
  );
}

/** The context a fresh session needs to make sense of an answer it never saw the question for. */
export function followUpPrompt(task: ServeTask, question: Question, answer: string): string {
  return [
    `This continues an earlier run of the task "${task.id}". That session cannot be reopened.`,
    '',
    'You asked:',
    question.text,
    '',
    'The person answered:',
    answer,
  ].join('\n');
}

/**
 * The agent may refresh its model list while a session starts, so a model it offers can be missing
 * for a moment. Close this agent and wait; the caller opens a fresh session with the SAME model —
 * still no fallback (ADR 0002 §5).
 */
async function retryAfterUnavailable(
  task: ServeTask,
  deps: ServeDeps,
  handle: AgentHandle,
  phase: 'run' | 'precheck',
): Promise<void> {
  deps.log?.({ event: 'retry', task: task.id, detail: { kind: 'ModelUnavailableError', phase } });
  await handle.close();
  await deps.sleep(deps.modelRetryMs ?? DEFAULT_MODEL_RETRY_MS);
}

/** The profile resolved for this run; the launcher is the app's, found by `commandFor`. */
function sessionOf(deps: ServeDeps, profile: ServeProfile): ProfileSession {
  return resolveProfile(profileFromServe(profile), { agent: () => deps.commandFor(profile) });
}

/**
 * The servers a turn's new or continued session gets. The task's own list replaces the profile's —
 * a task that names servers has decided which tools it gets — and the answer turn of a reply question
 * may narrow or widen that again.
 */
function serversFor(
  task: ServeTask,
  profile: ProfileSession,
  turn: 'first' | 'answer' = 'first',
): McpServer[] {
  const first = task.mcpServers.length > 0 ? task.mcpServers : profile.mcpServers;
  return [...(turn === 'answer' ? (task.answerMcpServers ?? first) : first)];
}

/** The profile's model, then its other options, on a session that just started. */
async function pinSession(
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

async function pinModel(
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

// ─── questions ───────────────────────────────────────────────────────────────────────────────

function newQuestion(
  book: readonly Question[],
  task: ServeTask,
  user: ServeUser,
  kind: QuestionKind,
  sessionId: string,
  action: QuestionAction | null,
  text: string,
  now: Date,
): Question {
  return {
    id: nextQuestionId(book, user.id),
    user: user.id,
    task: task.id,
    kind,
    sessionId,
    action,
    text,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + task.questions.expiresMs).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
  };
}

function howToAnswer(question: Question): string {
  const id = question.id;
  return question.kind === 'permission'
    ? `Answer: lotse answer ${id} yes|no — expires ${question.expiresAt}`
    : `Answer: lotse answer ${id} <text> — expires ${question.expiresAt}`;
}

async function notify(
  question: Question,
  user: ServeUser,
  deps: ServeDeps,
  shown: string = question.text,
): Promise<void> {
  try {
    await deps.channel.send(user, {
      title: `lotse · ${question.task} · ${formatQuestionId(question.id)}`,
      body: `${shown}\n\n${howToAnswer(question)}`,
      questionId: question.id,
      task: question.task,
      asks: question.kind,
      text: shown,
      expiresAt: question.expiresAt,
    });
  } catch (error) {
    // The question is in the store and `lotse questions` lists it; a channel that failed is logged.
    deps.log?.({
      event: 'error',
      task: question.task,
      detail: { channel: deps.channel.name, kind: error instanceof Error ? error.name : 'Error' },
    });
  }
}

function createReplyQuestion(
  task: ServeTask,
  user: ServeUser,
  sessionId: string,
  text: string,
  deps: ServeDeps,
): string | null {
  const now = deps.now();
  const book = deps.questions.read();
  if (ceilingReached(task, book, now)) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling', session: sessionId } });
    return null;
  }
  const question = newQuestion(book, task, user, 'reply', sessionId, null, text, now);
  deps.questions.write([...book, question]);
  deps.log?.({
    event: 'question',
    task: task.id,
    detail: { question: question.id, kind: 'reply', session: sessionId },
  });
  void notify(question, user, deps);
  return question.id;
}

async function ask(
  task: ServeTask,
  user: ServeUser,
  sessionId: string,
  action: QuestionAction,
  text: string,
  deps: ServeDeps,
): Promise<AskOutcome> {
  const book = deps.questions.read();
  if (ceilingReached(task, book, deps.now())) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling', session: sessionId } });
    return 'refused';
  }
  const question = newQuestion(book, task, user, 'permission', sessionId, action, text, deps.now());
  deps.questions.write([...book, question]);
  deps.log?.({
    event: 'question',
    task: task.id,
    detail: { question: question.id, kind: 'permission', session: sessionId },
  });
  await notify(question, user, deps);

  for (;;) {
    const current = findQuestions(deps.questions.read(), question.id, user.id)[0];
    if (!current || current.status === 'cancelled' || current.status === 'expired') return 'expired';
    if (current.status === 'answered') return current.answer === 'yes' ? 'yes' : 'no';
    if (Date.parse(current.expiresAt) <= deps.now().getTime()) {
      update(deps, current, {
        status: 'expired',
        resolution: 'expired before an answer; the request was cancelled',
      });
      deps.log?.({ event: 'expired', task: task.id, detail: { question: current.id } });
      await deps.channel.send(user, {
        title: `lotse · ${task.id} · ${formatQuestionId(current.id)} expired`,
        body: 'Nobody answered in time, so the request was cancelled.',
        questionId: current.id,
        task: task.id,
      });
      return 'expired';
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS);
  }
}

/**
 * `person_needed`: one `person` question, then a poll like `ask`'s. The code, if one comes, is read from
 * the in-memory `waiting` map and returned to the agent; nothing here logs or stores it. On no reply in
 * time the question stays open as `deferred` — the open item `lotse questions` lists — and the call
 * returns `timeout`.
 */
async function personNeeded(
  task: ServeTask,
  profile: ServeProfile,
  user: ServeUser,
  sessionOf: () => string | null,
  input: PersonNeededInput,
  deps: ServeDeps,
): Promise<PersonOutcome> {
  const refusal = personRefusal(task, profile, input);
  if (refusal) throw new Error(refusal);
  const sessionId = sessionOf();
  if (!sessionId) throw new Error('the session has not started yet');
  const now = deps.now();
  const book = deps.questions.read();
  if (
    openQuestions(book, now).some(
      (question) => question.kind === 'person' && question.sessionId === sessionId && !question.deferred,
    )
  )
    throw new Error('another person_needed is already waiting in this conversation');
  const ceiling = ceilingReached(task, book, now);
  if (ceiling) {
    deps.log?.({ event: 'skip', task: task.id, detail: { why: 'ceiling', session: sessionId } });
    throw new Error(`the person cannot be asked now: ${ceiling}`);
  }
  const waitMin =
    input.timeoutMin ?? task.personNeeded.timeoutMin ?? deps.personDefaultMin ?? DEFAULT_PERSON_TIMEOUT_MIN;
  const deadline = now.getTime() + waitMin * 60_000;
  const created = newQuestion(book, task, user, 'person', sessionId, null, personText(input, false), now);
  const question: Question = {
    ...created,
    acceptsCode: input.acceptsCode,
    expiresAt: new Date(deadline + task.questions.expiresMs).toISOString(),
  };
  deps.questions.write([...book, question]);
  holdPerson(user.id, question.id, input.acceptsCode);
  deps.log?.({
    event: 'question',
    task: task.id,
    detail: { question: question.id, kind: 'person', session: sessionId },
  });
  try {
    await notify(question, user, deps, personText(input));
    for (;;) {
      const current = findQuestions(deps.questions.read(), question.id, user.id)[0];
      if (!current || current.status === 'cancelled' || current.status === 'expired')
        return { outcome: 'timeout' };
      if (current.status === 'answered') {
        if (current.answer === 'no') return { outcome: 'declined' };
        const code = current.answer === 'text' ? peekCode(user.id, question.id) : null;
        return code ? { outcome: 'code', code } : { outcome: 'done' };
      }
      if (deps.now().getTime() >= deadline) {
        update(deps, current, {
          deferred: true,
          resolution: 'no reply in time; the task went on without you',
        });
        deps.log?.({ event: 'expired', task: task.id, detail: { question: current.id, why: 'deferred' } });
        return { outcome: 'timeout' };
      }
      await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS);
    }
  } finally {
    releasePerson(user.id, question.id);
  }
}

/** The run is over: a permission question still open for its session has nothing left to answer. */
function cancelHeldQuestions(deps: ServeDeps, sessionId: string): void {
  const book = deps.questions.read();
  let changed = false;
  const next = book.map((question) => {
    if (question.status !== 'open' || question.sessionId !== sessionId) return question;
    if (question.kind === 'reply' || (question.kind === 'person' && question.deferred)) return question;
    changed = true;
    return { ...question, status: 'cancelled' as const, resolution: 'the run ended before an answer' };
  });
  if (changed) deps.questions.write(next);
}

function update(deps: Pick<ServeDeps, 'questions'>, question: Question, patch: Partial<Question>): Question {
  let updated = question;
  deps.questions.write(
    deps.questions.read().map((candidate) => {
      if (candidate.id !== question.id || candidate.user !== question.user) return candidate;
      updated = { ...candidate, ...patch };
      return updated;
    }),
  );
  return updated;
}

/** A task of SKILL.md, else of tasks.json; `undefined` when neither names it (any more). */
function taskById(deps: ServeDeps, id: string): ServeTask | undefined {
  try {
    const skill = deps.skill?.(id);
    if (skill) return serveTaskOf(skill, deps.config);
  } catch {
    return undefined;
  }
  return deps.config.tasks.find((candidate) => candidate.id === id);
}

function busy(task: ServeTask, startedAt: Date, deps: ServeDeps): RunResult {
  deps.log?.({ event: 'skip', task: task.id, detail: { why: 'running' } });
  return result(task, 'skipped', startedAt, deps.now(), {
    reason: BUSY_REASON,
  });
}

function result(
  task: ServeTask,
  outcome: RunOutcome,
  startedAt: Date,
  endedAt: Date,
  rest: {
    sessionId?: string | null;
    stopReason?: StopReason | null;
    questionId?: string | null;
    reply?: string | null;
    reason?: string | null;
    precheck?: PrecheckVerdict | null;
  },
): RunResult {
  return {
    task: task.id,
    outcome,
    sessionId: rest.sessionId ?? null,
    stopReason: rest.stopReason ?? null,
    questionId: rest.questionId ?? null,
    reply: rest.reply ?? null,
    reason: rest.reason ?? null,
    precheck: rest.precheck ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
}
