/**
 * The provider settings group's logic (#45), driven through a scripted session and an in-memory file — no
 * server, no widget. Also the pieces it is built from: `providerOffered`, `customProvidersFileOf`,
 * `parseModelList` and the login dialog's `offers`. Every id, URL and key is synthetic.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  FREE_MODELS_DENIED_NOTE,
  FREE_MODELS_PRIVACY_NOTE,
  LoginController,
  NOT_LOTSE_COPY_REASON,
  PROVIDER_PRIVACY_NOTE,
  ProviderSettingsController,
  allowOnlyProviders,
  customProvidersFileOf,
  denyFreeHostedModels,
  documentProviderIds,
  parseModelList,
  parseProvidersDocument,
  planCustomProvider,
  providerOffered,
  withProvider,
  HOST_READ_ONLY_REASON,
  reachPrivacyNote,
  type ConfiguredProvider,
  type LoginProvider,
  type LoginSession,
  type ModelPolicy,
  type ProviderSettingsDeps,
  type SettingsSession,
} from '@lotse/core';

const OUR_FILE = '/synthetic/agents/opencode/config/lotse-providers.json';
const KEY = 'sk-synthetic-0123456789';

function provider(id: string, connected: boolean): LoginProvider {
  return {
    id,
    name: id.toUpperCase(),
    connected,
    featured: false,
    europe: false,
    methods: [{ id: 'key', kind: 'key', label: 'API key', fields: [] }],
  };
}

interface HarnessOptions {
  file?: string | null;
  allowCustomProviders?: boolean;
  modelPolicy?: ModelPolicy;
  listed?: string[];
  listError?: string;
  connectError?: string;
  /** opencode never lists the new provider: the key is not stored. */
  neverListed?: boolean;
  changedError?: string;
  /** `waitForProvider` waits for this, so a change can be caught in flight. */
  holdWait?: Promise<void>;
  /** lotse's file and the stored keys before the group opens. */
  seed?: { raw: Record<string, unknown>; keys: string[] };
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const file = options.file === undefined ? OUR_FILE : options.file;
  const credentials = new Set<string>(['anthropic', ...(options.seed?.keys ?? [])]);
  if (options.seed && file) files.set(file, JSON.stringify(options.seed.raw));
  const raw = (): Record<string, unknown> => {
    const document = file ? parseProvidersDocument(files.get(file) ?? null) : null;
    return document?.ok ? document.raw : {};
  };
  const ours = (): string[] => documentProviderIds(raw());
  const handmade: ConfiguredProvider = {
    id: 'handmade',
    name: 'By hand',
    baseUrl: 'https://llm.example/v1',
    models: ['m-1'],
    source: '/synthetic/home/.config/opencode/opencode.jsonc',
    ours: false,
    reach: 'remote',
    connected: false,
  };
  const session: SettingsSession = {
    async providers() {
      return [
        provider('anthropic', credentials.has('anthropic')),
        provider('poe', false),
        provider('handmade', false),
      ];
    },
    async configured() {
      const providers = raw()['providers'] as Record<string, { name: string; settings: { baseURL: string } }>;
      const entries = ours().map((id): ConfiguredProvider => {
        const entry = providers[id]!;
        return {
          id,
          name: entry.name,
          baseUrl: entry.settings.baseURL,
          models: ['qwen3:4b'],
          source: OUR_FILE,
          ours: true,
          reach: entry.settings.baseURL.includes('127.0.0.1') ? 'loopback' : 'lan',
          connected: credentials.has(id),
        };
      });
      return [handmade, ...entries];
    },
    async knownIds() {
      return new Set(['anthropic', 'poe', 'ollama', 'handmade', ...ours()]);
    },
    async models() {
      return new Map([['anthropic', ['claude-a', 'claude-b']]]);
    },
    async disconnect(id) {
      calls.push(`disconnect ${id}`);
      return credentials.delete(id) ? 1 : 0;
    },
    async waitForProvider(id) {
      calls.push(`wait ${id}`);
      await options.holdWait;
      return !options.neverListed;
    },
    async connectKey(id, key) {
      calls.push(`key ${id} ${key.length}`);
      if (options.connectError) throw new Error(`${options.connectError} ${key}`);
      credentials.add(id);
    },
    async close() {
      calls.push('close');
    },
  };
  const deps: ProviderSettingsDeps = {
    openSession: async () => {
      calls.push('open');
      return session;
    },
    unavailableReason: () => null,
    file,
    allowCustomProviders: options.allowCustomProviders ?? true,
    ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
    listModels: async (baseUrl, key) => {
      calls.push(`list ${baseUrl} ${key ? 'with-key' : 'no-key'}`);
      if (options.listError) throw new Error(`${options.listError} ${key ?? ''}`);
      return options.listed ?? ['qwen3:4b'];
    },
    sleep: async () => undefined,
    now: () => 0,
    onChanged: () => {
      calls.push('changed');
      if (options.changedError) throw new Error(options.changedError);
    },
    files: {
      read: (path) => parseProvidersDocument(files.get(path) ?? null),
      update: (path, change) => {
        const document = parseProvidersDocument(files.get(path) ?? null);
        if (!document.ok) throw new Error(document.problem);
        files.set(path, JSON.stringify(change(document.raw)));
      },
    },
  };
  const controller = new ProviderSettingsController(deps);
  const states: string[] = [];
  controller.subscribe((state) => states.push(JSON.stringify(state)));
  const view = () => {
    const state = controller.state;
    if (state.step !== 'ready') throw new Error(`not ready: ${state.step}`);
    return state.view;
  };
  return { controller, calls, files, states, view };
}

const OLLAMA = { preset: 'local-ollama', models: [], confirmedLan: false } as const;

/** lotse's file with the Ollama preset in it, as a seed. */
function ollamaDocument(): Record<string, unknown> {
  const plan = planCustomProvider(
    { ...OLLAMA, models: [{ id: 'qwen3:4b' }] },
    { knownIds: new Set(), ownIds: new Set() },
  );
  if (plan.kind !== 'ok') throw new Error('the preset did not plan');
  return { ...withProvider({}, plan.provider) };
}

async function until(seen: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !seen(); i += 1) await Promise.resolve();
  if (!seen()) throw new Error('never happened');
}

export default async () => {
  await describe('ProviderSettingsController', async () => {
    await it('lists the connected providers without the custom ones, and the privacy notes', async () => {
      const h = harness();
      await h.controller.open();
      const view = h.view();
      expect(view.connected.map((row) => `${row.id}:${row.models}:${row.offered}`).join()).toBe(
        'anthropic:2:true',
      );
      expect(view.custom?.editable).toBe(true);
      expect(view.custom?.providers.map((row) => `${row.id}:${row.removable}`).join()).toBe('handmade:false');
      expect(view.custom?.providers[0]?.privacyNote).toBe(reachPrivacyNote('remote'));
      expect(view.privacy.join('|')).toBe(`${PROVIDER_PRIVACY_NOTE}|${FREE_MODELS_PRIVACY_NOTE}`);
    });

    await it('says unavailable and starts nothing when the agent has no server', async () => {
      const h = harness();
      const controller = new ProviderSettingsController({
        ...({} as ProviderSettingsDeps),
        openSession: async () => {
          throw new Error('must not start');
        },
        unavailableReason: () => 'claude has no login lotse can run',
        file: null,
        allowCustomProviders: true,
        listModels: async () => [],
        sleep: async () => undefined,
        now: () => 0,
      });
      await controller.open();
      expect(controller.state.step).toBe('unavailable');
      expect(h.calls.length).toBe(0);
    });

    await it('takes the custom part away when the host switches it off, and refuses an add', async () => {
      const h = harness({ allowCustomProviders: false });
      await h.controller.open();
      expect(h.view().custom).toBe(null);
      const outcome = await h.controller.addCustom(OLLAMA);
      expect(outcome.kind).toBe('refused');
      expect(h.files.size).toBe(0);
    });

    await it('is read-only on an opencode that is not lotse’s copy', async () => {
      const h = harness({ file: null });
      await h.controller.open();
      expect(h.view().custom?.editable).toBe(false);
      expect(h.view().custom?.readOnlyReason).toBe(NOT_LOTSE_COPY_REASON);
      const outcome = await h.controller.addCustom(OLLAMA);
      expect(outcome.kind === 'refused' && outcome.reason).toBe(NOT_LOTSE_COPY_REASON);
    });

    await it('adds a preset with the models the server lists, restarts the agent and shows it', async () => {
      const h = harness();
      await h.controller.open();
      const outcome = await h.controller.addCustom(OLLAMA);
      expect(outcome.kind).toBe('added');
      expect(h.calls.includes('list http://127.0.0.1:11434/v1 no-key')).toBe(true);
      expect(h.calls.includes('changed')).toBe(true);
      expect(h.files.get(OUR_FILE)?.includes('qwen3:4b')).toBe(true);
      const row = h.view().custom?.providers.find((entry) => entry.id === 'local-ollama');
      expect(row?.removable).toBe(true);
      expect(row?.privacyNote).toBe(null);
      expect(h.view().message).toBe('Added local-ollama.');
    });

    await it('hands a key to connect/key once and never into the state or the file', async () => {
      const h = harness();
      await h.controller.open();
      const outcome = await h.controller.addCustom(OLLAMA, KEY);
      expect(outcome.kind).toBe('added');
      expect(h.calls.filter((call) => call.startsWith('key ')).join()).toBe(`key local-ollama ${KEY.length}`);
      expect(h.calls.includes('list http://127.0.0.1:11434/v1 with-key')).toBe(true);
      expect(h.files.get(OUR_FILE)?.includes(KEY)).toBe(false);
      expect(h.states.some((state) => state.includes(KEY))).toBe(false);
      expect(h.view().custom?.providers.find((entry) => entry.id === 'local-ollama')?.keyStored).toBe(true);
    });

    await it('redacts the key from a refusal a server echoed it in', async () => {
      const h = harness({ connectError: 'rejected' });
      await h.controller.open();
      const outcome = await h.controller.addCustom(OLLAMA, KEY);
      expect(outcome.kind).toBe('refused');
      expect(JSON.stringify(outcome).includes(KEY)).toBe(false);
      expect(h.states.some((state) => state.includes(KEY))).toBe(false);
      const listing = harness({ listError: 'no route' });
      await listing.controller.open();
      const failed = await listing.controller.addCustom(OLLAMA, KEY);
      expect(failed.kind === 'refused' && failed.reason.includes('[key]')).toBe(true);
    });

    await it('stores no key when opencode never lists the provider', async () => {
      const h = harness({ neverListed: true });
      await h.controller.open();
      const outcome = await h.controller.addCustom(OLLAMA, KEY);
      expect(outcome.kind).toBe('refused');
      expect(h.calls.some((call) => call.startsWith('key '))).toBe(false);
    });

    await it('asks before plain http on the network, and adds once confirmed', async () => {
      const h = harness();
      await h.controller.open();
      const input = { id: 'gpu-box', baseUrl: 'http://192.168.1.20:8000/v1', models: [{ id: 'm' }] };
      const first = await h.controller.addCustom({ ...input, confirmedLan: false });
      expect(first.kind).toBe('confirm');
      expect(h.files.size).toBe(0);
      const second = await h.controller.addCustom({ ...input, confirmedLan: true });
      expect(second.kind).toBe('added');
      expect(second.kind === 'added' && second.notes.includes(reachPrivacyNote('lan')!)).toBe(true);
    });

    await it('refuses to shadow a catalog id and a remote plain-http URL', async () => {
      const h = harness();
      await h.controller.open();
      const shadow = await h.controller.addCustom({
        id: 'ollama',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [{ id: 'm' }],
        confirmedLan: false,
      });
      expect(shadow.kind).toBe('refused');
      const remote = await h.controller.addCustom({
        id: 'far',
        baseUrl: 'http://llm.example/v1',
        models: [{ id: 'm' }],
        confirmedLan: true,
      });
      expect(remote.kind).toBe('refused');
      expect(h.calls.some((call) => call.startsWith('list '))).toBe(false);
    });

    await it('removes a custom provider’s key before its entry, and refuses one it did not write', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.addCustom(OLLAMA, KEY);
      await h.controller.removeCustom('local-ollama');
      const disconnect = h.calls.lastIndexOf('disconnect local-ollama');
      expect(disconnect > 0).toBe(true);
      expect(h.files.get(OUR_FILE)?.includes('local-ollama')).toBe(false);
      expect(h.view().message).toBe('Removed local-ollama and its stored key.');
      await h.controller.removeCustom('handmade');
      expect(h.view().message?.includes('not in lotse')).toBe(true);
    });

    await it('logs out of a provider and reports a failed restart without undoing it', async () => {
      const h = harness({ changedError: 'a turn is still running' });
      await h.controller.open();
      await h.controller.disconnect('anthropic');
      expect(h.view().connected.length).toBe(0);
      expect(h.view().message?.includes('a turn is still running')).toBe(true);
    });

    await it('marks what the host policy allows nothing of, and says free models are off', async () => {
      const h = harness({ modelPolicy: allowOnlyProviders(['poe']) });
      await h.controller.open();
      expect(h.view().connected[0]?.offered).toBe(false);
      expect(h.view().custom?.providers[0]?.offered).toBe(false);
      expect(h.view().privacy.includes(FREE_MODELS_DENIED_NOTE)).toBe(true);
      const free = harness({ modelPolicy: denyFreeHostedModels });
      await free.controller.open();
      expect(free.view().privacy.includes(FREE_MODELS_DENIED_NOTE)).toBe(true);
      expect(free.view().connected[0]?.offered).toBe(true);
    });

    await it('refuses to remove a custom provider when the host switched the custom part off', async () => {
      const h = harness({ allowCustomProviders: false, seed: { raw: ollamaDocument(), keys: [] } });
      await h.controller.open();
      const before = h.files.get(OUR_FILE);
      await h.controller.removeCustom('local-ollama');
      expect(h.files.get(OUR_FILE)).toBe(before);
      expect(h.calls.some((call) => call.startsWith('disconnect '))).toBe(false);
      expect(h.view().message?.includes('does not add or remove')).toBe(true);
    });

    await it('lists a keyed custom provider as connected when the custom part is off', async () => {
      const h = harness({
        allowCustomProviders: false,
        seed: { raw: ollamaDocument(), keys: ['local-ollama'] },
      });
      await h.controller.open();
      const row = h.view().connected.find((entry) => entry.id === 'local-ollama');
      expect(row?.models).toBe(1);
      expect(row?.removable).toBe(true);
      await h.controller.disconnect('local-ollama');
      expect(h.view().connected.some((entry) => entry.id === 'local-ollama')).toBe(false);
    });

    await it('logs out of nothing on a host opencode', async () => {
      const h = harness({ file: null });
      await h.controller.open();
      expect(h.view().connectedReadOnlyReason).toBe(HOST_READ_ONLY_REASON);
      expect(h.view().connected.every((row) => !row.removable)).toBe(true);
      await h.controller.disconnect('anthropic');
      expect(h.calls.some((call) => call.startsWith('disconnect '))).toBe(false);
      expect(h.view().connected.length).toBe(1);
      expect(h.view().message).toBe(HOST_READ_ONLY_REASON);
    });

    await it('lets a running change finish before close stops the server', async () => {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({ holdWait: held });
      await h.controller.open();
      const adding = h.controller.addCustom(OLLAMA, KEY);
      await until(() => h.calls.includes('wait local-ollama'));
      const closing = h.controller.close();
      await until(() => h.controller.state.step === 'closed');
      expect(h.calls.includes('close')).toBe(false);
      release();
      await Promise.all([adding, closing]);
      const key = h.calls.indexOf(`key local-ollama ${KEY.length}`);
      expect(key > 0 && key < h.calls.indexOf('close')).toBe(true);
    });

    await it('reloads once a change ends when asked to meanwhile', async () => {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({ holdWait: held });
      await h.controller.open();
      const adding = h.controller.addCustom(OLLAMA, KEY);
      await until(() => h.calls.includes('wait local-ollama'));
      await h.controller.reload();
      expect(h.calls.filter((call) => call === 'open').length).toBe(1);
      release();
      await adding;
      expect(h.calls.filter((call) => call === 'open').length).toBe(2);
      expect(h.controller.state.step).toBe('ready');
    });

    await it('starts over on reload and closes its server once on close', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.reload();
      expect(h.calls.filter((call) => call === 'open').length).toBe(2);
      expect(h.controller.state.step).toBe('ready');
      await h.controller.close();
      await h.controller.close();
      expect(h.calls.filter((call) => call === 'close').length).toBe(2);
      expect(h.controller.state.step).toBe('closed');
    });
  });

  await describe('providerOffered', async () => {
    await it('offers everything without a policy, and asks by provider without known models', async () => {
      expect(providerOffered(undefined, 'any')).toBe(true);
      expect(providerOffered(allowOnlyProviders(['a']), 'a')).toBe(true);
      expect(providerOffered(allowOnlyProviders(['a']), 'b')).toBe(false);
      const exact: ModelPolicy = (model) => (model === 'a/m-2' ? 'allow' : 'deny');
      expect(providerOffered(exact, 'a', ['m-1', 'm-2'])).toBe(true);
      expect(providerOffered(exact, 'a', ['m-1'])).toBe(false);
      // A predicate cannot be asked about a provider, so without `allowsProvider` nothing is hidden.
      expect(providerOffered(exact, 'a')).toBe(true);
      const narrowed = Object.assign(exact, { allowsProvider: (id: string) => id === 'a' });
      expect(providerOffered(narrowed, 'a')).toBe(true);
      expect(providerOffered(narrowed, 'b')).toBe(false);
      const broken = Object.assign((): 'allow' => 'allow', {
        allowsProvider: (): boolean => {
          throw new Error('host bug');
        },
      });
      expect(providerOffered(broken, 'a')).toBe(false);
    });
  });

  await describe('customProvidersFileOf', async () => {
    await it('finds lotse’s file on its own copy only', async () => {
      expect(customProvidersFileOf({ id: 'opencode', env: { OPENCODE_CONFIG: OUR_FILE } })).toBe(OUR_FILE);
      expect(customProvidersFileOf({ id: 'opencode', env: { OPENCODE_CONFIG: '' } })).toBe(null);
      expect(
        customProvidersFileOf({ id: 'opencode', env: { OPENCODE_CONFIG: '/home/x/opencode.json' } }),
      ).toBe(null);
      expect(customProvidersFileOf({ id: 'opencode' })).toBe(null);
      expect(customProvidersFileOf({ id: 'claude', env: { OPENCODE_CONFIG: OUR_FILE } })).toBe(null);
    });
  });

  await describe('parseModelList', async () => {
    await it('groups `/api/model` by provider and skips malformed entries', async () => {
      const models = parseModelList({
        data: [
          { id: 'claude-a', providerID: 'anthropic' },
          { id: 'claude-b', providerID: 'anthropic' },
          { id: 'qwen3:4b', providerID: 'local-ollama' },
          { id: 7 },
          null,
        ],
      });
      expect(models.get('anthropic')?.join()).toBe('claude-a,claude-b');
      expect(models.get('local-ollama')?.join()).toBe('qwen3:4b');
      expect(models.size).toBe(2);
      expect(() => parseModelList({})).toThrow();
    });
  });

  await describe('LoginController offers', async () => {
    await it('lists only the providers the host offers', async () => {
      const session = {
        providers: async () => [provider('a', false), provider('b', false)],
        close: async () => undefined,
      } as unknown as LoginSession;
      const controller = new LoginController({
        openSession: async () => session,
        unavailableReason: () => null,
        sleep: async () => undefined,
        now: () => 0,
        offers: (entry) => providerOffered(allowOnlyProviders(['b']), entry.id),
      });
      await controller.open();
      const state = controller.state;
      expect(state.step === 'providers' && state.providers.map((entry) => entry.id).join()).toBe('b');
      const exact: ModelPolicy = (model) => (model === 'a/m-1' ? 'allow' : 'deny');
      const all = new LoginController({
        openSession: async () => session,
        unavailableReason: () => null,
        sleep: async () => undefined,
        now: () => 0,
        offers: (entry) => providerOffered(exact, entry.id),
      });
      await all.open();
      const listed = all.state;
      expect(listed.step === 'providers' && listed.providers.map((entry) => entry.id).join()).toBe('a,b');
    });

    await it('tells onStored of a login even when the restart after it fails', async () => {
      const stored: string[] = [];
      const session = {
        providers: async () => [provider('a', false)],
        connectKey: async () => undefined,
        close: async () => undefined,
      } as unknown as LoginSession;
      const controller = new LoginController({
        openSession: async () => session,
        unavailableReason: () => null,
        sleep: async () => undefined,
        now: () => 0,
        onStored: (entry) => void stored.push(entry.id),
        onConnected: () => {
          throw new Error('a turn is still running');
        },
      });
      await controller.open();
      await controller.pickProvider(provider('a', false));
      await controller.submitKey(provider('a', false), 'sk-synthetic');
      expect(stored.join()).toBe('a');
      expect(controller.state.step).toBe('failed');
    });
  });
};
