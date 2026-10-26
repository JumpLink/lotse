/**
 * Which models are free, read off the agent's own list at runtime, and the warning a free one earns.
 *
 * **No maintained list, on purpose.** Until 2026-10 this file read `data/free-models.json`, a hand-kept
 * set of ids that were free *and* documented as zero-retention. It rotted in two weeks: on 2026-10-16
 * `opencode models` (2.0.28) offered twelve free models and the file named two of them. The free tier
 * rotates faster than anybody re-reads a provider page, so the classification is now a rule over the
 * id the agent sends — the `-free` suffix opencode gives its free tier, plus the few free ids that do not
 * carry it — and a new free model is recognised the day it appears.
 *
 * **Zero-retention is no longer claimed for any model.** It is not in the id, and the only source is a
 * web page. So every free model gets the same warning (`FREE_MODEL_WARNING`): a provider of a free model
 * may keep what it is sent and train on it. The person decides; lotse says so every time.
 *
 * **Three things it deliberately does not do**, and each of them is a rule rather than an omission:
 *
 * - **Never selects.** `freeModelFirst` returns the same list, reordered. Nothing here writes a
 *   `currentValue`, and the agent's `currentValue` is still what `core/config.ts` projects as the
 *   selection — a client that picked a model would be holding configuration authority over the agent,
 *   which is the "always allow" mistake in different clothes (`core/config-row.ts`'s header).
 * - **Never hides.** Every id the agent offered is still in the list, in its original relative order
 *   within its group. A model lotse stopped showing is a model a person cannot go back to.
 * - **Never probes.** Whether a free model answers from here (a region block, a quota) is found out by
 *   the prompt the person sends, not by burning a turn on each candidate.
 */

import { N_ } from './i18n.ts';

/**
 * Free ids that do not end in `-free`. Measured with `opencode models` on 2026-10-16 (2.0.28).
 *
 * A stale entry here costs nothing: an id that has gone away matches nothing. A missing one costs the
 * warning and the sort for that model, which is why the list is kept to what was measured.
 */
export const FREE_MODELS_WITHOUT_SUFFIX: readonly string[] = ['opencode/big-pickle'];

/**
 * A model id from a provider's free tier, which may keep and train on what it is sent.
 *
 * **A classification, not a policy**: who may prompt one is decided by `lotse listen`'s task
 * configuration (`serve/config.ts`), a host's `ModelPolicy` (`model-policy.ts`) and the person, who is
 * shown `FREE_MODEL_WARNING`. All of them read this one function.
 *
 * **It lives here and not in `serve/config.ts`**, which imports `node:crypto`; a widget asking "is this
 * model free" through it would pull `createHash` and the task-file parser into a GTK bundle.
 *
 * What it cannot catch is a free model shipped with neither the suffix nor an entry in
 * `FREE_MODELS_WITHOUT_SUFFIX`; `denyFreeHostedModels` says so where a host can read it.
 */
export function isFreeModel(model: string): boolean {
  return model.endsWith('-free') || FREE_MODELS_WITHOUT_SUFFIX.includes(model);
}

/**
 * Move every free value to the front, and keep the agent's order inside both groups.
 *
 * **The agent's order is kept because it is a statement the agent made** (`core/config.ts`: "an agent
 * that puts its recommended model first knows something about its user"). The only thing lotse adds is
 * which group a value is in.
 *
 * **Generic over the value, so the call site keeps its own type.** It is applied to `ConfigValue[]` and
 * the projection reads the result back.
 */
export function freeModelFirst<T extends { readonly value: string }>(
  values: readonly T[],
  free: (model: string) => boolean = isFreeModel,
): T[] {
  return [...values.filter((value) => free(value.value)), ...values.filter((value) => !free(value.value))];
}

/**
 * The warning shown while a free model is in use. One sentence pair for every surface — the widget,
 * and any host that draws its own — so the wording cannot drift between two apps.
 */
export const FREE_MODEL_WARNING = N_(
  'Free model: providers of free models may store what you send and train on it. Not suitable for ' +
    'confidential data such as tax or client records — use it to try things out.',
);

/**
 * Whether the warning is owed: a free model is in use and the person has not dismissed it **for that
 * model**.
 *
 * **Dismissed per model, never for good.** Picking another free model brings it back, and so does the
 * next conversation (the caller forgets `dismissed` there). A "never show again" would be one click
 * that, half a year later, nobody remembers making — and the data it guards does not get less private.
 */
export function freeModelWarningDue(freeModel: string | null, dismissed: string | null): boolean {
  return freeModel !== null && freeModel !== dismissed;
}
