/**
 * The one opencode config file lotse writes: the bundled copy's custom providers.
 *
 * **Why a file of our own, and why only the bundled copy's.** opencode v2 has no API that writes a
 * provider (`PATCH /api/experimental/config` takes only `shell`, measured on 2.0.22 and 2.0.25), so a
 * custom provider is config. The person's own `~/.config/opencode` is theirs — comments, formatting, a
 * backup rule — and lotse does not touch it. The bundled copy's config directory is lotse's
 * (`isolation.ts`), and inside it lotse writes **its own file**, named by `OPENCODE_CONFIG`
 * (`customProvidersEnv`), not the directory's `opencode.jsonc`.
 *
 * Measured on opencode 2.0.25 (scratch HOME, `opencode serve`): `OPENCODE_CONFIG` **merges** with the
 * directory config — both providers listed, `GET /api/config` names both documents; a missing file is no
 * error; and a running server picks up a change to the file within two seconds, an added provider as
 * well as a removed one. The v1 spelling (`provider`, `npm`, `options`) is still read, but `/api/config`
 * reports the v2 one, which is what is written here: `providers.<id>.{name, package, settings.baseURL,
 * models}`.
 *
 * **No key in here, ever.** opencode accepts `settings.apiKey`, and that is exactly the field this file
 * never writes: a key goes through `POST /api/integration/{id}/connect/key` into opencode's own store
 * (`custom/api.ts`). The file holds a URL and model names, so it is mode 0600 for tidiness, not secrecy.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { IsolationDirs } from '../agents/isolation.ts';

/** The adapter, in opencode v2's spelling. The only one for now (#17): every local server speaks it. */
export const OPENAI_COMPATIBLE_PACKAGE = 'aisdk:@ai-sdk/openai-compatible';

const SCHEMA_URL = 'https://opencode.ai/config.json';

export interface CustomModel {
  readonly id: string;
  readonly name?: string;
  /** Tokens, when the person knows it. Written as `limit.context`; opencode otherwise guesses. */
  readonly context?: number;
}

export interface CustomProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly CustomModel[];
}

/** `<config>/lotse-providers.json` — next to, not inside, the bundled copy's `opencode/` directory. */
export function customProvidersFile(dirs: IsolationDirs): string {
  return join(dirs.config, 'lotse-providers.json');
}

/** What points an agent at that file. Only opencode reads it; another agent gets nothing. */
export function customProvidersEnv(agentId: string, dirs: IsolationDirs): Record<string, string> {
  return agentId === 'opencode' ? { OPENCODE_CONFIG: customProvidersFile(dirs) } : {};
}

/**
 * lotse's file for an agent that was started with one, read back off its environment, or `null`.
 *
 * Off the command rather than from the isolation directories, because a host embedding the widget hands
 * over an `AgentCommand` and nothing else: `bundledCommand` is the one place that sets the variable, so
 * a host opencode (no `OPENCODE_CONFIG`, or the catalog's blanked `""`) answers `null` and stays read-only.
 */
export function customProvidersFileOf(agent: {
  readonly id: string;
  readonly env?: Record<string, string>;
}): string | null {
  const file = agent.id === 'opencode' ? agent.env?.['OPENCODE_CONFIG'] : undefined;
  return file && file.endsWith('/lotse-providers.json') ? file : null;
}

/** A provider id opencode and a URL path both accept. */
export function providerIdProblem(id: string): string | null {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)
    ? null
    : `"${id}" is not a usable id — lower-case letters, digits, ".", "-" and "_", starting with a letter or digit`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One provider entry as opencode reads it. `limit.output` is required next to `context`; half, at most 4096. */
export function providerEntry(provider: CustomProvider): Record<string, unknown> {
  // `fromEntries` defines own properties: an assignment to `models['__proto__']` would set the prototype
  // and drop the model, and a model id is whatever the person's server lists.
  const models = Object.fromEntries(
    provider.models.map((model) => [
      model.id,
      {
        name: model.name ?? model.id,
        ...(model.context === undefined
          ? {}
          : { limit: { context: model.context, output: Math.min(4096, Math.floor(model.context / 2)) } }),
      },
    ]),
  );
  return {
    name: provider.name,
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: { baseURL: provider.baseUrl },
    models,
  };
}

export type ProvidersDocument =
  | { readonly ok: true; readonly raw: Record<string, unknown> }
  /** Unreadable: it is never overwritten, so a hand edit with a typo is not lost. */
  | { readonly ok: false; readonly problem: string };

/** Parse the file's text. Empty or absent text is an empty document. */
export function parseProvidersDocument(text: string | null): ProvidersDocument {
  if (text === null || text.trim() === '') return { ok: true, raw: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(value)) return { ok: false, problem: 'not a JSON object' };
  if (value['providers'] !== undefined && !isRecord(value['providers'])) {
    return { ok: false, problem: '`providers` is not an object' };
  }
  return { ok: true, raw: value };
}

/** The provider ids in a document. */
export function documentProviderIds(raw: Readonly<Record<string, unknown>>): string[] {
  return isRecord(raw['providers']) ? Object.keys(raw['providers']) : [];
}

/** The document with `provider` added or replaced. Every other key — a hand-added one too — stays. */
export function withProvider(
  raw: Readonly<Record<string, unknown>>,
  provider: CustomProvider,
): Record<string, unknown> {
  const providers = isRecord(raw['providers']) ? raw['providers'] : {};
  return {
    $schema: SCHEMA_URL,
    ...raw,
    providers: { ...providers, [provider.id]: providerEntry(provider) },
  };
}

/** The document without provider `id`. */
export function withoutProvider(raw: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> {
  const providers = isRecord(raw['providers']) ? { ...raw['providers'] } : {};
  delete providers[id];
  return { ...raw, providers };
}

/** Read the file; a missing one is empty. */
export function readProvidersDocument(file: string): ProvidersDocument {
  return parseProvidersDocument(existsSync(file) ? readFileSync(file, 'utf8') : null);
}

/**
 * Write the document: a temporary file in the same directory, then a rename, so a running opencode that
 * re-reads on change never sees half a file. Directory 0700, file 0600, set with `chmod` as well so the
 * umask does not decide.
 */
export function writeProvidersDocument(file: string, raw: Readonly<Record<string, unknown>>): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A name of its own per writer: two writers sharing one `.tmp` would rename each other's half-file.
  const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A lock older than this is a writer that died inside the few milliseconds it holds one. */
export const LOCK_STALE_MS = 10_000;

/** Another writer holds the lock right now. Nothing was written; trying again is safe. */
export class ProvidersFileBusyError extends Error {
  constructor(file: string) {
    super(`${file} is being written by another lotse right now — try again`);
    this.name = 'ProvidersFileBusyError';
  }
}

/**
 * Read, change and write the file under a lock — the CLI and the settings group are two writers, and a
 * read before a slow network call and a write after it would drop the other one's change. So the read
 * happens here, **after** every network call, and `change` gets that fresh copy; it may throw to write
 * nothing.
 *
 * The lock is `<file>.lock`, created `O_EXCL` (`wx`). **Stale by age, not by pid**: the GUI may run in a
 * Flatpak and the CLI on the host, in two pid namespaces, so a pid from the other one would look dead and
 * a live lock would be broken. The lock covers no network call, only a read and a rename, so a lock older
 * than `LOCK_STALE_MS` can only be left behind by a writer that died — it is removed and taken once. A
 * fresh one is not waited for: `ProvidersFileBusyError`, which a person retries in a second.
 */
export function updateProvidersDocument(
  file: string,
  change: (raw: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
  now: () => number = Date.now,
): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age: number;
      try {
        age = now() - statSync(lock).mtimeMs;
      } catch {
        // Released between the two calls: nothing to remove, take it on the next round.
        age = LOCK_STALE_MS;
      }
      if (attempt > 0 || age < LOCK_STALE_MS) throw new ProvidersFileBusyError(file);
      rmSync(lock, { force: true });
    }
  }
  try {
    const document = readProvidersDocument(file);
    if (!document.ok)
      throw new Error(`${file} could not be read (${document.problem}) — fix or remove it first`);
    writeProvidersDocument(file, change(document.raw));
  } finally {
    rmSync(lock, { force: true });
  }
}
