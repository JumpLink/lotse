/**
 * `frontends/gui/model-policy-hook.ts` — what `LOTSE_APP_MODEL_POLICY`'s list means.
 *
 * **The first case is a regression test, and it is the one that matters.** While this was four lines
 * inside `main.ts`, the empty list built a predicate that denied nothing — which looks like no rule
 * and is not one. A *present* policy makes a model the agent has not reported yet `unknown`,
 * `modelBlock` fails closed on `unknown`, and lotse's own window then refused the first turn of every
 * ordinary run with "This model is not allowed here". `model-policy.test.ts` could not catch it: every
 * case there passes a policy on purpose. The distinction that needed a test was *absent* versus
 * *present and permissive*, which only this mapping makes.
 *
 * Both runtimes, no display, for `hook-value.test.ts`'s reason: `readHooks` drags `Adw` in and this
 * does not.
 */
import { describe, expect, it } from '@gjsify/unit';

import { denyFreeHostedModels } from '@lotse/core';

import { modelPolicyFromHook } from '../../../src/frontends/gui/model-policy-hook.ts';

export default async function run(): Promise<void> {
  await describe('the model-policy hook as a policy', async () => {
    await it('is no policy at all when the variable is unset', async () => {
      // `hookList` answers an unset variable with `[]`, so this is the shape every ordinary run takes.
      // `undefined` rather than a permissive predicate: see the file comment.
      expect(modelPolicyFromHook([])).toBe(undefined);
    });

    await it('reaches for the ready-made rule on the one word', async () => {
      expect(modelPolicyFromHook(['free'])).toBe(denyFreeHostedModels);
    });

    await it('denies the ids it was given and allows the rest', async () => {
      const policy = modelPolicyFromHook(['vendor/paid-1', 'vendor/paid-2']);
      expect(policy?.('vendor/paid-1')).toBe('deny');
      expect(policy?.('vendor/paid-2')).toBe('deny');
      expect(policy?.('vendor/paid-3')).toBe('allow');
    });

    await it('reads `free` beside an id as an id, not as the keyword', async () => {
      // The word is a shorthand for the whole list, so it only means that when it is the whole value.
      // Mixing the two would make `free,vendor/paid-1` a rule nobody could read off the variable.
      const policy = modelPolicyFromHook(['free', 'vendor/paid-1']);
      expect(policy).not.toBe(denyFreeHostedModels);
      expect(policy?.('free')).toBe('deny');
      expect(policy?.('vendor/model-free')).toBe('allow');
    });
  });
}
