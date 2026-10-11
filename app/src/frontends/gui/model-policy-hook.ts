/**
 * What `LOTSE_APP_MODEL_POLICY`'s list *means* — the one decision that turns a dev hook into the
 * host policy `LotseChat` takes.
 *
 * **Its own file because the empty case is the default path of the whole app.** `hookList` answers an
 * unset variable with `[]`, and a predicate built from an empty list denies nothing — which reads
 * like "no rule" and is not one. A policy that is merely *present* makes a model nobody has reported
 * yet `unknown`, `modelBlock` fails closed on `unknown`, and lotse's own window then refused the
 * first turn of every ordinary run with "This model is not allowed here". The bug was invisible in
 * the policy's own tests, because those all pass a policy on purpose. So the mapping lives where it
 * can be run on both runtimes, with the empty list as its first case.
 *
 * `main.ts` still owns the *choice* to have no policy at all — this file only reads the hook that
 * stands in for one, and what it builds is the example of what a real host writes: a predicate of
 * the host's own, over ids the host knows.
 */

import { denyFreeHostedModels, type ModelPolicy } from '@lotse/core';

/** The one word that reaches for the ready-made policy instead of naming ids. */
const FREE = 'free';

/**
 * The hook's list as a policy, or `undefined` for no policy at all.
 *
 * - `[]` (the variable unset) → `undefined`. Not a policy that allows everything: see above.
 * - `['free']` → `denyFreeHostedModels`, the ready-made one.
 * - anything else → deny exactly those ids, allow the rest.
 */
export function modelPolicyFromHook(denied: readonly string[]): ModelPolicy | undefined {
  if (denied.length === 0) return undefined;
  if (denied.length === 1 && denied[0] === FREE) return denyFreeHostedModels;
  return (model) => (denied.includes(model) ? 'deny' : 'allow');
}
