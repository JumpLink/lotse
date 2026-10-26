/**
 * `person_needed` — a running task tells the person that only they can go on, and waits.
 *
 * It reuses the question store and every channel: the call creates a `person` question, the channel
 * sends it, and the person answers through the same `answerQuestion` as for any other question. What
 * is new is only what the answer may carry.
 *
 * - **"done"** (`done`, `fertig`, `yes`, …): the person did the step themselves.
 * - **A code**, when the call said `acceptsCode`: a 4–10 character token of `[0-9A-Za-z]`. It goes from
 *   the reply to the waiting call through `waiting`, a map in this process's memory. It is never put in
 *   the question store, the log, a transcript or a message lotse sends: the store keeps the answer kind
 *   (`text`) and every line that must mention it says `REDACTED`.
 * - **No reply in time**: the call returns `timeout`, the run goes on without the person, and the
 *   question stays open as `deferred` — the open item `lotse questions` lists. A later "done" then
 *   continues the session like a reply question does; a code after the wait is refused, because the
 *   session it would be typed into is gone.
 *
 * A code is a credential, so a task that may receive one must run on a model that is not free or
 * hosted for free: `personRefusal`.
 */

import type { McpServer } from '@lotse/acp';

import { isFreeModel } from '../free-models.ts';
import { STRINGS, msg } from '../messenger/strings.ts';
import type { ServeProfile, ServeTask } from '../task/config.ts';
import { parseAnswer } from './question.ts';

export const PERSON_KINDS = ['login', 'code', 'approval', 'device'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export interface PersonNeededInput {
  readonly kind: PersonKind;
  readonly origin: string;
  readonly prompt: string;
  readonly acceptsCode: boolean;
  /**
   * A link the person has to open or scan on their own device (a login QR code's content). It is a
   * session challenge: it goes into the message and nowhere else — not into the question book, not
   * into a log — and a free hosted model may not carry it.
   */
  readonly link?: string;
  /** Minutes to wait. Absent: the task's, else the settings' default. */
  readonly timeoutMin?: number;
}

export type PersonOutcome =
  | { readonly outcome: 'done' | 'timeout' | 'declined' }
  | { readonly outcome: 'code'; readonly code: string };

export type PersonHandler = (input: PersonNeededInput) => Promise<PersonOutcome>;

/** How a run's agent reaches the tool: an MCP server that lives while the run does. */
export interface PersonHost {
  attach(handler: PersonHandler): Promise<{ readonly server: McpServer; detach(): void }>;
}

export const DEFAULT_PERSON_TIMEOUT_MIN = 30;

/** What a line may say about a code. */
export const REDACTED = '••••';

/** Where a code stays between the reply that carries it and the call that waits for it. */
const waiting = new Map<string, { acceptsCode: boolean; code: string | null }>();

const keyOf = (user: string, id: string): string => `${user}/${id}`;

export function holdPerson(user: string, id: string, acceptsCode: boolean): void {
  waiting.set(keyOf(user, id), { acceptsCode, code: null });
}

export function releasePerson(user: string, id: string): void {
  waiting.delete(keyOf(user, id));
}

/** Whether a call in this process waits for this question. */
export function isHeld(user: string, id: string): boolean {
  return waiting.has(keyOf(user, id));
}

/** Hand a code to the waiting call; `false` when none waits for it or it takes no code. */
export function offerCode(user: string, id: string, code: string): boolean {
  const held = waiting.get(keyOf(user, id));
  if (!held?.acceptsCode) return false;
  held.code = code;
  return true;
}

/** The poll reads the code once the store says "answered". */
export function peekCode(user: string, id: string): string | null {
  return waiting.get(keyOf(user, id))?.code ?? null;
}

const DONE = new Set(['done', 'fertig', 'erledigt', 'finished']);
const CODE = /^[0-9A-Za-z]{4,10}$/;

export type PersonReply =
  | { readonly kind: 'done' | 'declined' | 'invalid' }
  | { readonly kind: 'code'; readonly code: string };

/** Read a reply to a `person` question without a model. Yes/no words and "done" win over a code. */
export function parsePersonReply(text: string, acceptsCode: boolean): PersonReply {
  const parsed = parseAnswer(text);
  if (parsed.kind === 'yes') return { kind: 'done' };
  if (parsed.kind === 'no') return { kind: 'declined' };
  const word = text.trim().toLowerCase().replace(/[.!]$/, '');
  if (DONE.has(word)) return { kind: 'done' };
  if (acceptsCode && CODE.test(text.trim())) return { kind: 'code', code: text.trim() };
  return { kind: 'invalid' };
}

/** Why this call is refused, or `null`. An unset model is unknown, so a code is refused there too. */
export function personRefusal(
  task: ServeTask,
  profile: ServeProfile,
  input: PersonNeededInput,
): string | null {
  if (!task.personNeeded.enabled) return `task "${task.id}" does not have person_needed enabled`;
  if (!input.acceptsCode && !input.link) return null;
  if (!profile.model)
    return `person_needed with acceptsCode or link needs a profile that names its model: "${profile.id}" names none, so lotse cannot tell it is not a free hosted one`;
  if (isFreeModel(profile.model))
    return `person_needed with acceptsCode or link is refused on the free model "${profile.model}": a code or link must not reach a free hosted model`;
  return null;
}

/** What the person is shown. `withLink` is false for the copy that is stored. */
export function personText(input: PersonNeededInput, withLink = true): string {
  const lines = [
    msg(STRINGS.personAsk, { origin: input.origin, kind: input.kind }),
    input.prompt.trim(),
    withLink && input.link ? msg(STRINGS.personLink, { link: input.link }) : '',
    msg(input.acceptsCode ? STRINGS.personReplyCode : STRINGS.personReplyDone),
  ];
  return lines.filter((line) => line !== '').join('\n');
}
