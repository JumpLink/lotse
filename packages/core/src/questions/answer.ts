/** `lotse answer <id> <text>` and an answer from the chat: what the text does to the question. */

import { _ } from '../i18n.ts';
import { withPreamble } from '../profile/resolve.ts';
import { msg, STRINGS } from '../messenger/strings.ts';
import { withAuthHint } from '../run.ts';
import type { RunDeps, RunResult } from '../task/deps.ts';
import { runSession } from '../task/run.ts';
import { continueSession, serversFor } from '../task/session.ts';
import { taskOf } from '../task/skill.ts';
import type { Task } from '../task/task.ts';
import { update } from './ask.ts';
import {
  findQuestions,
  formatQuestionId,
  normalizeQuestionId,
  parseAnswer,
  type Question,
} from './question.ts';
import { isHeld, offerCode, parsePersonReply } from './person.ts';

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

/**
 * `lotse answer <id> <text>`.
 *
 * A permission question records yes or no in the store, where the run holding the request reads
 * it. A reply question continues the session with the text: `session/load`, else `session/resume`,
 * else a new session that carries the question and the answer as context — and says which.
 */
export async function answerQuestion(idText: string, text: string, deps: RunDeps): Promise<AnswerResult> {
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
          orCode: question.acceptsCode && !question.deferred ? _(' or the code') : '',
        }),
        question,
      );
    const held = isHeld(question.user, question.id);
    // Not held and not deferred: the waiting call lives in another process (`listen`), which reads the store.
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
      const servers = serversFor(task, profile);
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

/** The context a fresh session needs to make sense of an answer it never saw the question for. */
export function followUpPrompt(task: Task, question: Question, answer: string): string {
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

/** A task of SKILL.md; `undefined` when none names it (any more). */
function taskById(deps: RunDeps, id: string): Task | undefined {
  try {
    const skill = deps.skill(id);
    return skill ? taskOf(skill, deps.profiles) : undefined;
  } catch {
    return undefined;
  }
}
