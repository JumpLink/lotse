/**
 * Whether a custom provider may be saved, and what to tell the person first. Pure: the CLI and the
 * settings group both ask this, with the facts they gathered, and only then write.
 */

import { CUSTOM_PRESETS, checkEndpoint, contextWarning, type EndpointReach } from './endpoint.ts';
import { providerIdProblem, type CustomModel, type CustomProvider } from './file.ts';

export interface CustomProviderInput {
  /** Defaults to the preset's id. */
  readonly id?: string;
  /** A `CUSTOM_PRESETS` id; supplies the id, the name and the URL that are not given. */
  readonly preset?: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly models: readonly CustomModel[];
  /** The person said yes to plain http on the local network. */
  readonly confirmedLan: boolean;
}

export interface CustomProviderFacts {
  /** Every id opencode knows (`ProviderApi.knownIds`), lotse's own providers included. */
  readonly knownIds: ReadonlySet<string>;
  /** The ids in lotse's own file: replacing one of those is an edit, not a shadow. */
  readonly ownIds: ReadonlySet<string>;
}

export type CustomProviderPlan =
  | {
      readonly kind: 'ok';
      readonly provider: CustomProvider;
      readonly reach: EndpointReach;
      /** Replaces a provider already in lotse's file. */
      readonly replaces: boolean;
      readonly privacyNote: string | null;
      /** Context warnings and the preset's server-side note. Shown, never blocking. */
      readonly notes: readonly string[];
    }
  /** Plain http on the local network, not confirmed yet. Ask, then plan again with `confirmedLan`. */
  | { readonly kind: 'confirm'; readonly question: string; readonly privacyNote: string | null }
  | { readonly kind: 'refused'; readonly reason: string };

export function planCustomProvider(
  input: CustomProviderInput,
  facts: CustomProviderFacts,
): CustomProviderPlan {
  const preset = input.preset === undefined ? undefined : CUSTOM_PRESETS.find((p) => p.id === input.preset);
  if (input.preset !== undefined && !preset) {
    return {
      kind: 'refused',
      reason: `no preset "${input.preset}" — there are ${CUSTOM_PRESETS.map((p) => p.id).join(', ')}`,
    };
  }
  const id = input.id ?? preset?.id;
  if (!id) return { kind: 'refused', reason: 'a custom provider needs an id (or a preset)' };
  const idProblem = providerIdProblem(id);
  if (idProblem) return { kind: 'refused', reason: idProblem };
  const replaces = facts.ownIds.has(id);
  if (!replaces && facts.knownIds.has(id)) {
    return {
      kind: 'refused',
      reason: `"${id}" is already one of opencode's providers — a custom one may not shadow it; pick another id`,
    };
  }
  const rawUrl = input.baseUrl ?? preset?.baseUrl;
  if (!rawUrl) return { kind: 'refused', reason: 'a custom provider needs a base URL (or a preset)' };
  const endpoint = checkEndpoint(rawUrl);
  if (!endpoint.ok) return { kind: 'refused', reason: endpoint.reason };
  if (endpoint.needsConfirmation && !input.confirmedLan) {
    return {
      kind: 'confirm',
      question: `${endpoint.baseUrl} is plain http on your network. Send your prompts there unencrypted?`,
      privacyNote: endpoint.privacyNote,
    };
  }
  if (input.models.length === 0) {
    return { kind: 'refused', reason: 'name at least one model — the server did not list any' };
  }
  const notes = input.models.flatMap((model) => {
    const warning = contextWarning(model.id, model.context);
    return warning ? [warning] : [];
  });
  if (preset?.note) notes.push(preset.note);
  return {
    kind: 'ok',
    provider: {
      id,
      name: input.name?.trim() || preset?.name || id,
      baseUrl: endpoint.baseUrl,
      models: input.models,
    },
    reach: endpoint.reach,
    replaces,
    privacyNote: endpoint.privacyNote,
    notes,
  };
}

/**
 * Model specs as a person types them: `id` or `id=context`. The id may hold a `:` (`qwen3:4b`), never a
 * `=`. Returns the reason as a string for the first one that is not a spec.
 */
export function parseModelSpecs(entries: readonly string[]): CustomModel[] | string {
  const models: CustomModel[] = [];
  for (const entry of entries) {
    const text = entry.trim();
    const at = text.lastIndexOf('=');
    const id = at < 0 ? text : text.slice(0, at);
    if (!id) return `a model is an id or id=context, got "${text}"`;
    if (at < 0) {
      models.push({ id });
      continue;
    }
    const context = Number(text.slice(at + 1));
    if (!Number.isInteger(context) || context <= 0) {
      return `${id}: the context after "=" is a number of tokens, got "${text.slice(at + 1)}"`;
    }
    models.push({ id, context });
  }
  return models;
}
