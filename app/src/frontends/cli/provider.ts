/**
 * `lotse provider` — custom providers (a local Ollama, LM Studio, llama.cpp, vLLM, any OpenAI-compatible
 * endpoint) for the bundled opencode.
 *
 * ```
 * lotse provider list
 * lotse provider add --preset local-ollama --model qwen3:4b=8192
 * lotse provider add gpu-box --url http://192.168.1.20:8000/v1 --allow-lan
 * echo "$KEY" | lotse provider add my-api --url https://llm.example/v1 --key
 * lotse provider remove local-ollama
 * ```
 *
 * One action positional rather than three yargs subcommands: a nested `demandCommand` fails on GJS in a
 * way that hides the hint (`index.ts`). The decisions are `@lotse/core`'s (`custom/*`): where a URL may
 * point, which id may be used, what is written. This file gathers the facts over a private `opencode
 * serve`, asks, and writes. **Only the bundled copy is written to** — the person's own opencode config is
 * theirs; `list` reads either. A key is read from stdin like `lotse login`'s, handed to opencode through
 * `connect/key`, and never written or printed.
 */

import type { CommandModule } from 'yargs';

import {
  CUSTOM_PRESETS,
  LOCAL_MODEL_HINT,
  checkEndpoint,
  createLoginApi,
  createProviderApi,
  currentSandboxFacts,
  customProvidersFile,
  documentProviderIds,
  parseModelSpecs,
  planCustomProvider,
  probeModels,
  readProvidersDocument,
  serverCommand,
  startServer,
  which,
  whyNoLoginServer,
  withProvider,
  withoutProvider,
  writeProvidersDocument,
  type ConfiguredProvider,
  type LotsePaths,
  type OpencodeServer,
} from '@lotse/core';

import { agentForNew } from './choose.ts';
import { readSecret } from './login.ts';
import { err, out, pickArgv } from './output.ts';

const ACTIONS = ['list', 'add', 'remove'] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): void {
  err(message);
  process.exitCode = 1;
}

function describe(provider: ConfiguredProvider): string {
  const where = provider.ours ? 'lotse' : provider.source || 'opencode config';
  const key = provider.connected ? 'key stored' : provider.reach === 'remote' ? 'no key' : 'no key needed';
  return `${provider.id} — ${provider.name}  ${provider.baseUrl ?? '(no URL)'}  [${where}; ${key}]`;
}

const command = (paths: LotsePaths): CommandModule => ({
  command: 'provider <action> [id]',
  describe: 'custom providers (local models, any OpenAI-compatible endpoint) for the bundled opencode',
  builder: (yargs) =>
    yargs
      .positional('action', { type: 'string', choices: ACTIONS, describe: 'list, add or remove' })
      .positional('id', { type: 'string', describe: 'the provider id (add: defaults to the preset’s)' })
      .option('preset', {
        type: 'string',
        choices: CUSTOM_PRESETS.map((preset) => preset.id),
        describe: 'a local server: its URL, name and id',
      })
      .option('url', { type: 'string', describe: 'the base URL, e.g. http://127.0.0.1:11434/v1' })
      .option('name', { type: 'string', describe: 'the name shown in the model list' })
      .option('model', {
        type: 'string',
        array: true,
        describe: 'a model id, optionally with its context: qwen3:4b=8192 (default: what the server lists)',
      })
      .option('key', { type: 'boolean', describe: 'read an API key from stdin; opencode keeps it' })
      .option('allow-lan', { type: 'boolean', describe: 'yes to plain http on the local network' })
      .option('agent', { type: 'string', describe: 'which agent (default: the resolved one)' })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const action = pickArgv<string>(raw, 'action');
    const resolved = agentForNew(paths, pickArgv<string>(raw, 'agent'));
    if (!resolved) return;
    const agent = resolved.command;
    if (agent.id !== 'opencode') return fail(`${agent.title} has no custom providers lotse can manage`);
    const reason = whyNoLoginServer(agent, currentSandboxFacts());
    if (reason) return fail(reason.replace('its login server', 'its config'));
    if (!which(agent.program)) return fail(`${agent.program} is not on PATH — install it, then try again`);
    // Only the bundled copy has a config directory that is lotse's to write.
    const file = resolved.isolation ? customProvidersFile(resolved.isolation) : null;
    if (action !== 'list' && !file) {
      return fail(
        'custom providers are written only for the bundled opencode — your own opencode keeps them in its ' +
          'own config (~/.config/opencode), which lotse does not edit. `lotse agents --use opencode:bundled` switches.',
      );
    }

    let key: string | null = null;
    if (action === 'add' && pickArgv<boolean>(raw, 'key')) {
      key = await readSecret('API key: ');
      if (!key)
        return fail(
          'no key given — pipe it in (`… | lotse provider add … --key`) or run this in a terminal.',
        );
    }

    const server = await startServer(agent).catch((error: unknown) => {
      fail(`could not start ${serverCommand(agent).title}'s server: ${messageOf(error)}`);
      return null;
    });
    if (!server) return;
    try {
      if (action === 'list') await list(server, file);
      else if (action === 'add') await add(server, file!, raw, key);
      else await remove(server, file!, pickArgv<string>(raw, 'id'));
    } catch (error) {
      const message = messageOf(error);
      fail(key ? message.split(key).join('[key]') : message);
    } finally {
      await server.close();
      // Same as `lotse login`: on GJS a child `startServer` launched keeps the main loop alive.
      setTimeout(() => process.exit(process.exitCode ?? 0), 50);
    }
  },
});

async function list(server: OpencodeServer, file: string | null): Promise<void> {
  const providers = await createProviderApi(server.send).configured(file ?? '');
  if (providers.length === 0) {
    err('no custom providers. `lotse provider add --preset local-ollama` adds a local Ollama.');
    return;
  }
  for (const provider of providers) {
    out(describe(provider));
    for (const model of provider.models) out(`    ${model}`);
  }
}

async function add(
  server: OpencodeServer,
  file: string,
  raw: Record<string, unknown>,
  key: string | null,
): Promise<void> {
  const given = pickArgv<unknown>(raw, 'model');
  const models = parseModelSpecs(
    (Array.isArray(given) ? given : given === undefined ? [] : [given]).map(String),
  );
  if (typeof models === 'string') return fail(models);
  const document = readProvidersDocument(file);
  if (!document.ok) return fail(`${file} could not be read (${document.problem}) — fix or remove it first`);

  const api = createProviderApi(server.send);
  const preset = pickArgv<string>(raw, 'preset');
  const url = pickArgv<string>(raw, 'url') ?? CUSTOM_PRESETS.find((p) => p.id === preset)?.baseUrl;
  if (models.length === 0 && url) {
    const endpoint = checkEndpoint(url);
    if (endpoint.ok) {
      try {
        const listed = await probeModels(endpoint.baseUrl, fetch, key ?? undefined);
        models.push(...listed.map((id) => ({ id })));
        err(`  ${endpoint.baseUrl}/models lists ${listed.length} model${listed.length === 1 ? '' : 's'}`);
      } catch (error) {
        const message = messageOf(error);
        err(
          `  could not list the models (${key ? message.split(key).join('[key]') : message}) — name them with --model`,
        );
      }
    }
  }

  const plan = planCustomProvider(
    {
      ...(pickArgv<string>(raw, 'id') ? { id: pickArgv<string>(raw, 'id')! } : {}),
      ...(preset ? { preset } : {}),
      ...(pickArgv<string>(raw, 'name') ? { name: pickArgv<string>(raw, 'name')! } : {}),
      ...(url ? { baseUrl: url } : {}),
      models,
      confirmedLan: pickArgv<boolean>(raw, 'allow-lan', 'allowLan') === true,
    },
    { knownIds: await api.knownIds(), ownIds: new Set(documentProviderIds(document.raw)) },
  );
  if (plan.kind === 'refused') return fail(plan.reason);
  if (plan.kind === 'confirm') {
    if (plan.privacyNote) err(`  ${plan.privacyNote}`);
    return fail(`${plan.question} Add --allow-lan to say yes.`);
  }
  if (plan.privacyNote) err(`  ${plan.privacyNote}`);
  for (const note of plan.notes) err(`  ${note}`);
  if (plan.reach !== 'remote') err(`  ${LOCAL_MODEL_HINT}`);

  writeProvidersDocument(file, withProvider(document.raw, plan.provider));
  const { id } = plan.provider;
  if (key) {
    const seen = await api.waitForProvider(id, {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    if (!seen)
      return fail(`${id} was written, but opencode did not list it in time — the key was not stored`);
    await createLoginApi(server.send).connectKey(id, key, {});
  }
  out(`${plan.replaces ? 'updated' : 'added'} ${id} (${plan.provider.models.map((m) => m.id).join(', ')}).`);
  err('  a chat that is already open shows it after a restart of the agent.');
}

async function remove(server: OpencodeServer, file: string, id: string | undefined): Promise<void> {
  if (!id) return fail('which provider? `lotse provider list` names them');
  const document = readProvidersDocument(file);
  if (!document.ok) return fail(`${file} could not be read (${document.problem}) — fix or remove it first`);
  const api = createProviderApi(server.send);
  if (!documentProviderIds(document.raw).includes(id)) {
    const elsewhere = (await api.configured(file)).find((provider) => provider.id === id);
    return fail(
      elsewhere
        ? `${id} is in ${elsewhere.source}, which lotse does not edit — remove it there`
        : `there is no custom provider "${id}"`,
    );
  }
  // The key first: once the entry is gone opencode no longer lists the provider, and its credential
  // would be left behind with no way to reach it from here.
  const keys = await api.disconnect(id);
  writeProvidersDocument(file, withoutProvider(document.raw, id));
  out(`removed ${id}${keys > 0 ? ' and its stored key' : ''}.`);
}

export const providerCommand = command;
