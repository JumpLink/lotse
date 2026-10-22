/**
 * Which models are free, the sort that puts them first, and when the warning about them is owed.
 *
 * The classification is a rule over the id the agent sends (`-free`, plus a short list of exceptions),
 * so most cases here are about that rule's edges: what it must catch, and the paid ids it must not
 * drag up beside a free one.
 *
 * Both runtimes, no display — the same bargain as every other `core/` test: a decision about which
 * model ids appear first, or whether a warning is shown, is invisible in a screenshot and cheap to get
 * wrong.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  FREE_MODEL_WARNING,
  FREE_MODELS_WITHOUT_SUFFIX,
  configRowInput,
  freeModelFirst,
  freeModelInUse,
  freeModelWarningDue,
  isFreeModel,
  modelControl,
  type ConfigValue,
} from '@lotse/core';
import type { SessionConfigOption } from '@lotse/acp/types';

/** The agent's list, in the agent's order. */
function values(...ids: string[]): ConfigValue[] {
  return ids.map((id) => ({ value: id, name: id, description: null, group: null }));
}

function ids(list: readonly ConfigValue[]): string[] {
  return list.map((entry) => entry.value);
}

const HINT = ['opencode/space-bunny-free', 'opencode/longcat-2.5-preview-free'];

/** One model option whose current value is `current`. */
function modelOption(current: string): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: current,
      options: [
        { value: current, name: current },
        { value: 'openrouter/vendor/paid', name: 'paid' },
      ],
    },
  ];
}

export default async function freeModels(): Promise<void> {
  await describe('free models — which ids count', async () => {
    await it('counts every id ending in -free, so a new free model is caught the day it appears', async () => {
      expect(isFreeModel('opencode/space-bunny-free')).toBe(true);
      expect(isFreeModel('opencode/a-model-nobody-has-heard-of-free')).toBe(true);
    });

    await it('counts the free ids without the suffix', async () => {
      expect(isFreeModel('opencode/big-pickle')).toBe(true);
      for (const id of FREE_MODELS_WITHOUT_SUFFIX) expect(isFreeModel(id)).toBe(true);
    });

    await it('names the exceptions with their provider, because a bare name matches nothing', async () => {
      // Exact string matching: `big-pickle` would never equal the value the agent sends.
      for (const id of FREE_MODELS_WITHOUT_SUFFIX) expect(id).toContain('/');
    });

    await it('does not count a paid id that merely contains "free"', async () => {
      expect(isFreeModel('opencode/space-bunny-free-pro')).toBe(false);
      expect(isFreeModel('vendor/freedom-1')).toBe(false);
      expect(isFreeModel('opencode/big-pickle-pro')).toBe(false);
      expect(isFreeModel('other/big-pickle')).toBe(false);
    });
  });

  await describe('free models — what the sort does', async () => {
    await it('moves a free id to the front', async () => {
      const sorted = freeModelFirst(values('openrouter/a/model', 'opencode/space-bunny-free'));
      expect(ids(sorted)).toEqualArray(['opencode/space-bunny-free', 'openrouter/a/model']);
    });

    await it('keeps the agent’s order within both groups', async () => {
      // The order is a statement the agent made — its own recommended models first — and lotse has no
      // business re-ordering any of it beyond which group a model is in.
      const sorted = freeModelFirst(
        values('a/1', 'opencode/space-bunny-free', 'a/2', 'opencode/big-pickle', 'a/3'),
      );
      expect(ids(sorted)).toEqualArray([
        'opencode/space-bunny-free',
        'opencode/big-pickle',
        'a/1',
        'a/2',
        'a/3',
      ]);
    });

    await it('hides nothing — every id the agent offered is still in the list', async () => {
      const list = values('a/1', 'b/2', 'c/3', 'opencode/space-bunny-free');
      const sorted = freeModelFirst(list);
      expect(sorted.length).toBe(list.length);
      expect([...ids(sorted)].sort()).toEqualArray([...ids(list)].sort());
    });

    await it('takes another classification, so a host can sort by its own rule', async () => {
      const list = values('a/1', 'b/2');
      expect(ids(freeModelFirst(list, (id) => id === 'b/2'))).toEqualArray(['b/2', 'a/1']);
      expect(ids(freeModelFirst(list, () => false))).toEqualArray(['a/1', 'b/2']);
      expect(freeModelFirst([])).toEqualArray([]);
    });

    await it('returns a new array and leaves the caller’s list untouched', async () => {
      const list = values('a/1', 'opencode/space-bunny-free');
      const sorted = freeModelFirst(list);
      expect(sorted).not.toBe(list);
      expect(ids(list)).toEqualArray(['a/1', 'opencode/space-bunny-free']);
    });
  });

  await describe('free models — the warning', async () => {
    await it('names the risk and the data it is not for', async () => {
      expect(FREE_MODEL_WARNING).toContain('train');
      expect(FREE_MODEL_WARNING).toContain('tax');
    });

    await it('reads the free model in use off the agent’s options', async () => {
      expect(freeModelInUse(modelOption('opencode/big-pickle'))).toBe('opencode/big-pickle');
      expect(freeModelInUse(modelOption('openrouter/vendor/paid'))).toBe(null);
      // No model known yet is not a free model: nothing to warn about until the agent has said.
      expect(freeModelInUse(null)).toBe(null);
      expect(freeModelInUse([])).toBe(null);
    });

    await it('is owed while a free model is in use and nobody closed it', async () => {
      expect(freeModelWarningDue('opencode/big-pickle', null)).toBe(true);
      expect(freeModelWarningDue(null, null)).toBe(false);
    });

    await it('stays closed for the model it was closed for', async () => {
      expect(freeModelWarningDue('opencode/big-pickle', 'opencode/big-pickle')).toBe(false);
    });

    await it('comes back for another free model, because closing it was about one model', async () => {
      expect(freeModelWarningDue('opencode/space-bunny-free', 'opencode/big-pickle')).toBe(true);
    });
  });

  await describe('free models — where the sort applies', async () => {
    /** An agent's model option whose list contains two free ids and two paid ones. */
    function modelOptions(): SessionConfigOption[] {
      return [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'openrouter/vendor/model-000',
          options: [
            { value: 'openrouter/vendor/model-000', name: 'first' },
            { value: 'openrouter/vendor/model-001', name: 'second' },
            ...HINT.map((value) => ({ value, name: value })),
          ],
        },
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'default', name: 'Default' },
          ],
        },
      ];
    }

    await it('sorts the model control and leaves every other option exactly as the agent sent it', async () => {
      const view = configRowInput({ options: modelOptions() });
      const model = modelControl(view);
      expect(model).not.toBe(null);
      expect(model?.values.map((value) => value.value)).toEqualArray([
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
        'openrouter/vendor/model-000',
        'openrouter/vendor/model-001',
      ]);
      // The thought level is untouched — the sort is about models, and a rate-limited value above a
      // person's own effort level would be worse than no sort at all.
      const effort = view.controls.find((control) => control.id === 'effort');
      expect(effort?.values.map((value) => value.value)).toEqualArray(['low', 'default']);
    });

    await it('still shows what the agent says is in use, at its own index', async () => {
      // **Never a selection.** The sort moved the values, so the selected index has to be computed
      // against the *sorted* list or the dropdown would put some other model on screen. `currentValue`
      // is still the agent's, and this is the case that proves it.
      const view = configRowInput({ options: modelOptions() });
      const model = modelControl(view);
      expect(model?.values[model?.selected ?? -1]?.value).toBe('openrouter/vendor/model-000');
    });

    await it('leaves an uncategorised option alone, rather than guessing that it is the model', async () => {
      // `id: 'model'` with no `category` is a different agent's naming. Sorting on the id would mean
      // a second rule about what an agent calls things; not sorting is honest.
      const uncategorised = modelOptions().map((option) => ({ ...option, category: undefined }));
      const view = configRowInput({ options: uncategorised });
      const model = view.controls.find((control) => control.id === 'model');
      expect(model?.values.map((value) => value.value)).toEqualArray([
        'openrouter/vendor/model-000',
        'openrouter/vendor/model-001',
        'opencode/space-bunny-free',
        'opencode/longcat-2.5-preview-free',
      ]);
      // …and `modelControl` agrees with the sort, so the failure dialog's button and the sort are
      // looking at the same thing.
      expect(modelControl(view)).toBe(null);
    });

    await it('finds no model control in a row that has none, which is what hides the dialog’s button', async () => {
      const noModels = modelOptions().filter((option) => option.category !== 'model');
      expect(modelControl(configRowInput({ options: noModels }))).toBe(null);
      expect(modelControl(configRowInput({ options: [] }))).toBe(null);
    });
  });
}
