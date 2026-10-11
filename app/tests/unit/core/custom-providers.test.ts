/**
 * Custom providers: where a URL may point, the file lotse writes, what opencode reports back, and the plan
 * the CLI and the settings group both ask. Bodies are the shapes measured on opencode 2.0.25; every id,
 * URL and key is synthetic.
 */

import { describe, expect, it } from '@gjsify/unit';

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CUSTOM_PRESETS,
  bundledCommand,
  checkEndpoint,
  connectionFacts,
  contextWarning,
  createProviderApi,
  customProvidersEnv,
  customProvidersFile,
  documentProviderIds,
  hostReach,
  isolationDirs,
  parseConfiguredProviders,
  parseModelSpecs,
  parseProvidersDocument,
  planCustomProvider,
  probeModels,
  readProvidersDocument,
  withProvider,
  withoutProvider,
  writeProvidersDocument,
  type BundledAgent,
  type CustomProviderFacts,
  type HttpResponse,
  type LoginProvider,
  type Send,
} from '@lotse/core';

const OUR_FILE = '/synthetic/agents/opencode/config/lotse-providers.json';

/** `GET /api/config` with the directory's file and lotse's own, as measured. */
const CONFIG = {
  status: 200,
  json: [
    {
      type: 'document',
      path: '/synthetic/agents/opencode/config/opencode/opencode.jsonc',
      info: {
        providers: {
          handmade: {
            name: 'By hand',
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL: 'https://llm.example/v1' },
            models: { 'm-1': { name: 'M 1' } },
          },
        },
      },
    },
    { type: 'directory', path: '/synthetic/agents/opencode/config/opencode' },
    {
      type: 'document',
      path: OUR_FILE,
      info: {
        providers: {
          'local-ollama': {
            name: 'Ollama',
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL: 'http://127.0.0.1:11434/v1' },
            models: { 'qwen3:4b': { name: 'qwen3:4b', limit: { context: 8192, output: 4096 } } },
          },
        },
      },
    },
  ],
};

const INTEGRATIONS = {
  status: 200,
  json: {
    data: [
      { id: 'lmstudio', name: 'LMStudio', methods: [{ type: 'key' }], connections: [] },
      {
        id: 'handmade',
        name: 'By hand',
        methods: [{ type: 'key', label: 'Manually enter API Key' }],
        connections: [{ type: 'credential', id: 'cred_synthetic', label: 'By hand', method: 'key' }],
      },
      { id: 'local-ollama', name: 'Ollama', methods: [{ type: 'key' }], connections: [] },
    ],
  },
};

const RUNTIME = { status: 200, json: { data: [{ id: 'ollama', name: 'Ollama' }, { id: 'opencode' }] } };

function router(routes: Record<string, HttpResponse>) {
  const requests: string[] = [];
  const send: Send = async (method, path) => {
    requests.push(`${method} ${path}`);
    return routes[`${method} ${path}`] ?? { status: 404, json: { message: 'not found' } };
  };
  return { send, requests };
}

const FACTS: CustomProviderFacts = {
  knownIds: new Set(['ollama', 'lmstudio', 'opencode', 'local-ollama']),
  ownIds: new Set(['local-ollama']),
};

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lotse-custom-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('checkEndpoint', async () => {
    await it('takes https anywhere and http on loopback without asking', async () => {
      const remote = checkEndpoint('https://llm.example/v1/');
      expect(remote.ok && remote.baseUrl).toBe('https://llm.example/v1');
      expect(remote.ok && remote.reach).toBe('remote');
      expect(remote.ok && remote.needsConfirmation).toBe(false);
      for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1']) {
        const local = checkEndpoint(url);
        expect(local.ok && local.reach).toBe('loopback');
        expect(local.ok && local.needsConfirmation).toBe(false);
        expect(local.ok && local.privacyNote).toBe(null);
      }
    });

    await it('asks before plain http on the local network, and notes the privacy cost', async () => {
      for (const url of [
        'http://192.168.1.20:8000/v1',
        'http://10.0.0.5/v1',
        'http://172.20.0.1/v1',
        'http://gpu-box:8000/v1',
        'http://gpu.local/v1',
        'http://[fd00::1]/v1',
      ]) {
        const check = checkEndpoint(url);
        expect(check.ok && check.reach).toBe('lan');
        expect(check.ok && check.needsConfirmation).toBe(true);
        expect(check.ok && typeof check.privacyNote).toBe('string');
      }
      // https on the network needs no confirmation, but is still not this machine.
      const tls = checkEndpoint('https://192.168.1.20/v1');
      expect(tls.ok && tls.needsConfirmation).toBe(false);
      expect(tls.ok && typeof tls.privacyNote).toBe('string');
    });

    await it('refuses plain http elsewhere, a key in the URL, and what is not a URL', async () => {
      expect(checkEndpoint('http://llm.example/v1').ok).toBe(false);
      expect(checkEndpoint('http://172.32.0.1/v1').ok).toBe(false);
      expect(checkEndpoint('https://user:synthetic-key@llm.example/v1').ok).toBe(false);
      expect(checkEndpoint('https://llm.example/v1?key=x').ok).toBe(false);
      expect(checkEndpoint('ftp://llm.example/').ok).toBe(false);
      expect(checkEndpoint('localhost:11434').ok).toBe(false);
    });

    await it('reads hosts it is given bare', async () => {
      expect(hostReach('127.1.2.3')).toBe('loopback');
      expect(hostReach('169.254.1.1')).toBe('lan');
      expect(hostReach('8.8.8.8')).toBe('remote');
      expect(hostReach('2001:db8::1')).toBe('remote');
    });
  });

  await describe('contextWarning', async () => {
    await it('warns below 8192 and says nothing when the context is unknown or enough', async () => {
      expect(typeof contextWarning('m', 4096)).toBe('string');
      expect(contextWarning('m', 8192)).toBe(null);
      expect(contextWarning('m', undefined)).toBe(null);
    });
  });

  await describe('parseModelSpecs', async () => {
    await it('reads id and id=context, with a colon in the id', async () => {
      expect(parseModelSpecs(['qwen3:4b=8192', 'llama'])).toStrictEqual([
        { id: 'qwen3:4b', context: 8192 },
        { id: 'llama' },
      ]);
      expect(typeof parseModelSpecs(['m=lots'])).toBe('string');
      expect(typeof parseModelSpecs(['=8192'])).toBe('string');
    });
  });

  await describe('the provider file', async () => {
    const dirs = isolationDirs('/synthetic/data/lotse', 'opencode');

    await it('lives in the bundled copy’s config directory and is named by OPENCODE_CONFIG', async () => {
      expect(customProvidersFile(dirs)).toBe(
        '/synthetic/data/lotse/agents/opencode/config/lotse-providers.json',
      );
      expect(customProvidersEnv('opencode', dirs)).toStrictEqual({
        OPENCODE_CONFIG: customProvidersFile(dirs),
      });
      expect(customProvidersEnv('other', dirs)).toStrictEqual({});
    });

    await it('overrides the catalog’s blanked OPENCODE_CONFIG in the bundled command', async () => {
      const entry = {
        id: 'opencode',
        title: 'OpenCode',
        version: '0.0.0',
        license: 'MIT',
        dist: [],
        command: ['acp'],
        env: { OPENCODE_CONFIG: '' },
        refreshed: '2026-01-01',
        installPath: '/synthetic/opencode',
        binary: 'bin/opencode',
      } as unknown as BundledAgent;
      expect(bundledCommand(entry, dirs).env?.['OPENCODE_CONFIG']).toBe(customProvidersFile(dirs));
    });

    await it('writes the measured v2 shape, with no key, and keeps every other key', async () => {
      const start = { theme: 'kept', providers: { other: { name: 'Other' } } };
      const doc = withProvider(start, {
        id: 'local-ollama',
        name: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'qwen3:4b', context: 8192 }, { id: 'llama' }],
      });
      expect(doc['theme']).toBe('kept');
      expect(documentProviderIds(doc)).toStrictEqual(['other', 'local-ollama']);
      expect((doc['providers'] as Record<string, unknown>)['local-ollama']).toStrictEqual({
        name: 'Ollama',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:11434/v1' },
        models: {
          'qwen3:4b': { name: 'qwen3:4b', limit: { context: 8192, output: 4096 } },
          llama: { name: 'llama' },
        },
      });
      expect(JSON.stringify(doc).includes('apiKey')).toBe(false);
      expect(documentProviderIds(withoutProvider(doc, 'local-ollama'))).toStrictEqual(['other']);
    });

    await it('reads a missing file as empty and refuses one it cannot read', async () => {
      expect(parseProvidersDocument(null)).toStrictEqual({ ok: true, raw: {} });
      expect(parseProvidersDocument('{oops').ok).toBe(false);
      expect(parseProvidersDocument('[]').ok).toBe(false);
      expect(parseProvidersDocument('{"providers": 1}').ok).toBe(false);
    });

    await it('writes 0600 in a 0700 directory, whole', async () => {
      withTempDir((dir) => {
        const file = join(dir, 'config', 'lotse-providers.json');
        expect(readProvidersDocument(file)).toStrictEqual({ ok: true, raw: {} });
        writeProvidersDocument(file, { providers: {} });
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700);
        expect(existsSync(`${file}.tmp`)).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({ providers: {} });
        writeFileSync(file, 'not json');
        expect(readProvidersDocument(file).ok).toBe(false);
      });
    });
  });

  await describe('createProviderApi', async () => {
    await it('reads back providers from every document, marks lotse’s own and the connected ones', async () => {
      const r = router({ 'GET /api/config': CONFIG, 'GET /api/integration': INTEGRATIONS });
      const providers = await createProviderApi(r.send).configured(OUR_FILE);
      expect(providers.map((p) => [p.id, p.ours, p.connected, p.reach])).toStrictEqual([
        ['handmade', false, true, 'remote'],
        ['local-ollama', true, false, 'loopback'],
      ]);
      expect(providers[1]!.models).toStrictEqual(['qwen3:4b']);
    });

    await it('knows the catalog ids and the runtime ones', async () => {
      const r = router({ 'GET /api/integration': INTEGRATIONS, 'GET /api/provider': RUNTIME });
      const ids = await createProviderApi(r.send).knownIds();
      expect(ids.has('ollama')).toBe(true);
      expect(ids.has('lmstudio')).toBe(true);
    });

    await it('disconnects by the credential ids on the integration, never by reading /api/credential', async () => {
      const r = router({
        'GET /api/integration/handmade': {
          status: 200,
          json: { data: { id: 'handmade', connections: [{ id: 'cred_synthetic' }] } },
        },
        'DELETE /api/credential/cred_synthetic': { status: 204, json: null },
      });
      expect(await createProviderApi(r.send).disconnect('handmade')).toBe(1);
      expect(r.requests).toStrictEqual([
        'GET /api/integration/handmade',
        'DELETE /api/credential/cred_synthetic',
      ]);
      expect(await createProviderApi(router({}).send).disconnect('gone')).toBe(0);
    });

    await it('waits for a written provider to appear, and gives up at the deadline', async () => {
      let clock = 0;
      const hooks = { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
      let asked = 0;
      const appears: Send = async () =>
        ++asked < 3 ? { status: 404, json: null } : { status: 200, json: {} };
      expect(await createProviderApi(appears).waitForProvider('x', hooks)).toBe(true);
      expect(asked).toBe(3);
      clock = 0;
      expect(await createProviderApi(router({}).send).waitForProvider('x', hooks, 1000)).toBe(false);
    });

    await it('parses an OpenAI /models list, sending a given key only as a header', async () => {
      const seen: string[] = [];
      const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
        seen.push(`${url} ${init.headers['authorization'] ?? 'none'}`);
        return {
          status: 200,
          json: async () => ({ object: 'list', data: [{ id: 'qwen3:4b' }, { id: 'llama' }] }),
        };
      };
      expect(await probeModels('http://127.0.0.1:11434/v1', fetchFn)).toStrictEqual(['qwen3:4b', 'llama']);
      await probeModels('https://llm.example/v1', fetchFn, 'synthetic-key');
      expect(seen).toStrictEqual([
        'http://127.0.0.1:11434/v1/models none',
        'https://llm.example/v1/models Bearer synthetic-key',
      ]);
    });

    await it('throws on a config body that is not documents', async () => {
      let threw = false;
      try {
        parseConfiguredProviders({ data: 1 }, OUR_FILE);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  await describe('planCustomProvider', async () => {
    await it('fills a preset and notes what the server needs', async () => {
      const plan = planCustomProvider(
        { preset: 'local-llamacpp', models: [{ id: 'm', context: 4096 }], confirmedLan: false },
        FACTS,
      );
      expect(plan.kind).toBe('ok');
      if (plan.kind !== 'ok') return;
      expect(plan.provider).toStrictEqual({
        id: 'local-llamacpp',
        name: 'llama.cpp',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: [{ id: 'm', context: 4096 }],
      });
      expect(plan.replaces).toBe(false);
      expect(plan.notes.length).toBe(1);
    });

    await it('never shadows an opencode id, but edits its own', async () => {
      const shadow = planCustomProvider(
        { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'm' }], confirmedLan: false },
        FACTS,
      );
      expect(shadow.kind).toBe('refused');
      const edit = planCustomProvider(
        { preset: 'local-ollama', models: [{ id: 'm' }], confirmedLan: false },
        FACTS,
      );
      expect(edit.kind === 'ok' && edit.replaces).toBe(true);
    });

    await it('asks for LAN http, then takes it once confirmed', async () => {
      const input = { id: 'gpu-box', baseUrl: 'http://192.168.1.20:8000/v1', models: [{ id: 'm' }] };
      expect(planCustomProvider({ ...input, confirmedLan: false }, FACTS).kind).toBe('confirm');
      const yes = planCustomProvider({ ...input, confirmedLan: true }, FACTS);
      expect(yes.kind === 'ok' && yes.reach).toBe('lan');
    });

    await it('refuses no models, a bad id and an unknown preset', async () => {
      expect(planCustomProvider({ preset: 'local-vllm', models: [], confirmedLan: false }, FACTS).kind).toBe(
        'refused',
      );
      expect(
        planCustomProvider(
          { id: 'Bad Id', baseUrl: 'https://x.example', models: [{ id: 'm' }], confirmedLan: false },
          FACTS,
        ).kind,
      ).toBe('refused');
      expect(
        planCustomProvider({ preset: 'nope', models: [{ id: 'm' }], confirmedLan: false }, FACTS).kind,
      ).toBe('refused');
    });

    await it('keeps every preset clear of the ids opencode ships', async () => {
      for (const preset of CUSTOM_PRESETS) expect(['ollama', 'lmstudio'].includes(preset.id)).toBe(false);
    });
  });

  await describe('connectionFacts with custom providers', async () => {
    const unconnected: LoginProvider = {
      id: 'x',
      name: 'X',
      connected: false,
      featured: false,
      europe: false,
      methods: [{ id: 'key', kind: 'key', label: 'API key', fields: [] }],
    };

    await it('counts a keyless local provider as connected, a remote one without a key not', async () => {
      expect(connectionFacts([unconnected], [{ reach: 'loopback' }]).kind).toBe('connected');
      expect(connectionFacts([unconnected], [{ reach: 'lan' }]).kind).toBe('connected');
      expect(connectionFacts([unconnected], [{ reach: 'remote' }]).kind).toBe('none');
      expect(connectionFacts([unconnected]).kind).toBe('none');
    });
  });
};
