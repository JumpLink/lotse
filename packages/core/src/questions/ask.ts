/**
 * The questions a run puts to its person — permission, reply, `person_needed` — and the store they
 * live in. A question is created, announced on the channel, and polled until it is answered or expires.
 */

import type { Profile } from '../profile/profile.ts';
import type { RunDeps } from '../task/deps.ts';
import type { AskOutcome } from '../task/gate.ts';
import { DEFAULT_QUESTION_LIMITS, type Task } from '../task/task.ts';
import type { User } from '../users/users.ts';
import {
  createdSince,
  findQuestions,
  formatQuestionId,
  nextQuestionId,
  openQuestions,
  type Question,
  type QuestionAction,
  type QuestionKind,
} from './question.ts';
import {
  DEFAULT_PERSON_TIMEOUT_MIN,
  holdPerson,
  peekCode,
  personRefusal,
  personText,
  releasePerson,
  type PersonNeededInput,
  type PersonOutcome,
} from './person.ts';

const DEFAULT_POLL_MS = 2_000;
const HOUR_MS = 3_600_000;

/** The ceiling that stops a task before any model call, or `null` (ADR 0002 §2). */
export function ceilingReached(task: Task, questions: readonly Question[], now: Date): string | null {
  const open = openQuestions(questions, now).filter((question) => question.task === task.id).length;
  if (open >= DEFAULT_QUESTION_LIMITS.maxOpen) return `${open} open question(s), the most this task may have`;
  const lastHour = createdSince(questions, task.id, new Date(now.getTime() - HOUR_MS));
  if (lastHour >= DEFAULT_QUESTION_LIMITS.maxPerHour)
    return `${lastHour} question(s) in the last hour, the most this task may ask`;
  return null;
}

/**
 * Mark every open permission question `cancelled`: the run that held its request is gone. `listen`
 * calls this at start, so a yes after a restart is dropped rather than applied to anything.
 */
export function cancelOrphanedPermissions(deps: Pick<RunDeps, 'questions' | 'now' | 'log'>): number {
  const book = deps.questions.read();
  let count = 0;
  const next = book.map((question) => {
    if (question.kind !== 'permission' || question.status !== 'open') return question;
    count += 1;
    deps.log?.({ event: 'dropped', task: question.task, detail: { question: question.id, why: 'restart' } });
    return {
      ...question,
      status: 'cancelled' as const,
      resolution: 'listen restarted; the request it would answer is gone',
    };
  });
  if (count > 0) deps.questions.write(next);
  return count;
}

// ─── questions ───────────────────────────────────────────────────────────────────────────────

export function newQuestion(
  book: readonly Question[],
  task: Task,
  user: User,
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
    expiresAt: new Date(now.getTime() + DEFAULT_QUESTION_LIMITS.expiresMs).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
  };
}

export function howToAnswer(question: Question): string {
  const id = question.id;
  return question.kind === 'permission'
    ? `Answer: lotse answer ${id} yes|no — expires ${question.expiresAt}`
    : `Answer: lotse answer ${id} <text> — expires ${question.expiresAt}`;
}

export async function notify(
  question: Question,
  user: User,
  deps: RunDeps,
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

export function createReplyQuestion(
  task: Task,
  user: User,
  sessionId: string,
  text: string,
  deps: RunDeps,
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

export async function ask(
  task: Task,
  user: User,
  sessionId: string,
  action: QuestionAction,
  text: string,
  deps: RunDeps,
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
export async function personNeeded(
  task: Task,
  profile: Profile,
  user: User,
  sessionOf: () => string | null,
  input: PersonNeededInput,
  deps: RunDeps,
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
    expiresAt: new Date(deadline + DEFAULT_QUESTION_LIMITS.expiresMs).toISOString(),
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
export function cancelHeldQuestions(deps: RunDeps, sessionId: string): void {
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

export function update(
  deps: Pick<RunDeps, 'questions'>,
  question: Question,
  patch: Partial<Question>,
): Question {
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
