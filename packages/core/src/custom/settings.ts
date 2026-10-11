/**
 * The provider settings group's logic (#45), with no widget in it.
 *
 * The group shows three things: the providers the agent holds a login for (and lets one go), the custom
 * providers (#17: add, remove, see where a hand-written one lives) and what each of them means for the
 * person's data. Connecting a provider is **not** here: it is `LoginController`, the same dialog the menu
 * opens, so there is one login and not two. This file holds the list, the add and remove steps and every
 * refusal as a state a widget draws; `@lotse/widget`'s `ProviderSettings` only renders it.
 *
 * It owns one private server for as long as the group is on screen (`open` starts it, `close` stops it),
 * like the login dialog. A key typed into the add form is held in the one call that hands it to opencode
 * (`connect/key`) and in the model probe to the person's own server; it is never in `state`, a field or a
 * message.
 *
 * **What the host decides.** `allowCustomProviders: false` takes the custom part away altogether (`custom:
 * null`; a custom provider that holds a key is listed with the connected ones, so the key can still be let
 * go), and `modelPolicy` marks every provider it allows no model of as `offered: false` — still listed
 * when connected, so a login the person made elsewhere can be removed here, but not offered for use.
 *
 * **A host's own opencode is read-only as a whole** (`file: null`): its config and its logins are the
 * person's, kept where they put them, so the group lists them and changes neither — no log out, no add,
 * no remove.
 */

import { FREE_MODEL_IDS } from '../free-models.ts';
import type { LoginProvider } from '../login/providers.ts';
import { modelAllowed, providerOffered, type ModelPolicy } from '../model-policy.ts';

import type { ConfiguredProvider, WaitHooks } from './api.ts';
import { checkEndpoint, reachPrivacyNote, LOCAL_MODEL_HINT, type EndpointReach } from './endpoint.ts';
import {
  documentProviderIds,
  readProvidersDocument,
  withProvider,
  withoutProvider,
  updateProvidersDocument,
  type ProvidersDocument,
} from './file.ts';
import { planCustomProvider, type CustomProviderInput, type CustomProviderPlan } from './plan.ts';

/** What the controller needs from the private server. `openSettingsSession` is the real one. */
export interface SettingsSession {
  providers(): Promise<LoginProvider[]>;
  configured(ourFile: string): Promise<ConfiguredProvider[]>;
  knownIds(): Promise<Set<string>>;
  models(): Promise<Map<string, string[]>>;
  disconnect(id: string): Promise<number>;
  waitForProvider(id: string, hooks: WaitHooks): Promise<boolean>;
  connectKey(id: string, key: string): Promise<void>;
  close(): Promise<void>;
}

export interface SettingsFiles {
  read(file: string): ProvidersDocument;
  /** Read fresh, change and write, under the file's lock (`updateProvidersDocument`). */
  update(
    file: string,
    change: (raw: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
  ): void;
}

export interface ProviderSettingsDeps {
  openSession(): Promise<SettingsSession>;
  /** Why this agent has no server lotse can drive, or `null` — `loginUnavailableReason`. */
  unavailableReason(): string | null;
  /** lotse's own file (`customProvidersFileOf`); `null` for an agent that is not lotse's copy. */
  readonly file: string | null;
  /** The host's switch for the custom part. */
  readonly allowCustomProviders: boolean;
  readonly modelPolicy?: ModelPolicy;
  /** `<baseUrl>/models` on the person's server — `probeModels` with `fetch`. */
  listModels(baseUrl: string, key?: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** After a change the running agent has to pick up. A throw is reported; the change itself stays. */
  onChanged?(): void | Promise<void>;
  /** The file functions; tests pass an in-memory pair. */
  readonly files?: SettingsFiles;
}

export interface ConnectedRow {
  readonly id: string;
  readonly name: string;
  /** How many models opencode can use through it now. */
  readonly models: number;
  /** The host's policy allows one of its models. */
  readonly offered: boolean;
  /** Log out works: only on lotse's copy (`HOST_READ_ONLY_REASON`). */
  readonly removable: boolean;
}

export interface CustomRow {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly models: readonly string[];
  readonly reach: EndpointReach | null;
  readonly keyStored: boolean;
  /** In lotse's file on lotse's copy; anything else is the person's to edit where `source` says. */
  readonly removable: boolean;
  readonly source: string;
  readonly offered: boolean;
  /** What leaves the machine for it (`reachPrivacyNote`); `null` on loopback or without a URL. */
  readonly privacyNote: string | null;
}

export interface ProviderSettingsView {
  readonly connected: readonly ConnectedRow[];
  /** Why the connected providers cannot be logged out of here, or `null`. */
  readonly connectedReadOnlyReason: string | null;
  /** `null`: the host switched the custom part off. */
  readonly custom: {
    /** Adding and removing works; with `false`, `readOnlyReason` says why. */
    readonly editable: boolean;
    readonly readOnlyReason: string | null;
    readonly providers: readonly CustomRow[];
  } | null;
  readonly privacy: readonly string[];
  /** The id an action is running for; the widget keeps the rest still meanwhile. */
  readonly busy: string | null;
  /** The last action's outcome, for one line under the group. */
  readonly message: string | null;
}

export type ProviderSettingsState =
  | { readonly step: 'starting' }
  | { readonly step: 'unavailable'; readonly reason: string }
  | { readonly step: 'failed'; readonly message: string }
  | { readonly step: 'ready'; readonly view: ProviderSettingsView }
  | { readonly step: 'closed' };

export type AddOutcome =
  | { readonly kind: 'added'; readonly id: string; readonly notes: readonly string[] }
  /** Plain http on the network: ask, then `addCustom` again with `confirmedLan`. */
  | { readonly kind: 'confirm'; readonly question: string; readonly privacyNote: string | null }
  | { readonly kind: 'refused'; readonly reason: string };

export const PROVIDER_PRIVACY_NOTE =
  'A provider receives everything a chat sends it — your prompts, the files the agent reads, tool output — ' +
  'and keeps it under its own terms. lotse stores no key: the agent does.';

export const FREE_MODELS_PRIVACY_NOTE =
  'Free hosted models: the ones listed first are documented as keeping nothing; any other free model may ' +
  'keep what it sees and train on it. Nothing private belongs there.';

export const FREE_MODELS_DENIED_NOTE = 'This app does not let a chat use free hosted models.';

export const NOT_LOTSE_COPY_REASON =
  'Custom providers are added only to the opencode that comes with lotse. Your own opencode keeps them in ' +
  'its own config, which lotse does not edit.';

export const HOST_READ_ONLY_REASON =
  'This is your own opencode: lotse shows its logins and changes none of them. Log out with ' +
  '`opencode auth logout`.';

const CUSTOM_OFF_REASON = 'this app does not add or remove custom providers';

const REAL_FILES: SettingsFiles = {
  read: readProvidersDocument,
  update: (file, change) => updateProvidersDocument(file, change),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A message with every occurrence of `secret` replaced — a server may echo what it was sent. */
function redact(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join('[key]') : message;
}

export class ProviderSettingsController {
  readonly #deps: ProviderSettingsDeps;
  readonly #files: SettingsFiles;
  readonly #listeners = new Set<(state: ProviderSettingsState) => void>();
  #state: ProviderSettingsState = { step: 'starting' };
  #session: SettingsSession | null = null;
  #closed = false;
  #opening = false;
  #busy: string | null = null;
  #message: string | null = null;
  /** The change in flight, which `close` lets finish before it stops the server. */
  #running: Promise<boolean> | null = null;
  /** A `reload` asked for while a change or a start was running; done when it ends. */
  #reloadWanted = false;

  constructor(deps: ProviderSettingsDeps) {
    this.#deps = deps;
    this.#files = deps.files ?? REAL_FILES;
  }

  get state(): ProviderSettingsState {
    return this.#state;
  }

  subscribe(listener: (state: ProviderSettingsState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: ProviderSettingsState): void {
    if (this.#closed && state.step !== 'closed') return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Start the server and read the lists. */
  async open(): Promise<void> {
    if (this.#session || this.#opening || this.#closed) return;
    this.#opening = true;
    try {
      const reason = this.#deps.unavailableReason();
      if (reason) return this.#set({ step: 'unavailable', reason });
      let session: SettingsSession;
      try {
        session = await this.#deps.openSession();
      } catch (error) {
        return this.#set({
          step: 'failed',
          message: `could not start the agent's server: ${messageOf(error)}`,
        });
      }
      if (this.#closed) {
        await session.close();
        return;
      }
      this.#session = session;
      await this.refresh();
    } finally {
      this.#opening = false;
    }
    if (this.#reloadWanted) await this.reload();
  }

  /** Read everything again — after a login in the dialog, say. */
  async refresh(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      this.#set({ step: 'ready', view: await this.#view(session) });
    } catch (error) {
      this.#set({ step: 'failed', message: `could not read the providers: ${messageOf(error)}` });
    }
  }

  /**
   * Start a fresh server and read everything — after a login in the dialog. The dialog's login is written
   * by *its* server, and whether an already running one reads it again is opencode's business, so the
   * group does not count on it and starts over.
   */
  async reload(): Promise<void> {
    if (this.#closed) return;
    // Dropping it would lose a login made meanwhile, so it runs once the change or the start has ended.
    if (this.#opening || this.#busy !== null) {
      this.#reloadWanted = true;
      return;
    }
    this.#reloadWanted = false;
    const session = this.#session;
    this.#session = null;
    this.#message = null;
    this.#set({ step: 'starting' });
    await session?.close().catch(() => undefined);
    await this.open();
  }

  async #view(session: SettingsSession): Promise<ProviderSettingsView> {
    const policy = this.#deps.modelPolicy;
    const [providers, configured, models] = await Promise.all([
      session.providers(),
      session.configured(this.#deps.file ?? ''),
      session.models(),
    ]);
    const writable = this.#deps.file !== null;
    const customIds = new Set(configured.map((provider) => provider.id));
    const row = (id: string, name: string, known: readonly string[]): ConnectedRow => ({
      id,
      name,
      models: known.length,
      offered: providerOffered(policy, id, known),
      removable: writable,
    });
    const connected = providers
      .filter((provider) => provider.connected && !customIds.has(provider.id))
      .map((provider) => row(provider.id, provider.name, models.get(provider.id) ?? []));
    // With the custom part off, a key stored for a custom provider would otherwise be out of sight.
    if (!this.#deps.allowCustomProviders) {
      for (const provider of configured.filter((entry) => entry.connected))
        connected.push(row(provider.id, provider.name, models.get(provider.id) ?? provider.models));
    }
    const freeAllowed = [...FREE_MODEL_IDS, 'opencode/model-free'].some((id) => modelAllowed(policy, id));
    return {
      connected,
      connectedReadOnlyReason: writable ? null : HOST_READ_ONLY_REASON,
      custom: this.#deps.allowCustomProviders
        ? {
            editable: this.#deps.file !== null,
            readOnlyReason: this.#deps.file === null ? NOT_LOTSE_COPY_REASON : null,
            providers: configured.map((provider) => ({
              id: provider.id,
              name: provider.name,
              baseUrl: provider.baseUrl,
              models: provider.models,
              reach: provider.reach,
              keyStored: provider.connected,
              removable: provider.ours && this.#deps.file !== null,
              source: provider.source,
              offered: providerOffered(policy, provider.id, provider.models),
              privacyNote: provider.reach ? reachPrivacyNote(provider.reach) : null,
            })),
          }
        : null,
      privacy: [PROVIDER_PRIVACY_NOTE, freeAllowed ? FREE_MODELS_PRIVACY_NOTE : FREE_MODELS_DENIED_NOTE],
      busy: this.#busy,
      message: this.#message,
    };
  }

  /**
   * Run one change with the group marked busy, then tell the agent and read everything again. `false`: it
   * did not run — no server, closed, or another change first.
   */
  #change(id: string, run: (session: SettingsSession) => Promise<string>): Promise<boolean> {
    const session = this.#session;
    if (!session || this.#busy !== null || this.#state.step !== 'ready') return Promise.resolve(false);
    this.#busy = id;
    this.#message = null;
    this.#set({ step: 'ready', view: { ...this.#state.view, busy: id, message: null } });
    const running = this.#run(session, run).finally(() => {
      if (this.#running === running) this.#running = null;
    });
    this.#running = running;
    return running;
  }

  async #run(session: SettingsSession, run: (session: SettingsSession) => Promise<string>): Promise<boolean> {
    try {
      this.#message = await run(session);
      try {
        await this.#deps.onChanged?.();
      } catch (error) {
        this.#message = `${this.#message} The agent could not be restarted: ${messageOf(error)}`;
      }
    } catch (error) {
      this.#message = messageOf(error);
    } finally {
      this.#busy = null;
    }
    if (this.#reloadWanted) await this.reload();
    else await this.refresh();
    return true;
  }

  /** Remove every login opencode holds for a provider — on lotse's copy only. */
  async disconnect(id: string): Promise<void> {
    await this.#change(id, async (session) => {
      if (this.#deps.file === null) throw new Error(HOST_READ_ONLY_REASON);
      const removed = await session.disconnect(id);
      return removed > 0 ? `Logged out of ${id}.` : `${id} had no login to remove.`;
    });
  }

  /**
   * Add (or replace) a custom provider. With no models given, the server's `/models` list is used. `key`,
   * when given, goes to that list and to opencode's `connect/key` and nowhere else.
   */
  async addCustom(input: CustomProviderInput, key?: string): Promise<AddOutcome> {
    const refused = (reason: string): Extract<AddOutcome, { kind: 'refused' }> => ({
      kind: 'refused',
      reason: redact(reason, key),
    });
    const session = this.#session;
    const file = this.#deps.file;
    if (!this.#deps.allowCustomProviders) return refused(CUSTOM_OFF_REASON);
    if (file === null) return refused(NOT_LOTSE_COPY_REASON);
    if (!session || this.#state.step !== 'ready') return refused('the providers are not loaded yet');
    if (this.#busy !== null) return refused('another change is still running');
    const document = this.#files.read(file);
    if (!document.ok)
      return refused(`${file} could not be read (${document.problem}) — fix or remove it first`);

    const models = [...input.models];
    const notes: string[] = [];
    let plan: CustomProviderPlan;
    try {
      // The facts first, so a refusal that needs no network (a bad id, a remote http URL) is said at once.
      const facts = {
        knownIds: await session.knownIds(),
        ownIds: new Set(documentProviderIds(document.raw)),
      };
      plan = planCustomProvider({ ...input, models: models.length > 0 ? models : [{ id: '-' }] }, facts);
      if (plan.kind !== 'ok') return plan.kind === 'refused' ? refused(plan.reason) : plan;
      if (models.length === 0) {
        const endpoint = checkEndpoint(plan.provider.baseUrl);
        if (endpoint.ok) {
          try {
            models.push(...(await this.#deps.listModels(endpoint.baseUrl, key)).map((id) => ({ id })));
          } catch (error) {
            return refused(`could not list the models (${messageOf(error)}) — name them yourself`);
          }
        }
      }
      plan = planCustomProvider({ ...input, models }, facts);
    } catch (error) {
      return refused(messageOf(error));
    }
    if (plan.kind !== 'ok') return plan.kind === 'refused' ? refused(plan.reason) : plan;
    if (plan.privacyNote) notes.push(plan.privacyNote);
    notes.push(...plan.notes);
    if (plan.reach !== 'remote') notes.push(LOCAL_MODEL_HINT);

    const provider = plan.provider;
    let outcome: AddOutcome = { kind: 'added', id: provider.id, notes };
    const ran = await this.#change(provider.id, async (live) => {
      // A fresh read under the lock: the CLI may have written while the models were listed.
      this.#files.update(file, (raw) => withProvider(raw, provider));
      const verb = plan.replaces ? 'Updated' : 'Added';
      if (!key) return `${verb} ${provider.id}.`;
      const seen = await live.waitForProvider(provider.id, {
        sleep: (ms) => this.#deps.sleep(ms),
        now: () => this.#deps.now(),
      });
      // A failure here is both the outcome the form shows and the message under the group.
      const fail = (reason: string): never => {
        outcome = refused(reason);
        throw new Error(outcome.reason);
      };
      if (!seen)
        fail(`${provider.id} was saved, but opencode did not list it in time — the key was not stored`);
      try {
        await live.connectKey(provider.id, key);
      } catch (error) {
        fail(`${provider.id} was saved, but the key was not: ${messageOf(error)}`);
      }
      return `${verb} ${provider.id} with its key.`;
    });
    return ran ? outcome : refused('another change is still running');
  }

  /** Remove a custom provider from lotse's file, its stored key first. */
  async removeCustom(id: string): Promise<void> {
    await this.#change(id, async (session) => {
      const file = this.#deps.file;
      if (!this.#deps.allowCustomProviders) throw new Error(CUSTOM_OFF_REASON);
      if (file === null) throw new Error(NOT_LOTSE_COPY_REASON);
      const document = this.#files.read(file);
      if (!document.ok) throw new Error(`${file} could not be read (${document.problem})`);
      if (!documentProviderIds(document.raw).includes(id)) {
        throw new Error(`${id} is not in lotse's file — remove it where it was written`);
      }
      // The key first: once the entry is gone opencode no longer lists the provider, and its credential
      // would be left behind with no way to reach it.
      const keys = await session.disconnect(id);
      this.#files.update(file, (raw) => withoutProvider(raw, id));
      return `Removed ${id}${keys > 0 ? ' and its stored key' : ''}.`;
    });
  }

  /**
   * Stop the server. The widget calls this when the group goes away; safe to call twice. A change in
   * flight finishes on the server it started on first — closing under it would leave a file written and
   * its key not stored.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const session = this.#session;
    this.#session = null;
    this.#set({ step: 'closed' });
    await this.#running;
    await session?.close();
  }
}
