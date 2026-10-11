/**
 * What opencode reports about custom providers, over the same injected `send` as the login.
 *
 * Measured on opencode 2.0.25 against a scratch HOME (`opencode serve`), with one provider in the
 * directory's `opencode.jsonc` and one in an `OPENCODE_CONFIG` file:
 *
 * - `GET /api/config` — a list of the documents opencode read, each `{type: "document", path, info}`,
 *   `info.providers` in the v2 spelling. This is how a provider written **by hand** is read back, and
 *   `path` is how lotse tells its own file from the person's.
 * - `GET /api/integration` — lists a custom provider like a catalog one, with the single method
 *   "Manually enter API Key" and `connections: []` until a key is connected. **A keyless provider is
 *   never "connected" there**, which is why `onboarding.ts` counts a local one itself.
 * - `GET /api/provider` — the runtime providers. It has ids `/api/integration` lacks (`ollama`, found
 *   on its own), so "never shadow a catalog id" checks both.
 * - `POST /api/integration/{id}/connect/key` — works for a custom id; the key then arrives at the server
 *   as `Authorization: Bearer …` (measured with an echo server), and with no credential no header at all.
 * - `DELETE /api/credential/{credentialID}` — 204; the integration's `connections` is empty afterwards.
 *   The credential id is read off `connections`, **never** off `GET /api/credential`, whose body carries
 *   the key itself.
 */

import { LoginApiError, type HttpResponse, type Send } from '../login/api.ts';

import { hostReach, type EndpointReach } from './endpoint.ts';

/** One custom provider opencode has read, from lotse's file or from the person's own config. */
export interface ConfiguredProvider {
  readonly id: string;
  readonly name: string;
  /** `null` when the entry names none (a provider that only overrides a catalog one's models). */
  readonly baseUrl: string | null;
  readonly models: readonly string[];
  /** The config document it came from. */
  readonly source: string;
  /** It is in lotse's own file, so lotse may edit and remove it. Anything else is read-only here. */
  readonly ours: boolean;
  /** Where the base URL points; `null` without one. */
  readonly reach: EndpointReach | null;
  /** opencode holds a credential for it (a key was connected). */
  readonly connected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ok(response: HttpResponse): HttpResponse {
  if (response.status < 200 || response.status >= 300) {
    const message = isRecord(response.json) ? response.json['message'] : undefined;
    throw new LoginApiError(
      response.status,
      typeof message === 'string' && message ? message : `HTTP ${response.status}`,
    );
  }
  return response;
}

function reachOf(baseUrl: string | null): EndpointReach | null {
  if (!baseUrl) return null;
  try {
    return hostReach(new URL(baseUrl).hostname);
  } catch {
    return null;
  }
}

/**
 * The providers in a `GET /api/config` body. A later document wins for the same id, as in opencode's own
 * merge. `connected` is filled from `connectedIds`.
 */
export function parseConfiguredProviders(
  body: unknown,
  ourFile: string,
  connectedIds: ReadonlySet<string> = new Set(),
): ConfiguredProvider[] {
  const documents = isRecord(body) && Array.isArray(body['data']) ? body['data'] : body;
  if (!Array.isArray(documents)) throw new Error('config: the response is not a list of documents');
  const found = new Map<string, ConfiguredProvider>();
  for (const document of documents) {
    if (!isRecord(document) || document['type'] !== 'document' || !isRecord(document['info'])) continue;
    const path = typeof document['path'] === 'string' ? document['path'] : '';
    const providers = document['info']['providers'];
    if (!isRecord(providers)) continue;
    for (const [id, entry] of Object.entries(providers)) {
      if (!isRecord(entry)) continue;
      const settings = isRecord(entry['settings']) ? entry['settings'] : {};
      const baseUrl = typeof settings['baseURL'] === 'string' ? settings['baseURL'] : null;
      found.set(id, {
        id,
        name: typeof entry['name'] === 'string' && entry['name'] ? entry['name'] : id,
        baseUrl,
        models: isRecord(entry['models']) ? Object.keys(entry['models']) : [],
        source: path,
        ours: path === ourFile,
        reach: reachOf(baseUrl),
        connected: connectedIds.has(id),
      });
    }
  }
  return [...found.values()];
}

/** The ids in a `{data: [{id}]}` body — `/api/integration`, `/api/provider` and an OpenAI `/models` alike. */
export function parseIdList(body: unknown): string[] {
  const list = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(list)) throw new Error('the response has no `data` list');
  return list.flatMap((entry) => (isRecord(entry) && typeof entry['id'] === 'string' ? [entry['id']] : []));
}

function connectedIdsOf(body: unknown): Set<string> {
  const list = isRecord(body) && Array.isArray(body['data']) ? body['data'] : [];
  return new Set(
    list.flatMap((entry) =>
      isRecord(entry) &&
      typeof entry['id'] === 'string' &&
      Array.isArray(entry['connections']) &&
      entry['connections'].length > 0
        ? [entry['id']]
        : [],
    ),
  );
}

export interface WaitHooks {
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** How long a written file may take to reach a running server. Measured: under two seconds. */
export const RELOAD_TIMEOUT_MS = 10_000;

export interface ProviderApi {
  /** Every custom provider opencode has read; `ourFile` marks lotse's own. */
  configured(ourFile: string): Promise<ConfiguredProvider[]>;
  /** Every id opencode knows — catalog and runtime — so a new custom id shadows none. */
  knownIds(): Promise<Set<string>>;
  /** Remove every credential opencode holds for `id`. Resolves with how many there were. */
  disconnect(id: string): Promise<number>;
  /** Resolve `true` once opencode lists `id` (after a file write), `false` after `timeoutMs`. */
  waitForProvider(id: string, hooks: WaitHooks, timeoutMs?: number): Promise<boolean>;
}

export function createProviderApi(send: Send): ProviderApi {
  const integration = (id: string) => send('GET', `/api/integration/${encodeURIComponent(id)}`);
  return {
    async configured(ourFile) {
      const [config, integrations] = await Promise.all([
        send('GET', '/api/config'),
        send('GET', '/api/integration'),
      ]);
      return parseConfiguredProviders(ok(config).json, ourFile, connectedIdsOf(ok(integrations).json));
    },
    async knownIds() {
      const [integrations, providers] = await Promise.all([
        send('GET', '/api/integration'),
        send('GET', '/api/provider'),
      ]);
      return new Set([...parseIdList(ok(integrations).json), ...parseIdList(ok(providers).json)]);
    },
    async disconnect(id) {
      const response = await integration(id);
      if (response.status === 404) return 0;
      const body = ok(response).json;
      const data = isRecord(body) ? body['data'] : undefined;
      const connections = isRecord(data) && Array.isArray(data['connections']) ? data['connections'] : [];
      const ids = connections.flatMap((entry) =>
        isRecord(entry) && typeof entry['id'] === 'string' ? [entry['id']] : [],
      );
      for (const credential of ids) {
        const deleted = await send('DELETE', `/api/credential/${encodeURIComponent(credential)}`);
        // Gone already is as good as deleted.
        if (deleted.status !== 404) ok(deleted);
      }
      return ids.length;
    },
    async waitForProvider(id, hooks, timeoutMs = RELOAD_TIMEOUT_MS) {
      const deadline = hooks.now() + timeoutMs;
      for (;;) {
        if ((await integration(id)).status === 200) return true;
        if (hooks.now() >= deadline) return false;
        await hooks.sleep(250);
      }
    },
  };
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/**
 * The models a server lists at `<baseUrl>/models` (the OpenAI shape every local server answers). `key`,
 * when the person gave one, goes to that URL only, in this call only. Rejects on anything but a list.
 */
export async function probeModels(baseUrl: string, fetchFn: FetchLike, key?: string): Promise<string[]> {
  const response = await fetchFn(`${baseUrl}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${baseUrl}/models answered HTTP ${response.status}`);
  }
  return parseIdList(await response.json());
}
