# @lotse/core

Lotse without a surface: which agent to start and how, the session a prompt turn runs in, the view
models a chat is drawn from, and the provider login. No `gi://`, no widget, no CLI parser — so it runs
on GJS and on Node, and a host decides everything that needs deciding.

Licence: **LGPL-3.0-or-later** (`LICENSE`, `COPYING` in this directory). Lotse's apps are AGPL; this
package is the part a stranger may link into their own application.

If you want the finished GTK4 / libadwaita chat, use [`@lotse/widget`](../widget/README.md) and read
the [host guide](../../docs/embedding.md). Use `@lotse/core` directly to drive an agent without that
widget, or to build your own surface on the same logic.

## Install and import

```bash
npm i @lotse/core @lotse/acp @lotse/session
```

```ts
import { lotsePathsUnder, AgentSession } from '@lotse/core';
```

There is **one entry point**: `.` (`src/index.ts`). Nothing else is importable, so everything below is
the whole public surface. The package ships TypeScript sources and `data/` (the bundled-agent catalog,
the login policy, the free-model list), which the bundler inlines.

## Minimal example

Resolve an agent, start it, run one prompt turn (`denyAll` refuses every permission request). Needs
`@lotse/acp` as well; the file is type-checked in `app/tests/examples/core-turn.ts`.

```ts
import { denyAll } from '@lotse/acp';
import { gatherResolveContext, lotsePathsUnder, openAgent, resolveDefault, runTurn } from '@lotse/core';

const paths = lotsePathsUnder('/path/to/my-app-data');
const agent = resolveDefault(gatherResolveContext(paths));
if (!agent) throw new Error('no agent found');

const handle = await openAgent({ command: agent.command, gate: { permission: denyAll } });
try {
  const { sessionId } = await handle.client.newSession({ cwd: process.cwd(), mcpServers: [] });
  await runTurn(handle.client, {
    sessionId,
    text: 'Say hello.',
    onUpdate: (notification) => console.log(notification.update.sessionUpdate),
  });
} finally {
  await handle.close();
}
```

For a conversation with state — persistence, reattach, permission questions, config options — use
`AgentSession` (below) rather than the two functions above.

## Public surface

### Where lotse writes

| Export | What it is |
|---|---|
| `LotsePaths` | Every place lotse writes, as one value: `dataDir`, `configDir`, `sessionsFile`, `settingsFile`, `noticesFile`. Core never resolves a directory itself. |
| `lotsePathsUnder(root)` | The layout for a host: `<root>/data/{sessions,notices}.json`, `<root>/config/settings.json`. |

A bundled agent's `HOME` and `XDG_*` directories follow `dataDir` (see `isolationDirs` below), so moving
`dataDir` moves the agent's whole private state with it.

`lotsePaths()` — the XDG and `LOTSE_*` resolver — is **not** exported: which directory a command-line
tool writes to is that tool's decision, and it lives in the app (`app/src/core/paths.ts`). A host builds
its own `LotsePaths`, normally with `lotsePathsUnder`.

### Which agent

| Export | What it is |
|---|---|
| `LAUNCHERS`, `DEFAULT_AGENT`, `findLauncher`, `requireLauncher`, `launcherIds` | The agent commands lotse can start from `PATH` (opencode today). |
| `AgentCommand` | How one agent process is started: `id`, `title`, `program`, `args`, optional `cwd`, `env`, `bundled`. |
| `gatherResolveContext(paths, readVersions?, probeHost?)` / `gatherResolveContextAsync(paths)` | Probe this machine once: which agents exist on `PATH`, which bundled copies exist. The async form never blocks, for a sandboxed app. |
| `resolveDefault(context, setting?)` / `resolveDefaultWithNote` | The agent to start when nobody chose: the setting, else the person's own install, else the bundled copy. `null` means none; the `…WithNote` form also says why a setting was not honoured. |
| `resolveRecorded(id, source, context)` | The agent a stored session names, on the copy that held its history. Returns `{ agent }` or `{ problem }`; never swaps one agent for another. |
| `ResolvedAgent` | `{ command, source: 'host' \| 'bundled', version, isolation }`. |
| `detectAgents`, `parseVersionOutput`, `resolveAgent`, `gatherAgentFacts[Async]`, `gatherCwdFacts` | The pure and impure halves of detection, for a custom resolver. |
| `BUNDLED_AGENTS`, `BUNDLED_CATALOG`, `bundledProgram`, `bundledCommand`, `parseBundledCatalog` | The agents shipped inside a build (`data/bundled-agents.json`) and the command for one. |
| `isolationDirs(dataDir, id)`, `isolationEnv`, `prepareIsolation` | Where a bundled agent keeps `HOME`, config, data, state and cache: `<dataDir>/agents/<id>/…`, mode `0700`. The person's own `~/.config`, `~/.claude` and login are never read by a bundled copy. |
| `AgentChoice`, `describeChoice` | A saved preference ("this agent, this copy"). The settings file itself is the host's. |
| `isSandboxed`, `currentSandboxFacts`, `toHostCommand`, `hostProbeArgv`, … | Flatpak handling: probing and running the person's own agent from inside a sandbox. |
| `which`, `whichAsync`, `stdioTransport`, `StdioChannel`, `resolveSpawnCommand` | Process plumbing under the transport. |
| `resolveCwd`, `displayCwd`, `gatherCwdFacts`, `CwdFacts` | Where a new chat runs, and how a path is shown (`~/…`). |
| `chooseAgent`, `standInCommand`, `STAND_IN_*` | A **development** stand-in agent that needs no model; see [dev-fixtures](../../docs/dev-fixtures.md). Not for production. |

### One conversation

| Export | What it is |
|---|---|
| `AgentSession` | The turn machinery for one conversation and one agent subprocess: `bind`, `startConversation`, `prompt`, `stop`, `restartAgent`, `setConfigOption`, `dismissPermission`, `shutdown`, `snapshot`. The widget is a thin view over it. |
| `AgentSessionOptions` | `command` and `events` (required); `append`, `create`, `source`, `resolveAgent`, `now`, `closeGraceMs`, `open`, `mcpServers`. |
| `AgentSessionEvents` | The callbacks a surface supplies: snapshots, arriving transcript entries, the permission question, config view, notices, the spawn-time closer, a new conversation. |
| `McpServer` | The ACP MCP server shape (stdio, `http` or `sse`). |
| `openAgent`, `runTurn`, `AgentHandle`, `withAuthHint` | Start an agent and handshake; run one prompt turn with the update stream wired. |
| `installInterruptHandler`, `decideInterrupt` | Ctrl-C for a command-line process: cancel first, then terminate. |
| `conversationRecord`, `titleFromPrompt`, `unsavedMessage` | Build the `SessionRecord` for a new conversation. |

`AgentSessionOptions.mcpServers` takes `readonly McpServer[]`. Lotse forwards them **unchanged** in
`session/new` and in the reattach of a stored session, and never reads past `type`. Absent means `[]`
in `session/new` and nothing added to a reattach. Lotse never edits the agent's own global config for
this.

```ts
const mcpServers: McpServer[] = [
  { name: 'my-tools', command: '/usr/bin/my-mcp-server', args: [], env: [] }, // stdio
  { type: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [] },
];
```

### Permission questions

An agent asks `session/request_permission`; the answer is always a person's or a denial.

| Export | What it is |
|---|---|
| `PermissionDesk`, `PermissionQuestion` | One open question, a queue behind it, no memory. Stop, a closing window and a dying agent settle every waiting question as cancelled. |
| `permissionView`, `PermissionView`, `usableOptions`, `orderOptions`, `optionLabel`, `decideFromView`, `answerFor` | What the dialog shows and how a button press becomes a decision. Only the four standard option kinds are shown; the wording is lotse's, never the agent's. |
| `PermissionDecision`, `NotAnsweredReason` | The outcome, including why nothing was answered (`dismissed`, `turn-cancelled`, …). |
| `terminalGate`, `Terminal` | A command-line gate that asks on a terminal. |
| `ClientGate` (from `@lotse/acp`) | `{ permission }`. Fail-closed by default (`denyAll`). |

### Headless jobs

One awaited call, no widget and no `gi://`: input in, a typed value out
([ADR 0004](../../docs/adr/0004-headless-job-api.md)). Nothing is persisted and nobody is asked.

| Export | What it is |
|---|---|
| `runJob<T>(options): Promise<JobResult<T>>` | A fresh agent process, one session, one turn, closed on every path. The final message is the whole trimmed message as JSON, or its **last** ` ```json ` block, and becomes a value only once your `parse` accepts it. |
| `JobOptions<T>` | `command`, `cwd`, `prompt`, `parse`, **`modelPolicy` (required)**; optional `model`, `schema`, `mcpServers` (default `[]`), `gate` (default `denyAll`; only `allow_once` passes), `signal`, `timeoutMs`, `onLog`. |
| `JobResult<T>` | `value`, `sessionId`, `model`, `stopReason`. |
| `JobError`, `JobErrorKind` | Every rejection: `malformed`, `invalid`, `denied`, `unknown-model`, `auth`, `refused`, `timeout`, `cancelled`, `agent`. `message` is a fixed sentence; the raw answer is on `output`, never logged. No retries. |
| `JobLogEntry` | What `onLog` gets: lotse's own events with ids and kinds only, and the agent's stderr lines. |
| `JOB_TIMEOUT_MS`, `jobPrompt(prompt, schema?)` | The default time limit (120 s over the whole job), and the prompt as sent when you pass a JSON Schema. |

A stop (timeout or `signal`) sends `session/cancel`, waits a short grace period, then closes the agent.
Usage: [docs/embedding.md](../../docs/embedding.md#headless-jobs-no-widget).

### Login and auth

Two different things: **auth** is the login the agent's `authMethods` ask for; the **login** is
lotse's own OAuth / API-key dialog, driven over opencode's HTTP API. Nothing here stores a credential;
the agent keeps its own.

| Export | What it is |
|---|---|
| `authPlan(methods)` | What an agent's `authMethods` mean for a client: `none`, `agent-runs-it`, `client-arranges-it`, `unusable`. |
| `arrangeAuth(hooks)` | Ask the agent, run its login command through your `runLogin`, ask again. Returns an `AuthArrangement` (`authenticated`, `login-missing`, `login-failed`, `refused`, …). `AuthHooks.runLogin` is the one part a surface supplies. |
| `loginCommandFor(agent)`, `describeAuthMethods`, `AUTH_COMMAND` | The command to run for an agent (a bundled copy gets its own isolated one). |
| `loginUnavailableReason(agent)` | Why no in-app login can run (not opencode, not on `PATH`, …), or `null`. |
| `LoginController`, `LoginControllerDeps`, `LoginState` | The state machine behind a login dialog: providers, browser flow, code paste, API key, connected. `subscribe(listener)` for state; `open()` to start. You supply `openSession`, `unavailableReason`, `sleep`, `now`, optional `onConnected` and `offers` (which providers to list, e.g. by `providerOffered`). |
| `openLoginSession(agent)`, `startServer`, `serverCommand`, `createLoginApi`, `runLogin` | The private `opencode serve` on `127.0.0.1` with a per-start password, and the calls on it. Stopped when the login ends. |
| `LOGIN_POLICY`, `parseIntegrations`, `KEY_METHOD_ID` | The shipped provider policy (`data/login-providers.json`) and the catalog parser. |

Details and measurements: [docs/login.md](../../docs/login.md).

### Onboarding

| Export | What it is |
|---|---|
| `probeConnections(agent, { signal?, timeoutMs? })` | Ask a private login server which providers are connected, then close it. Any failure, timeout or abort is `{ kind: 'unknown' }`. |
| `ConnectionFacts` | `unknown`, `connected`, or `none` with counts of providers offering a browser login and an API key. |
| `onboardingView(input)` | The "Connect a provider" page as data, or `null` when the ordinary chat is right. Shown only with the option on, an agent found, a login that can run, **no** connection reported and no earlier "free models" choice. |
| `connectionFacts(providers, custom?)` | `ConnectionFacts` from a parsed catalog; a keyless custom provider on loopback or the LAN counts as connected. |

### Custom providers

| Export | What it is |
|---|---|
| `planCustomProvider(input)`, `parseModelSpecs` | Check an id, URL and models against the catalog: `ok` (with the entry, the privacy note and context warnings), `confirm` (plain http on the LAN) or `refused`. |
| `checkEndpoint`, `hostReach`, `CUSTOM_PRESETS`, `contextWarning`, `MIN_CONTEXT_TOKENS`, `LOCAL_MODEL_HINT` | The URL rules (https or loopback; LAN asks; the rest is refused), the `local-*` presets and the honest hints. |
| `customProvidersFile`, `customProvidersEnv`, `readProvidersDocument`, `writeProvidersDocument`, `withProvider`, `withoutProvider`, `providerEntry` | lotse's own `lotse-providers.json` for the bundled opencode (via `OPENCODE_CONFIG`), written `0600`, never with a key. |
| `createProviderApi`, `probeModels`, `parseModelList`, `ProviderApi` | On the private server: the configured providers, the ids that may not be shadowed, the usable models per provider, `disconnect`, `waitForProvider`. |
| `ProviderSettingsController`, `ProviderSettingsView`, `AddOutcome` | The state behind a provider settings page: connected rows, custom rows, privacy notes; `disconnect`, `addCustom` (`added`, `confirm`, `refused`), `removeCustom`, `reload`. The widget's page renders it. |
| `openSettingsSession(agent)`, `customProvidersFileOf(agent)` | The private server for that controller, and lotse's own file for an agent: `null` for a host opencode, whose custom providers are then read-only (`NOT_LOTSE_COPY_REASON`). |
| `reachPrivacyNote(reach)`, `PROVIDER_PRIVACY_NOTE`, `FREE_MODELS_PRIVACY_NOTE`, `FREE_MODELS_DENIED_NOTE` | The privacy sentences the page shows, per endpoint and for the page. |

Details and measurements: [docs/custom-providers.md](../../docs/custom-providers.md).

### Free hosted models

| Export | What it is |
|---|---|
| `FREE_MODELS`, `FREE_MODEL_IDS`, `FreeModelList` | A maintained list of model ids that are free **and** documented as zero-retention, with the date checked and the source. |
| `freeModelFirst(values)` | Sort those ids to the top of a model dropdown. Never selects, never hides, never guesses: an id lotse has not heard of is simply not matched. |

Free hosted models are time-limited and what you send goes to the provider that hosts them. Lotse
labels them that way on the onboarding page; treat the same rule as yours (see
[Privacy](../../docs/embedding.md#privacy-free-hosted-models-never-get-private-data)).

### View models

Pure functions from state to "what to draw", tested on Node and GJS. Use them to build your own surface.

- Transcript: `toTranscript`, `toTranscriptItems` and the `…Item` types, `describeUsage`, `formatCost`.
- Composer: `composerView`, `keepsDraft`, `offersStop`.
- Agent options (model, effort, mode): `projectConfigOptions`, `findControl`, `configValue`, and the row
  model `configRowInput`, `configSelection`, `applyConfigUpdate`, `modelControl`.
- Turn and status: `transition`, `agentStatus`, `leavesRunningTurn`, `AgentStatus`, `TurnEvent`.
- Failures: `failureKind`, `failureNotice`, `failureAction`, `failureToShow`, `isQuotaExhausted`,
  `AuthRequiredError`.
- Scrolling: `followTarget`, `resolveFollow`, `isAtBottom`, …
- Empty states and notices: `emptyStateView`, `noticeView`, `noticeDue`, `NOTICE_IDS`, `NO_AGENT_MESSAGE`.

## Related

[`@lotse/widget`](../widget/README.md) · [host guide](../../docs/embedding.md) ·
[ADR 0001](../../docs/adr/0001-lotse-as-an-embeddable-widget.md) · [login](../../docs/login.md)
