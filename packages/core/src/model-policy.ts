/**
 * Which models a host lets a prompt reach, and every decision that follows from a denial.
 *
 * **Why a host needs this at all.** `LotseChat` is embeddable (ADR 0001), and a host that embeds it
 * may be carrying data the person has not agreed to hand to anybody — an app around a document
 * store, a window over somebody's accounts. The agent decides which models *exist*; the host is the
 * only party that knows which of them its own data may travel to. Without a seam for that, a host
 * has exactly two options: ship no chat, or ship one whose model list is a list of places its data
 * could go.
 *
 * **It is a predicate the host passes, not a table lotse keeps.** `free-models.ts` already says why
 * lotse does not hold a model policy of its own: a hardcoded list rots, and a client that chooses a
 * model holds configuration authority over the agent. The same argument makes *this* a parameter —
 * `LotseChatOptions.modelPolicy`, defaulting to absent — so lotse's own window behaves exactly as
 * it did and a host's rule is the host's.
 *
 * **Fail closed, in the shape `gate.ts` already uses for permissions.** A policy that throws is a
 * deny (`modelAllowed`), and so is any return value that is not the literal `'allow'`: a host whose
 * policy code broke has not approved anything. There is deliberately no third answer that *selects*
 * a model — lotse never picks one (`free-models.ts`), and a host that could pick would be choosing
 * for the person through a seam they cannot see.
 *
 * ## The two gates, and why one is not enough
 *
 * A session's model is only known once the agent has answered — `session/new` carries the option
 * list, and `session/new` goes out **on the first prompt** (`AgentSession.#runNewConversation`). So
 * at the moment the composer would like to block, there is nothing to check yet. A composer that
 * blocked on "no model reported" would make the first prompt unsendable forever, which is the whole
 * window.
 *
 * Hence `ModelBlock.cause`, read by two callers with different jobs:
 *
 * - **the composer** blocks on `'denied'` only — the agent has told us what it would use and the
 *   host says no. `'unknown'` is ignored there, because before the first prompt it is simply "not
 *   yet" and the person must be able to send the prompt that answers it;
 * - **`AgentSession.#deliver`** refuses on **both**, by throwing `ModelDeniedError` before
 *   `session/prompt` goes out. That call happens *after* the handshake and after `session/new`, so
 *   by then `'unknown'` means something real: the agent reported options and none of them is a model
 *   control, so lotse cannot verify where this prompt would go. A prompt is not sent to a model
 *   nobody has named.
 *
 * **Nothing here switches a model.** A denied current value is reported and refused; it is never
 * quietly replaced with an allowed one. A host that silently moved the person to another model would
 * be making the choice the composer's sentence asks *them* to make, and the next answer would come
 * from a model they never picked.
 */

import { _, N_ } from './i18n.ts';
import type { SessionConfigOption } from '@lotse/acp/types';

import { MODEL_CATEGORY, projectConfigOptions } from './config.ts';
import { isFreeModel } from './free-models.ts';

/** What a policy may answer about one model id. Neither value selects anything. */
export type ModelDecision = 'allow' | 'deny';

/**
 * A host's rule, over one model id as the **agent** spells it.
 *
 * The id and not a richer object, because the id is the only thing lotse actually knows: the agent
 * sends a value id and a display name, and a name is a label an agent may reword. A policy that has
 * to match on something is given the part that is stable.
 *
 * `allowsProvider`, when present, answers for a provider nobody has connected yet — one with no model
 * ids to ask about (`providerOffered`). It only decides what is *offered*; the prompt gate asks the
 * predicate itself either way.
 */
export type ModelPolicy = ((model: string) => ModelDecision) & {
  readonly allowsProvider?: (providerId: string) => boolean;
};

/**
 * Ask the policy, and treat everything that is not an explicit `'allow'` as a deny.
 *
 * **The `try` is the policy, not defensive coding.** A host's predicate is host code running inside
 * lotse's render path: it can throw on a model id it did not expect, and the honest reading of "my
 * policy crashed" is "I have not approved this". The alternative — letting the throw propagate — would
 * take the config row down and leave the denied model selected, which is the failure this file exists
 * to prevent, arrived at through a stack trace.
 *
 * An absent policy allows everything, which is what keeps the no-policy path identical to the one
 * that existed before this file: every caller passes `policy` straight through from an optional
 * option, so "the host set nothing" is answered here once rather than at each call site.
 */
export function modelAllowed(policy: ModelPolicy | undefined, model: string): boolean {
  if (policy === undefined) return true;
  try {
    return policy(model) === 'allow';
  } catch {
    return false;
  }
}

/**
 * Keep the values a policy allows, in the caller's order.
 *
 * **Generic over the value for the reason `freeModelFirst` is**: it is applied to `ConfigValue[]` and
 * the projection reads the result back with its own type, and a function returning `ConfigValue[]`
 * would push a cast to the call site.
 *
 * With no policy this is a copy and nothing else — the same `[...values]` the caller would have had.
 */
export function allowedModelValues<T extends { readonly value: string }>(
  values: readonly T[],
  policy?: ModelPolicy,
): T[] {
  if (policy === undefined) return [...values];
  return values.filter((value) => modelAllowed(policy, value.value));
}

/**
 * The ready-made policy: **no free hosted model may be prompted.**
 *
 * **What counts as free is `isFreeModel`'s answer, not a second list.** That is any id ending in
 * `-free` plus the few free ids without the suffix, and `lotse serve` has been reading it for the same
 * purpose since ADR 0003: a free model may be trained on, and a host carrying somebody's private data
 * has no business deciding that for them. One criterion, one place it is maintained.
 *
 * **The hard gate beside the warning.** Every surface warns while a free model is in use
 * (`FREE_MODEL_WARNING`), and a person may dismiss that. A host whose data must never reach one passes
 * this policy instead, and then nothing is dismissed: the prompt is refused.
 *
 * **An id this classification has never heard of is allowed, and that is a choice with a reason.**
 * The alternative — deny everything unknown — reads safer and is unusable: the classification knows
 * one suffix and an exact id or two, so "unknown" is ~400 of the ~400 models `opencode acp` reports,
 * *including every paid one*. A widget whose every model is denied has no allowed model to offer, so
 * the composer blocks permanently and the sentence under it asks the person to choose something that
 * does not exist. The genuinely uncertain case — "which model is even in use?" — is caught by the
 * other gate (`modelBlock`'s `'unknown'`), where the answer is a refusal rather than a dead window.
 *
 * **So this is the known limit, written down rather than implied:** a free model shipped without a
 * list entry and without the `-free` suffix is not caught. A host that needs certainty passes its own
 * `ModelPolicy` with an **allowlist** — that is exactly why the option is a predicate and not a flag.
 *
 * An empty or blank id is denied: it is not a model anybody named, and `isFreeModel('')` is `false`,
 * which would otherwise read as an allow.
 */
export const denyFreeHostedModels: ModelPolicy = (model) => {
  if (typeof model !== 'string' || model.trim() === '') return 'deny';
  return isFreeModel(model) ? 'deny' : 'allow';
};

/**
 * The allowlist policy: **only models served through one of these providers may be prompted.**
 *
 * The provider is the part of an id before the first `/` (`anthropic/claude-sonnet-4-5` →
 * `anthropic`), compared exactly. An id with no provider part, a blank one or an empty provider is
 * denied, and so is everything when the list is empty. Unlike `denyFreeHostedModels` this needs no
 * knowledge of which models are free: a model nobody has heard of is denied unless its provider is
 * named, so a new free model cannot slip through a stale list. It does not look inside a provider —
 * `openrouter/…:free` is allowed if `openrouter` is — so combine it with `denyFreeHostedModels` where
 * that matters. It answers `allowsProvider` too, so the login dialog offers only the named providers.
 */
export function allowOnlyProviders(providers: readonly string[]): ModelPolicy {
  const allowed = new Set(providers);
  const policy = (model: string): ModelDecision => {
    if (typeof model !== 'string') return 'deny';
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) return 'deny';
    return allowed.has(model.slice(0, slash)) ? 'allow' : 'deny';
  };
  return Object.assign(policy, { allowsProvider: (providerId: string) => allowed.has(providerId) });
}

/**
 * Whether a provider is worth **offering** — in the login dialog and the settings group — under a policy.
 *
 * Offered when one of its known models is allowed (`<provider>/<model>`, the agent's spelling). A provider
 * nobody has connected has no known models (opencode's `/api/model` lists only usable ones, measured on
 * 2.0.25), and a model predicate cannot be asked about a provider: an allowlist of exact model ids would
 * deny any made-up stand-in and so hide every provider. So such a provider is offered by the policy's
 * `allowsProvider` when it has one (a throw is a no), and **offered** when it has none — the prompt gate
 * (`modelBlock`) still refuses a denied model once one is picked.
 */
export function providerOffered(
  policy: ModelPolicy | undefined,
  providerId: string,
  models: readonly string[] = [],
): boolean {
  if (policy === undefined) return true;
  if (models.length > 0) return models.some((model) => modelAllowed(policy, `${providerId}/${model}`));
  if (policy.allowsProvider === undefined) return true;
  try {
    return policy.allowsProvider(providerId) === true;
  } catch {
    return false;
  }
}

/** Why a prompt cannot go out, and which of the two gates may act on it. See the file header. */
export interface ModelBlock {
  /**
   * `'denied'` — the agent named the model it would use and the policy said no.
   * `'unknown'` — lotse cannot name it: the agent has not answered yet, or it reported no model
   * control at all. Only `#deliver` acts on this one.
   */
  readonly cause: 'denied' | 'unknown';
  /** What a person is told. Fixed English, lotse's own words, no agent text and no model id. */
  readonly reason: string;
}

/**
 * The sentence for a denied model.
 *
 * **It names no model id**, for the reason `failureNotice`'s `'model'` body names no provider: the
 * id is the agent's own string, it is already on screen in the dropdown the sentence points at, and
 * repeating it in a caption adds a line of agent text to a label for no information. What a person
 * needs is the one thing they can do.
 */
export const MODEL_DENIED_REASON = N_(
  'This model is not allowed here. Pick another one from the model list, then send.',
);

/** The sentence for a model lotse cannot name. It says what happened and does not blame the agent. */
export const MODEL_UNKNOWN_REASON = N_(
  'lotse cannot tell which model this agent would use, so nothing was sent.',
);

/**
 * Whether a prompt may go out, as data.
 *
 * `null` means yes — including for every caller that set no policy, which is what makes this a
 * no-op for lotse's own window.
 *
 * **Read from the agent's raw options and never from the drawn row.** The row has the denied values
 * filtered out of it (`config-row.ts`), so asking the row what is in use would answer "nothing" for
 * exactly the case this function exists to catch. `currentValue` on the agent's own list is the only
 * truth about what a prompt would reach.
 */
export function modelBlock(
  options: SessionConfigOption[] | null | undefined,
  policy?: ModelPolicy,
): ModelBlock | null {
  if (policy === undefined) return null;
  if (options === null || options === undefined) {
    return { cause: 'unknown', reason: _(MODEL_UNKNOWN_REASON) };
  }
  const control = projectConfigOptions(options).find(
    (candidate) => candidate.category === MODEL_CATEGORY && candidate.kind === 'select',
  );
  if (control === undefined || control.kind !== 'select') {
    return { cause: 'unknown', reason: _(MODEL_UNKNOWN_REASON) };
  }
  if (modelAllowed(policy, control.currentValue)) return null;
  return { cause: 'denied', reason: _(MODEL_DENIED_REASON) };
}

/**
 * The model in use, when it is a free one; `null` otherwise, including while no model is known.
 *
 * From the agent's **raw** options, for `modelBlock`'s reason: the drawn row may have the value in use
 * filtered out of it.
 */
export function freeModelInUse(options: SessionConfigOption[] | null | undefined): string | null {
  const control = projectConfigOptions(options ?? null).find(
    (candidate) => candidate.category === MODEL_CATEGORY && candidate.kind === 'select',
  );
  if (control === undefined || control.kind !== 'select') return null;
  return isFreeModel(control.currentValue) ? control.currentValue : null;
}

/**
 * What `#deliver` throws instead of sending a prompt.
 *
 * **A class rather than a flag on the return, for `AuthRequiredError`'s reason:** the refusal has to
 * travel out through the same `catch` every other failure in a turn travels through, so the turn
 * settles, the state machine moves and `failureKind` can classify it (`'denied'`). A `#deliver` that
 * returned early would leave the turn in `thinking` with nothing coming.
 *
 * The `message` **is** `block.reason`, so `describe(error)` — which is what reaches the attachment and
 * the failure dialog — is already the sentence a person should read.
 */
export class ModelDeniedError extends Error {
  /** Which gate refused, kept so a caller can tell "denied" from "could not verify". */
  readonly block: ModelBlock;

  constructor(block: ModelBlock) {
    super(block.reason);
    this.name = 'ModelDeniedError';
    this.block = block;
  }
}
