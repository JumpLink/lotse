/**
 * Where a custom provider may point, and what lotse says about it. Pure: no network, no process.
 *
 * **A base URL is a decision about where the prompts go.** opencode sends every prompt, every file it
 * read and every tool result to it, so the rule is about reach, not about syntax (#17, decided
 * 2026-10-11):
 *
 * - `https` anywhere, or `http` on **this machine** (loopback): accepted without asking. TLS protects the
 *   way there; a loopback server never leaves the machine.
 * - `http` on the **local network** (RFC 1918, link-local, ULA, a `.local`/`.lan`/`.home.arpa` name or a
 *   bare host name): accepted only after the person confirms. Anyone on that network can read it.
 * - `http` anywhere else: refused. A prompt in clear text across the internet is not a setting.
 *
 * Any endpoint that is not on this machine also gets a **privacy note**, because "my own server" and
 * "somebody's API" look the same in a URL field.
 *
 * Credentials in the URL (`user:pass@`) are refused: a key goes to opencode through `connect/key` and is
 * never written into a file (`AGENTS.md` § Privacy), and a URL is written into one.
 */

/** Where the endpoint is, as far as a URL can tell. */
export type EndpointReach = 'loopback' | 'lan' | 'remote';

export type EndpointCheck =
  | {
      readonly ok: true;
      /** The URL as it will be written: no trailing slash. */
      readonly baseUrl: string;
      readonly reach: EndpointReach;
      /** Plain `http` on the local network: the person has to say yes first. */
      readonly needsConfirmation: boolean;
      /** A sentence for any endpoint that is not on this machine, else `null`. */
      readonly privacyNote: string | null;
    }
  | { readonly ok: false; readonly reason: string };

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

/** Where `host` (a URL's hostname, IPv6 with or without brackets) is. */
export function hostReach(host: string): EndpointReach {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return 'loopback';
  const v4 = ipv4(name.startsWith('::ffff:') ? name.slice(7) : name);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return 'loopback';
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return 'lan';
    }
    return 'remote';
  }
  if (name.includes(':')) {
    // fc00::/7 (unique local) and fe80::/10 (link-local); every other IPv6 address is routable.
    return /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name) ? 'lan' : 'remote';
  }
  // A bare host name only resolves on the local network; so do the names reserved for it.
  if (!name.includes('.') || /\.(local|lan|home\.arpa|internal)$/.test(name)) return 'lan';
  return 'remote';
}

const PRIVACY_NOTE: Record<Exclude<EndpointReach, 'loopback'>, string> = {
  lan:
    'This server is on your network, not on this machine: everything you send — prompts, files the ' +
    'agent reads, tool output — travels there, and over plain http anyone on the network can read it.',
  remote:
    'This server is not on this machine: everything you send — prompts, files the agent reads, tool ' +
    'output — goes to whoever runs it, under their terms.',
};

/** Check a base URL against the rules above. */
export function checkEndpoint(raw: string): EndpointCheck {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `"${text}" is not a URL — it looks like http://127.0.0.1:11434/v1` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `only http and https are possible, not ${url.protocol.replace(/:$/, '')}` };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'a key does not go into the URL — give it as the key, which opencode keeps',
    };
  }
  if (url.search || url.hash) return { ok: false, reason: 'a base URL has no query and no fragment' };
  const reach = hostReach(url.hostname);
  if (url.protocol === 'http:' && reach === 'remote') {
    return {
      ok: false,
      reason:
        'plain http is only possible on this machine or your local network — use https for a server elsewhere',
    };
  }
  return {
    ok: true,
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    reach,
    needsConfirmation: url.protocol === 'http:' && reach === 'lan',
    privacyNote: reach === 'loopback' ? null : PRIVACY_NOTE[reach],
  };
}

export interface CustomPreset {
  /** The id the provider gets unless the person names another. Never a catalog id (`local-` prefix). */
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Said under the preset: what the person has to do on the server's side. */
  readonly note?: string;
}

/**
 * Measured on opencode 2.0.22 / Ollama 0.35.1: Ollama's default context depends on VRAM (4096 at 8 GB),
 * which cuts opencode's ~4300-token system prompt in half and leaves the model reading in a loop.
 * `num_ctx` cannot be set through `/v1`, only on the server.
 */
const OLLAMA_NOTE =
  'Set the context on the server, e.g. OLLAMA_CONTEXT_LENGTH=8192: Ollama picks a small default on small ' +
  'GPUs, and the agent cannot change it.';

/** The local servers a person picks rather than types a URL for. `local-` keeps clear of opencode's own ids (`ollama`, `lmstudio`). */
export const CUSTOM_PRESETS: readonly CustomPreset[] = [
  { id: 'local-ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', note: OLLAMA_NOTE },
  { id: 'local-lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'local-llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'local-vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
];

/** Below this, opencode's own system prompt does not fit (measured: ~4300 tokens, plus the tools). */
export const MIN_CONTEXT_TOKENS = 8192;

/** A warning for a model whose context is known and too small, else `null`. */
export function contextWarning(model: string, context: number | undefined): string | null {
  if (context === undefined || context >= MIN_CONTEXT_TOKENS) return null;
  return (
    `${model} has a context of ${context} tokens — below ${MIN_CONTEXT_TOKENS} the agent's own instructions ` +
    'do not fit, and the model loops or forgets the task.'
  );
}

/** The honest expectation, said once wherever a custom provider is added. */
export const LOCAL_MODEL_HINT =
  'Useful agent work needs a large model (around 30B parameters) and a lot of VRAM or unified memory. ' +
  'Small local models answer, but often lose the thread on real tasks; for everyday use the free hosted ' +
  'models or a provider are the better choice.';
