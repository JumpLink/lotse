/**
 * The host model policy — what a denial does to every surface that can act on it.
 *
 * **Why this suite is wider than one module.** `model-policy.ts` is four small functions, and every one
 * of them is interesting only because somebody else reads it: the config row hides what it denies, the
 * composer blocks on one of its two causes and not the other, `#deliver` refuses on both, and the
 * failure classification turns the refusal into a dialog with a button. A test that only exercised the
 * predicate would pass against a policy nothing consults — which is exactly the failure a fail-closed
 * seam must not have. So each consumer is asked here too, through its own barrel export.
 *
 * **The policies are written in the test**, never read from `isFreeModel`, except in the one block
 * about `denyFreeHostedModels` itself — a host's rule is a parameter, and a suite that needed the shipped
 * classification to say anything would be testing the classification.
 *
 * Both runtimes, no display: which model a prompt may reach is invisible in a screenshot and expensive
 * to get wrong.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  agentStatus,
  allowedModelValues,
  allowOnlyProviders,
  composerView,
  configRowInput,
  configSelection,
  denyFreeHostedModels,
  failureAction,
  failureKind,
  failureNotice,
  isConfigChange,
  modelAllowed,
  modelBlock,
  modelControl,
  MODEL_DENIED_REASON,
  MODEL_UNKNOWN_REASON,
  ModelDeniedError,
  type ModelPolicy,
} from '@lotse/core';
import type { SessionConfigOption } from '@lotse/acp/types';

/** A host rule in its simplest honest form: these ids, no. */
function deny(...ids: string[]): ModelPolicy {
  return (model) => (ids.includes(model) ? 'deny' : 'allow');
}

/** The agent's options: a model control whose `currentValue` is the caller's, plus one that is not a model. */
function options(currentValue = 'vendor/paid-1'): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'vendor/paid-1', name: 'Paid one' },
        { value: 'vendor/paid-2', name: 'Paid two' },
        { value: 'vendor/model-free', name: 'Free one' },
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

function ids(values: readonly { readonly value: string }[]): string[] {
  return values.map((value) => value.value);
}

export default async function modelPolicy(): Promise<void> {
  await describe('model policy — asking the host', async () => {
    await it('allows everything when no host set a rule, which is lotse’s own window', async () => {
      // The default path. Every caller passes an optional option straight through, so "the host set
      // nothing" is answered once here rather than branched on at each call site.
      expect(modelAllowed(undefined, 'vendor/paid-1')).toBe(true);
      expect(modelAllowed(undefined, '')).toBe(true);
    });

    await it('treats a policy that throws as a deny', async () => {
      // Host code runs inside lotse's render path and can throw on an id it did not expect. "My policy
      // crashed" reads as "I have not approved this" — the alternative is a stack trace that takes the
      // config row down with the denied model still selected.
      const broken: ModelPolicy = () => {
        throw new Error('policy is broken');
      };
      expect(modelAllowed(broken, 'vendor/paid-1')).toBe(false);
    });

    await it('treats anything that is not the literal allow as a deny', async () => {
      // A host compiled against an older shape, or one that returned `undefined` from a forgotten
      // branch, has not approved a model.
      const vague = (() => undefined) as unknown as ModelPolicy;
      expect(modelAllowed(vague, 'vendor/paid-1')).toBe(false);
      const truthy = (() => 'yes') as unknown as ModelPolicy;
      expect(modelAllowed(truthy, 'vendor/paid-1')).toBe(false);
    });
  });

  await describe('model policy — filtering a value list', async () => {
    const values = [{ value: 'a/1' }, { value: 'a/2' }, { value: 'a/3' }];

    await it('keeps the caller’s order and drops only what is denied', async () => {
      expect(ids(allowedModelValues(values, deny('a/2')))).toEqualArray(['a/1', 'a/3']);
    });

    await it('is a copy and nothing else without a policy', async () => {
      const copy = allowedModelValues(values);
      expect(copy).not.toBe(values);
      expect(ids(copy)).toEqualArray(['a/1', 'a/2', 'a/3']);
    });

    await it('can empty the list, which is the case the row has to handle', async () => {
      expect(allowedModelValues(values, deny('a/1', 'a/2', 'a/3'))).toEqualArray([]);
    });
  });

  await describe('model policy — denyFreeHostedModels', async () => {
    await it('denies the maintained ids, because that is the one list in the repo', async () => {
      // Read from the shipped classification on purpose: this block is about the ready-made policy, and
      // a synthetic list could not tell whether it is wired to `isFreeModel` at all.
      expect(denyFreeHostedModels('opencode/space-bunny-free')).toBe('deny');
    });

    await it('denies any id named -free, which is what catches the anonymous default', async () => {
      // `opencode/fledge-alpha-free` is the model an unlogged-in `opencode acp` answers with (measured
      // 2026-10-02, see `failure.ts`). It is in no list and the suffix is what denies it.
      expect(denyFreeHostedModels('opencode/fledge-alpha-free')).toBe('deny');
      expect(denyFreeHostedModels('vendor/model-free')).toBe('deny');
    });

    await it('denies an empty or blank id, which would otherwise read as an allow', async () => {
      // `isFreeModel('')` is `false`, so without this the absence of a model id would be approved.
      expect(denyFreeHostedModels('')).toBe('deny');
      expect(denyFreeHostedModels('   ')).toBe('deny');
    });

    await it('allows a paid id, and allows an id the classification has never heard of', async () => {
      // **The documented limit, asserted so it cannot change by accident.** Denying the unknown would
      // deny ~400 of ~400 models including every paid one, leaving a window whose composer blocks
      // forever and whose sentence asks for a model that does not exist. A host needing certainty
      // passes an allowlist instead — which is why the option is a predicate.
      expect(denyFreeHostedModels('anthropic/claude-opus-5')).toBe('allow');
      expect(denyFreeHostedModels('vendor/free-tier-model')).toBe('allow');
      expect(denyFreeHostedModels('vendor/something-nobody-classified')).toBe('allow');
    });
  });

  await describe('model policy — allowOnlyProviders', async () => {
    await it('allows a model of a named provider and denies every other provider, known or not', async () => {
      const policy = allowOnlyProviders(['anthropic']);
      expect(policy('anthropic/claude-opus-5')).toBe('allow');
      expect(policy('opencode/brand-new-model')).toBe('deny');
      expect(policy('openrouter/anthropic/claude-opus-5')).toBe('deny');
    });

    await it('compares the provider exactly, not by prefix', async () => {
      const policy = allowOnlyProviders(['open']);
      expect(policy('opencode/x')).toBe('deny');
      expect(policy('open/x')).toBe('allow');
    });

    await it('denies ids with no provider, blank ids and everything on an empty list', async () => {
      const policy = allowOnlyProviders(['anthropic']);
      expect(policy('claude-opus-5')).toBe('deny');
      expect(policy('/claude')).toBe('deny');
      expect(policy('anthropic/')).toBe('deny');
      expect(policy('')).toBe('deny');
      expect(policy('   ')).toBe('deny');
      expect(allowOnlyProviders([])('anthropic/claude-opus-5')).toBe('deny');
    });
  });

  await describe('model policy — whether a prompt may go out', async () => {
    await it('is null for every window that set no policy', async () => {
      expect(modelBlock(options())).toBe(null);
      expect(modelBlock(null)).toBe(null);
    });

    await it('is null when the model in use is allowed', async () => {
      expect(modelBlock(options(), deny('vendor/paid-2'))).toBe(null);
    });

    await it('is unknown before the agent has answered', async () => {
      // `session/new` goes out with the *first* prompt, so this is the normal state of a fresh window.
      const block = modelBlock(null, deny('x'));
      expect(block?.cause).toBe('unknown');
      expect(block?.reason).toBe(MODEL_UNKNOWN_REASON);
      expect(modelBlock(undefined, deny('x'))?.cause).toBe('unknown');
    });

    await it('is unknown when the agent reported options but no model control', async () => {
      // The agent answered and named no model: lotse cannot verify where a prompt would go, and a
      // prompt is not sent to a model nobody has named.
      const noModel = options().filter((option) => option.category !== 'model');
      expect(modelBlock(noModel, deny('x'))?.cause).toBe('unknown');
      expect(modelBlock([], deny('x'))?.cause).toBe('unknown');
    });

    await it('is unknown for an uncategorised option, rather than guessing it is the model', async () => {
      // Same rule as the free-model hint and `modelControl`: `category`, never the id `'model'`.
      const uncategorised = options().map((option) => ({ ...option, category: undefined }));
      expect(modelBlock(uncategorised, deny('x'))?.cause).toBe('unknown');
    });

    await it('is denied when the policy refuses the value the agent says is in use', async () => {
      const block = modelBlock(options('vendor/model-free'), denyFreeHostedModels);
      expect(block?.cause).toBe('denied');
      expect(block?.reason).toBe(MODEL_DENIED_REASON);
    });

    await it('names no model id in either sentence', async () => {
      // The id is the agent's own string and is already in the dropdown the sentence points at. What a
      // person needs is the one thing they can do.
      expect(MODEL_DENIED_REASON).not.toContain('/');
      expect(MODEL_UNKNOWN_REASON).not.toContain('/');
    });

    await it('reads the agent’s raw options and not the drawn row', async () => {
      // The row has the denied value filtered out of it, so asking the row what is in use would answer
      // "nothing" for exactly the case this function exists to catch.
      const policy = denyFreeHostedModels;
      const raw = options('vendor/model-free');
      expect(modelControl(configRowInput({ options: raw, modelPolicy: policy }))?.selected).toBe(-1);
      expect(modelBlock(raw, policy)?.cause).toBe('denied');
    });

    await it('is denied when the policy throws about the model in use', async () => {
      const broken: ModelPolicy = () => {
        throw new Error('policy is broken');
      };
      expect(modelBlock(options(), broken)?.cause).toBe('denied');
    });
  });

  await describe('model policy — the config row', async () => {
    await it('removes nothing without a policy — the free model is only sorted first', async () => {
      const view = configRowInput({ options: options() });
      expect(ids(modelControl(view)?.values ?? [])).toEqualArray([
        'vendor/model-free',
        'vendor/paid-1',
        'vendor/paid-2',
      ]);
    });

    await it('removes a denied value and keeps the agent’s order for the rest', async () => {
      const view = configRowInput({ options: options(), modelPolicy: denyFreeHostedModels });
      expect(ids(modelControl(view)?.values ?? [])).toEqualArray(['vendor/paid-1', 'vendor/paid-2']);
    });

    await it('filters the model control only, never another kind of option', async () => {
      // A thought level with values missing from it would be a policy about models applied to something
      // that is not one — the same join point `config.ts`'s `modelFirst` uses.
      const view = configRowInput({ options: options(), modelPolicy: deny('low', 'vendor/model-free') });
      const effort = view.controls.find((control) => control.id === 'effort');
      expect(ids(effort?.values ?? [])).toEqualArray(['low', 'default']);
    });

    await it('recomputes the selection against the filtered list', async () => {
      // The index has to be computed against the list the widget was built from, or the dropdown puts
      // some other model on screen.
      const view = configRowInput({ options: options('vendor/paid-2'), modelPolicy: denyFreeHostedModels });
      const model = modelControl(view);
      expect(model?.values[model?.selected ?? -1]?.value).toBe('vendor/paid-2');
    });

    await it('selects nothing when the value in use is the denied one', async () => {
      // The row does not lie about what is in use — it stops claiming a selection, and the composer
      // says in words that the model is blocked.
      const view = configRowInput({
        options: options('vendor/model-free'),
        modelPolicy: denyFreeHostedModels,
      });
      expect(modelControl(view)?.selected).toBe(-1);
    });

    await it('drops a model control the policy emptied, so the dialog offers no button', async () => {
      const everything = deny('vendor/paid-1', 'vendor/paid-2', 'vendor/model-free');
      const view = configRowInput({ options: options(), modelPolicy: everything });
      expect(modelControl(view)).toBe(null);
      // The rest of the row survives: the effort dropdown is not the model's business.
      expect(view.visible).toBe(true);
      expect(ids(view.controls[0]?.values ?? [])).toEqualArray(['low', 'default']);
    });

    await it('has no row at all when the model was the only control and all of it is denied', async () => {
      const onlyModel = options().filter((option) => option.category === 'model');
      const view = configRowInput({
        options: onlyModel,
        modelPolicy: deny('vendor/paid-1', 'vendor/paid-2', 'vendor/model-free'),
      });
      expect(view.visible).toBe(false);
      expect([...view.controls]).toEqualArray([]);
    });

    await it('draws a placeholder row exactly while nothing is selected', async () => {
      // `Gtk.DropDown` has no unselected state — measured, see `scripts/probes/dropdown-no-selection.mjs`
      // — so without a row of its own the widget would show the first allowed model as though it were
      // in use, and picking that row would emit nothing at all.
      const blocked = configRowInput({
        options: options('vendor/model-free'),
        modelPolicy: denyFreeHostedModels,
      });
      expect(modelControl(blocked)?.placeholder).toBe('Choose…');
      // Paired with `selected`, never set beside a real one: a placeholder a person could pick while
      // something is selected would be a row that means nothing.
      const allowed = configRowInput({ options: options(), modelPolicy: denyFreeHostedModels });
      expect(modelControl(allowed)?.placeholder).toBe(null);
      expect(allowed.controls.every((control) => control.placeholder === null)).toBe(true);
    });

    await it('reads a dropdown row back through the placeholder’s offset', async () => {
      // The whole point of `configSelection` living in core: with a placeholder at row 0 every value
      // sits one row lower, and doing that arithmetic in the widget would send the model *above* the
      // one the person picked — on the one row where lotse is already refusing to send.
      const view = configRowInput({
        options: options('vendor/model-free'),
        modelPolicy: denyFreeHostedModels,
      });
      expect(configSelection(view, 'model', 1)).toMatchObject({ controlId: 'model', value: 'vendor/paid-1' });
      expect(configSelection(view, 'model', 2)).toMatchObject({ controlId: 'model', value: 'vendor/paid-2' });
      // Row 0 is the placeholder: the one row that must never resolve to a value.
      expect(configSelection(view, 'model', 0)).toBe(null);
      // And one past the end is still nothing, placeholder or not.
      expect(configSelection(view, 'model', 3)).toBe(null);
    });

    await it('reads a row without a placeholder unshifted, as it always did', async () => {
      const view = configRowInput({ options: options(), modelPolicy: denyFreeHostedModels });
      expect(configSelection(view, 'model', 0)).toMatchObject({ controlId: 'model', value: 'vendor/paid-1' });
      expect(configSelection(view, 'model', 1)).toMatchObject({ controlId: 'model', value: 'vendor/paid-2' });
      expect(configSelection(view, 'model', 2)).toBe(null);
    });

    await it('makes every pick a change while nothing is selected', async () => {
      // The one way `selected` reaches `-1`. Reading "no current value" as "no change" would make the
      // row a dead control: nothing is ever sent and the person cannot leave the denied model.
      const view = configRowInput({
        options: options('vendor/model-free'),
        modelPolicy: denyFreeHostedModels,
      });
      expect(isConfigChange(view, 'model', 'vendor/paid-1')).toBe(true);
      expect(isConfigChange(view, 'model', 'vendor/paid-2')).toBe(true);
      // And the guard still holds everywhere it did: re-picking what is in use sends nothing.
      const allowed = configRowInput({ options: options(), modelPolicy: denyFreeHostedModels });
      expect(isConfigChange(allowed, 'model', 'vendor/paid-1')).toBe(false);
    });
  });

  await describe('model policy — the composer', async () => {
    const attached = { attached: true, note: '' };

    await it('blocks Send on a denied model and says why', async () => {
      const view = composerView({
        state: 'idle',
        agent: attached,
        sessionId: 'session',
        modelBlock: { cause: 'denied', reason: MODEL_DENIED_REASON },
      });
      expect(view.action).toBe('send');
      expect(view.buttonEnabled).toBe(false);
      expect(view.reason).toBe(MODEL_DENIED_REASON);
      // Typing stays allowed: the draft is kept, and picking an allowed model above makes this branch
      // go away mid-sentence.
      expect(view.entryEditable).toBe(true);
    });

    await it('does not block on unknown, because the first prompt is what answers it', async () => {
      // The gate for a genuinely unverifiable model is `#deliver`'s, after the agent has answered.
      const view = composerView({
        state: 'idle',
        agent: attached,
        sessionId: null,
        startsConversation: true,
        modelBlock: { cause: 'unknown', reason: MODEL_UNKNOWN_REASON },
      });
      expect(view.buttonEnabled).toBe(true);
      expect(view.reason).toBe('');
    });

    await it('is unchanged for every window that set no policy', async () => {
      const without = composerView({ state: 'idle', agent: attached, sessionId: 'session' });
      const explicit = composerView({
        state: 'idle',
        agent: attached,
        sessionId: 'session',
        modelBlock: null,
      });
      expect(without.buttonEnabled).toBe(true);
      expect(explicit).toMatchObject(without);
      expect(without).toMatchObject(explicit);
    });

    await it('keeps Stop live while a turn runs, denied model or not', async () => {
      // Stop is the one control that must work with nothing else finished. A person who can see a
      // running turn and a disabled Send is told to wait for a button that will not help.
      const view = composerView({
        state: 'thinking',
        agent: attached,
        sessionId: 'session',
        modelBlock: { cause: 'denied', reason: MODEL_DENIED_REASON },
      });
      expect(view.action).toBe('stop');
      expect(view.buttonEnabled).toBe(true);
    });

    await it('lets the more fundamental blockers speak first', async () => {
      // A caption about choosing another model, in a window that has no agent, would point at a
      // dropdown that is not there.
      const block = { cause: 'denied', reason: MODEL_DENIED_REASON } as const;
      const noAgent = composerView({
        state: 'idle',
        agent: { attached: false, note: 'Starting the agent…' },
        sessionId: 'session',
        modelBlock: block,
      });
      expect(noAgent.reason).toBe('Starting the agent…');
      const unavailable = composerView({
        state: 'idle',
        agent: attached,
        sessionId: 'session',
        unavailable: 'No agent is installed.',
        modelBlock: block,
      });
      expect(unavailable.reason).toBe('No agent is installed.');
      const noSession = composerView({
        state: 'idle',
        agent: attached,
        sessionId: null,
        modelBlock: block,
      });
      expect(noSession.reasonOnPage).toBe(true);
    });
  });

  await describe('model policy — the refusal as a failure', async () => {
    const block = { cause: 'denied', reason: MODEL_DENIED_REASON } as const;

    await it('carries the block and reads as its own sentence', async () => {
      // `describe(error)` is what reaches the attachment and the dialog, so the message has to be the
      // sentence a person should read.
      const error = new ModelDeniedError(block);
      expect(error.message).toBe(MODEL_DENIED_REASON);
      expect(error.name).toBe('ModelDeniedError');
      expect(error.block.cause).toBe('denied');
      expect(error instanceof Error).toBe(true);
    });

    await it('classifies as denied whether or not a prompt had gone out', async () => {
      // It never reached the wire, so the `promptSent` question that separates `auth` from `model`
      // has nothing to say about it — and matching it first keeps that true even for a host policy
      // that threw something resembling an `RpcError`.
      const error = new ModelDeniedError(block);
      expect(failureKind(error, { promptSent: false })).toBe('denied');
      expect(failureKind(error, { promptSent: true })).toBe('denied');
      expect(
        failureKind(new ModelDeniedError({ cause: 'unknown', reason: MODEL_UNKNOWN_REASON }), {
          promptSent: true,
        }),
      ).toBe('denied');
    });

    await it('earns a dialog, because the composer would otherwise say nothing', async () => {
      // The `'unknown'` cause is the one the composer deliberately does not block on, and
      // `composerView` renders `reason || status` and never an attached agent's note — so a `null`
      // notice here would make that refusal silent.
      const notice = failureNotice('denied');
      expect(notice).not.toBe(null);
      expect(notice?.action).toBe('choose-model');
      // No command: nothing outside this window is wrong, and the remedy is the dropdown.
      expect(notice?.command).toBe(null);
      // No agent text, no model id, no host app name.
      expect(notice?.body).not.toContain('/');
    });

    await it('withholds the button when there is no model dropdown to open', async () => {
      const notice = failureNotice('denied');
      expect(notice === null ? null : failureAction(notice, { modelChoice: true, login: false })).toBe(
        'choose-model',
      );
      expect(notice === null ? 'x' : failureAction(notice, { modelChoice: false, login: false })).toBe(null);
    });

    await it('keeps the agent attached, so picking an allowed model unblocks Send', async () => {
      // It never reached the wire, so the agent plainly did not fail. Were this `attached: false`,
      // the attachment would stay `failed` until a next attach that is never coming.
      const status = agentStatus({ status: 'failed', kind: 'denied', message: MODEL_DENIED_REASON });
      expect(status.attached).toBe(true);
      expect(status.note).toBe(MODEL_DENIED_REASON);
    });
  });
}
