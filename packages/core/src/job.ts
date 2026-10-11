/**
 * One headless job: input in, a typed value out, or a typed failure — ADR 0004.
 *
 * **Why this is not `AgentSession`.** A job has no turns to show and nobody watching: no composer, no
 * transcript, no permission dialog, no reattach. `AgentSession`'s state machine exists for a person in
 * front of a window, and a host extracting a receipt wants one awaited call that looks like its own
 * `LLMProvider` port. So this file is `openAgent` + `session/new` + `runTurn`, the same three steps
 * `serve/runner.ts` takes, with two gates in front of the prompt and a parser behind it.
 *
 * **What it keeps from lotse and what it refuses to have.** The agent command, the ACP client, the
 * model gate (`modelBlock`) and the fail-closed permission default are the widget's own — so a job runs
 * against the same agent, `HOME`/`XDG_*` and login as the chat. What it does not have is state: no
 * session record, no transcript, no log file. The agent may keep its own session under the host's data
 * directory; that is the host's data and the host's backup (ADR 0001).
 *
 * **Job input is private by default.** The prompt is somebody's receipt, the answer is what was read
 * off it. Neither appears in a log entry, in an error message or in a thrown error's text: `onLog`
 * gets ids and kinds, a `JobError`'s `message` is one of lotse's fixed sentences, and the raw answer is
 * on `JobError.output` for the host to look at — lotse never prints it.
 */

import {
  denyAll,
  isAuthRequired,
  type McpServer,
  type PermissionGate,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type StopReason,
} from '@lotse/acp';

import type { AgentCommand } from './agents/stdio.ts';
import { MODEL_CATEGORY, projectConfigOptions } from './config.ts';
import { AuthRequiredError } from './failure.ts';
import { modelAllowed, modelBlock, type ModelPolicy } from './model-policy.ts';
import { chunkToText } from './policy.ts';
import { openAgent, runTurn, withAuthHint, type AgentHandle, type OpenAgentOptions } from './run.ts';

/**
 * Why a job failed. One kind per remedy a host can take, and no kind that a retry would fix silently:
 * lotse never retries (a retry is another model call with private input — the host's decision).
 *
 * - `'malformed'` — the answer held no JSON in either accepted shape.
 * - `'invalid'` — it held JSON and the host's `parse` threw.
 * - `'denied'` / `'unknown-model'` — the model gate refused before any prompt went out.
 * - `'auth'` — the agent wants a login (or the provider refused the account).
 * - `'refused'` — the turn did not end with `end_turn`, or a permission was declined.
 * - `'timeout'` / `'cancelled'` — `timeoutMs` ran out, or the host's `signal` aborted.
 * - `'agent'` — the process failed: it did not start, did not shake hands, or ended mid-job.
 */
export type JobErrorKind =
  | 'malformed'
  | 'invalid'
  | 'denied'
  | 'unknown-model'
  | 'auth'
  | 'refused'
  | 'timeout'
  | 'cancelled'
  | 'agent';

/**
 * The one sentence per kind. **Fixed English and nothing interpolated**, because anything interpolated
 * is a chance for the prompt, the answer or a model's free text to reach a host's log through
 * `error.message`. The host who needs more reads `kind`, `output` and `cause`.
 */
const JOB_ERROR_MESSAGES: Readonly<Record<JobErrorKind, string>> = {
  malformed: 'the agent answered, but the answer holds no JSON value lotse can read',
  invalid: "the agent's JSON answer did not pass the host's parse",
  denied: 'the model this agent would use is not allowed by the host, so nothing was sent',
  'unknown-model': 'lotse cannot confirm which model this agent would use, so nothing was sent',
  auth: 'the agent wants a login before it runs this job',
  refused: 'the agent did not finish the job: the turn ended early or a permission was declined',
  timeout: 'the job did not finish within its time limit and was cancelled',
  cancelled: 'the job was cancelled',
  agent: 'the agent process failed before the job finished',
};

/** Every way `runJob` rejects. `instanceof JobError` and a `kind` switch is the whole contract. */
export class JobError extends Error {
  readonly kind: JobErrorKind;
  /**
   * The agent's raw final message, when there was one (`'malformed'`, `'invalid'`, `'refused'`).
   * **For the host to inspect, never printed by lotse** — it is model output about private input.
   */
  readonly output: string | null;

  constructor(kind: JobErrorKind, options: { cause?: unknown; output?: string | null } = {}) {
    super(JOB_ERROR_MESSAGES[kind], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JobError';
    this.kind = kind;
    this.output = options.output ?? null;
  }
}

/**
 * What `onLog` receives. `job` entries are lotse's own and carry ids and kinds only — the session id,
 * a stop reason, a tool kind, an error kind, the model id — never a prompt, an answer, a parse error's
 * text or a tool's arguments. `agent` entries are the agent's stderr lines, delivered unread; they
 * reach a host only because it passed `onLog` (ADR 0004 §9).
 */
export type JobLogEntry =
  | {
      readonly source: 'job';
      readonly event: 'start' | 'session' | 'gate' | 'end' | 'error';
      readonly detail: Readonly<Record<string, string>>;
    }
  | { readonly source: 'agent'; readonly line: string };

export interface JobOptions<T> {
  /** The agent, exactly as the widget gets it — so the same agent, `HOME`/`XDG_*` and login. */
  readonly command: AgentCommand;
  /** The `session/new` working directory. */
  readonly cwd: string;
  readonly prompt: string;
  /** Validates the parsed JSON and throws on a mismatch. A Zod `schema.parse` fits as is. */
  readonly parse: (value: unknown) => T;
  /**
   * Required on purpose: a host that wants no restriction passes `() => 'allow'` and says so in its own
   * code. A model the agent does not name (`'unknown'`) is refused as well as a denied one.
   */
  readonly modelPolicy: ModelPolicy;
  /** Select this model through the session's model option. Absent: the agent's current one. */
  readonly model?: string;
  /** A JSON Schema appended to the prompt with one fixed instruction. Validation stays `parse`'s. */
  readonly schema?: object;
  /** Forwarded unchanged to `session/new`. Default `[]`. */
  readonly mcpServers?: readonly McpServer[];
  /** Answers the agent's permission requests. Default `denyAll`; nobody is ever asked. */
  readonly gate?: PermissionGate;
  readonly signal?: AbortSignal;
  /** Over the whole job — handshake, `session/new`, the turn. Default `JOB_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  readonly onLog?: (entry: JobLogEntry) => void;
  /** The agent opener. Default `openAgent`; a test passes a fixture, a pool could come later. */
  readonly open?: (options: OpenAgentOptions) => Promise<AgentHandle>;
}

export interface JobResult<T> {
  readonly value: T;
  readonly sessionId: string;
  /** The model the agent reported as current when the prompt went out. */
  readonly model: string;
  readonly stopReason: StopReason;
}

/** The default for `timeoutMs`: two minutes covers a cold `opencode acp` and a long extraction. */
export const JOB_TIMEOUT_MS = 120_000;

/**
 * How long a cancelled turn gets to answer `cancelled` before the process is closed anyway. Short: a
 * job nobody waits for has nothing to save, and the close ends the work either way.
 */
const CANCEL_GRACE_MS = 2_000;

/**
 * Run one job: a fresh agent, a fresh session, one turn, closed on every path.
 *
 * The order is the policy: the model gate is decided before the prompt exists on the wire, the
 * permission gate answers during the turn without asking anybody, and the answer is only a value once
 * the host's `parse` accepted it.
 */
export async function runJob<T>(options: JobOptions<T>): Promise<JobResult<T>> {
  // A JS caller can omit the policy, and `modelBlock(…, undefined)` means "no host policy, allow" —
  // the widget's default, and exactly the wrong answer here. Refused before anything starts.
  if (typeof options.modelPolicy !== 'function') {
    throw new TypeError('runJob needs a modelPolicy; pass () => "allow" to allow every model');
  }
  const log = (event: Extract<JobLogEntry, { source: 'job' }>['event'], detail: Record<string, string>) =>
    options.onLog?.({ source: 'job', event, detail });
  if (options.signal?.aborted) {
    log('error', { kind: 'cancelled' });
    throw new JobError('cancelled');
  }

  const open = options.open ?? openAgent;
  let handle: AgentHandle | null = null;
  let closeSpawned: (() => void) | null = null;
  let sessionId: string | null = null;
  let turn: Promise<unknown> | null = null;
  let stopped: 'timeout' | 'cancelled' | null = null;
  let finished = false;
  let declined = false;
  let wakeStop!: () => void;
  const stop = new Promise<void>((resolve) => {
    wakeStop = resolve;
  });

  const halt = (kind: 'timeout' | 'cancelled'): void => {
    if (stopped !== null || finished) return;
    stopped = kind;
    // `session/cancel` only means something once a turn is running; before that the close is the
    // whole answer, and the spawn closer covers a handshake that never ended.
    if (sessionId !== null && turn !== null && handle !== null) {
      try {
        handle.client.cancel({ sessionId });
      } catch {
        // The connection is already gone; the close below is all that is left to do.
      }
    }
    wakeStop();
  };
  const onAbort = (): void => halt('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => halt('timeout'), options.timeoutMs ?? JOB_TIMEOUT_MS);

  const gate: PermissionGate = async (request) => {
    const answer = await answerPermission(options.gate ?? denyAll, request);
    if (answer === null) declined = true;
    log('gate', {
      session: request.sessionId,
      tool: String(request.toolCall?.kind ?? 'unknown'),
      answer: answer === null ? 'decline' : 'allow_once',
    });
    return answer;
  };

  const body = async (): Promise<JobResult<T>> => {
    const opened = await open({
      command: options.command,
      gate: { permission: gate },
      ...(options.onLog ? { onLog: (line: string) => options.onLog?.({ source: 'agent', line }) } : {}),
      onSpawn: (close) => {
        closeSpawned = close;
      },
    });
    if (finished || stopped !== null) {
      // The race was lost while the handshake ran: nobody else will close this one.
      await opened.close();
      throw new JobError(stopped ?? 'cancelled');
    }
    handle = opened;
    const client = opened.client;
    const session = await withAuthHint('session/new', () =>
      client.newSession({ cwd: options.cwd, mcpServers: [...(options.mcpServers ?? [])] }),
    );
    sessionId = session.sessionId;
    log('session', { session: session.sessionId });

    let configOptions = session.configOptions ?? null;
    if (options.model !== undefined) {
      if (!modelAllowed(options.modelPolicy, options.model)) throw new JobError('denied');
      configOptions = await selectModel(client, session.sessionId, configOptions, options.model);
    }
    const block = modelBlock(configOptions, options.modelPolicy);
    if (block !== null) throw new JobError(block.cause === 'denied' ? 'denied' : 'unknown-model');
    const model = currentModel(configOptions);
    if (model === null) throw new JobError('unknown-model');
    if (stopped !== null) throw new JobError(stopped);

    let message = '';
    turn = runTurn(client, {
      sessionId: session.sessionId,
      text: jobPrompt(options.prompt, options.schema),
      onUpdate: (notification) => {
        if (notification.sessionId !== session.sessionId) return;
        if (notification.update.sessionUpdate === 'agent_message_chunk')
          message += chunkToText(notification.update.content);
      },
    });
    const { stopReason } = (await turn) as { stopReason: StopReason };
    log('end', { session: session.sessionId, stopReason, model });
    // The `cancelled` answer to our own `session/cancel` usually lands before the stop branch of the
    // race runs; the stop is why the turn ended, so it names the failure, not `'refused'`.
    if (stopped !== null) throw new JobError(stopped);
    // An agent that hears "no" often still ends its turn normally; the job was refused all the same.
    if (stopReason !== 'end_turn' || declined) throw new JobError('refused', { output: message });
    const found = jsonOf(message);
    if (!found.ok) throw new JobError('malformed', { output: message });
    let value: T;
    try {
      value = options.parse(found.value);
    } catch (error) {
      throw new JobError('invalid', { cause: error, output: message });
    }
    return { value, sessionId: session.sessionId, model, stopReason };
  };

  log('start', {});
  const running = body();
  // The loser of the race below still settles, usually by rejecting on the closed connection.
  running.catch(() => {});
  try {
    return await Promise.race([
      running,
      stop.then(async (): Promise<never> => {
        if (turn !== null) await settleWithin(turn, CANCEL_GRACE_MS);
        throw new JobError(stopped ?? 'cancelled');
      }),
    ]);
  } catch (error) {
    const failure =
      stopped !== null && !(error instanceof JobError) ? new JobError(stopped) : toJobError(error);
    const id = sessionId as string | null;
    log('error', id === null ? { kind: failure.kind } : { kind: failure.kind, session: id });
    throw failure;
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    // `handle` is a `let` assigned in a closure, which narrowing cannot see.
    const opened = handle as AgentHandle | null;
    if (opened !== null) await opened.close();
    else (closeSpawned as (() => void) | null)?.();
  }
}

/**
 * The host's gate, held to ADR 0004 §6: a throw is a decline, an id the agent did not offer is a
 * decline, and so is any `*_always` or `reject_*` option — a job allows once or not at all, and an
 * "always" would be a standing grant handed to an agent nobody watches.
 */
async function answerPermission(
  host: PermissionGate,
  request: RequestPermissionRequest,
): Promise<string | null> {
  let chosen: string | null;
  try {
    chosen = await host(request);
  } catch {
    return null;
  }
  if (chosen === null) return null;
  const option = (request.options ?? []).find((candidate) => candidate.optionId === chosen);
  return option?.kind === 'allow_once' ? chosen : null;
}

/** Select `model` through the session's model option, as `serve` does. No fallback, ever. */
async function selectModel(
  client: AgentHandle['client'],
  sessionId: string,
  options: SessionConfigOption[] | null,
  model: string,
): Promise<SessionConfigOption[] | null> {
  const control = projectConfigOptions(options).find((candidate) => candidate.category === MODEL_CATEGORY);
  if (!control || control.kind !== 'select' || !control.values.some((value) => value.value === model)) {
    throw new JobError('unknown-model');
  }
  if (control.currentValue === model) return options;
  const answer = await client.setConfigOption({ sessionId, configId: control.id, value: model });
  return answer.configOptions ?? options;
}

function currentModel(options: SessionConfigOption[] | null): string | null {
  const control = projectConfigOptions(options).find(
    (candidate) => candidate.category === MODEL_CATEGORY && candidate.kind === 'select',
  );
  return control?.kind === 'select' ? control.currentValue : null;
}

/** The one fixed instruction a `schema` adds. The prompt stays first, the schema last. */
export function jobPrompt(prompt: string, schema?: object): string {
  if (schema === undefined) return prompt;
  return [
    prompt,
    '',
    'Answer with exactly one JSON value that matches this JSON Schema, and nothing else:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

const FENCED_JSON = /```json[^\S\r\n]*\r?\n([\s\S]*?)```/g;

/**
 * The two shapes ADR 0004 accepts, and nothing else: the whole trimmed message is one JSON value, or
 * the message's **last** ```` ```json ```` block is. No brace hunting and no repair — a guess that
 * turned prose into a value would hand the host something the model never committed to.
 */
function jsonOf(message: string): { ok: true; value: unknown } | { ok: false } {
  const whole = tryJson(message.trim());
  if (whole.ok) return whole;
  const blocks = [...message.matchAll(FENCED_JSON)];
  const last = blocks.at(-1);
  return last ? tryJson((last[1] ?? '').trim()) : { ok: false };
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Classify by type, never by wording — the `failure.ts` rule. Everything unrecognised is the process. */
function toJobError(error: unknown): JobError {
  if (error instanceof JobError) return error;
  if (error instanceof AuthRequiredError || isAuthRequired(error))
    return new JobError('auth', { cause: error });
  return new JobError('agent', { cause: error });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
