/**
 * What a run and an answer take as arguments, and what they hand back — ADR 0003.
 *
 * Everything with a side effect arrives as an argument: the agent (`open`, the same seam
 * `AgentSession` uses), the question store, the channel, the clock and the sleep. The app wires the
 * real ones; a test wires a `FixtureAgent` and an array, and the whole path — prompt, permission
 * question, yes, resume — runs on Node and GJS with no process anywhere.
 */

import type { StopReason } from '@lotse/acp';

import type { AgentCommand } from '../agents/stdio.ts';
import type { QuestionChannel } from '../questions/channel.ts';
import type { PersonHost } from '../questions/person.ts';
import type { Question } from '../questions/question.ts';
import type { OpenAgentOptions, AgentHandle } from '../run.ts';
import type { SkillTask } from './skill.ts';
import type { ServeConfig, ServeProfile, ServeTask } from './config.ts';

/** The question list, wherever it lives. Read fresh on every look: another process writes it too. */
export interface QuestionBook {
  read(): Question[];
  write(questions: Question[]): void;
}

/** One line of the action log. Ids and kinds only — never a prompt, a message or call arguments. */
export interface RunLogEntry {
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

export interface RunDeps {
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
  readonly channel: QuestionChannel;
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
  readonly log?: (entry: RunLogEntry) => void;
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

/** The agent does not offer the model a profile names. No fallback (ADR 0002 §5). */
export class ModelUnavailableError extends Error {
  constructor(model: string) {
    super(`the agent does not offer the model "${model}" this profile names; there is no fallback`);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * The task id an ad-hoc run from the chat appears under — in the log, on its questions. The `@` is
 * outside what a task id of tasks.json may hold, so it never collides with one.
 */
export const REQUEST_TASK = '@chat';

export function result(
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
