# AGENTS.md — lotse

Operating guide for AI agents in the **lotse** repo. Follows the [agents.md](https://agents.md/)
convention; the human overview is [README.md](README.md). This repo is a submodule of
**werkstatt**, whose [AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file
is the lotse-specific layer and wins where they differ.

## What this is

An **ACP client**: a TypeScript app that starts coding agents as subprocesses over the [Agent
Client Protocol](https://agentclientprotocol.com) (JSON-RPC 2.0 over stdio, Apache-2.0), manages
their sessions, and binds them to a surface. Runs on **GJS via gjsify**, like curlew and
beifahrer.

No agent of its own, no model of its own, no policy engine of its own — ACP brings that in as the
standard protocol instead of lotse's own invention. `session/request_permission` is the policy
layer, `fs/read_text_file`/`fs/write_text_file` can be refused outright, and `session/new` with
`mcpServers` lets the agent reach lotse's own MCP servers without a line of suite-specific code.

Direction (profiles, tasks, triggers; messenger as an MCP contract): [docs/vision.md](docs/vision.md), ADR 0007 and 0008.

## Package layout — and the one rule that holds it together

| Package | Contains | May import |
|---|---|---|
| `@lotse/acp` | **Pure.** The ACP wire types against `refs/acp/schema.v1.json`, the JSON-RPC codec (`jsonrpc.ts`), the `Transport` seam (`transport.ts`), the client session lifecycle (`client.ts`), the gate that answers what an agent may ask of a client (`gate.ts`) | nothing |
| `@lotse/session` | The model (`SessionRecord`, transcript, resume binding, principal, scope) and a JSON file store | `@lotse/acp`, `node:fs` — no `gi://`, no agent adapter |
| `@lotse/core` | Everything decision-shaped that is not a surface: the agents (`agents/*`, with `data/bundled-agents.json`), the session controller (`agent-session.ts`), one turn (`run.ts`, `turn.ts`), the login (`auth.ts`, `login/*`), the failure classification (`failure.ts`) and the view-model files the widget will need | `@lotse/acp`, `@lotse/session`, `node:*` — no `gi://`, no yargs, no widget |
| `@lotse/widget` | **The chat surface, as a widget.** `LotseChat` (`chat.ts` + `chat.blp`) — one conversation: transcript (`transcript-view.ts`, `tool-line.ts`), composer (`composer.ts`, `config-row.ts`), the approval dialog (`permission-dialog.ts` + `permission-body.blp`), the failure and login dialogs, self-installed CSS | `@lotse/core`, `@lotse/session`, `gi://` (GTK 4, Adw 1) — no app, no decisions of its own |
| `lotse-cli` (`app/`) | yargs CLI, the terminal permission gate, the XDG path resolver, the settings and notices files, and the Adwaita shell in `src/frontends/gui/` (its own bundle) around one `LotseChat` | all of the above; `gi://` only under `frontends/gui/` |

**`packages/acp` does not know that subprocesses exist.** No `spawn`, no `node:child_process`, no
`gi://`, no dependencies at all — the transport is an injected interface (`Transport` in
`transport.ts`). That is curlew's `store`-knows-no-backend rule one layer up, and it is what lets
the same protocol code run as the Node unit test and the GJS integration test.

**There are two directories called core, and the difference is the whole point.** `packages/core/src` is
LGPL and holds what a *host* would need; `app/src/core` is AGPL and holds what is true of **this** app
only — the XDG resolver (`paths.ts`), the settings file (`settings.ts`, `settings-view.ts`), the notices
file (`notices.ts`), `session-groups.ts`, `private-file.ts`. Three of those are split on purpose: the
`LotsePaths` shape, `AgentChoice`/`describeChoice` and `NOTICE_IDS`/`noticeDue` are decisions and live in
the package, while reading and writing one app's file stays here. Before adding to `app/src/core`, ask
whether a host would want it; if yes it belongs one level down. [ADR
0001](docs/adr/0001-lotse-as-an-embeddable-widget.md) records what stayed and why.

**The app imports `@lotse/core`, never a file inside it** — and the same for `@lotse/widget`. Each
package's `src/index.ts` is a deliberate barrel, so what is public is a decision somebody made rather than
whatever a consumer reached for; a new export is one line there. The widget also exports `./tool-line` and
`./permission-dialog`, both **for measurements, not for hosts** (a Node-capable unit test, the focus probe).
The unit tests live in `app/tests/unit/` and import the barrels like any other consumer — one runner
(`app/tests/test.mts`) is what keeps the dual GJS + Node run working.

**`app/src/frontends/gui/` is the shell around one `LotseChat`.** Window, sidebar, menu, Preferences and
the `LOTSE_APP_*` hooks are this app's; the transcript, composer, dialogs and chat states are the widget's,
reached only through its getters and methods. The two idle pages are built in `window.blp` and handed in as
`closedPage`/`noAgentPage` — their copy belongs to whatever surrounds a chat. **No named imports from a
`.blp`, anywhere**: [docs/toolchain-traps.md](docs/toolchain-traps.md#named-imports-from-a-blp).

`@lotse/session`'s store takes a path and never decides one: the app resolves `$XDG_DATA_HOME` once into a
`LotsePaths` (`app/src/core/paths.ts`, passed to the commands and the window; `lotsePathsUnder(root)`
from `@lotse/core` for a host), a test passes a temp dir.


## Conventions

- `gjsify install` — never `npm install`, it prunes gjsify deps.
- All `@gjsify/*` packages pinned to the **same exact version** (0.64.11 here). gjsify ships as one
  release train; a CLI ↔ libs skew produces silently broken bundles. `@gjsify/napi` is absent on
  purpose: [docs/toolchain-traps.md](docs/toolchain-traps.md#why-gjsifynapi-is-not-pinned).
- `gjsify foreach -A check` (the `-A` includes `private: true` workspaces), `gjsify workspace
  <name> <script>` for one — **no `run` keyword**.
- **`./node_modules/.bin/gjsify`, not the `gjsify` on `PATH`**, whenever the toolchain version
  matters. The global install wins, and a run that looks linked is then a released CLI.
- `typescript` pinned `^6.0.3`, **not** 7: `gjsify tsc` runs a bundle with 6.0.3 baked in,
  regardless of what is installed locally.
- Conventional commits (`feat(acp): …`, `fix(session): …`), imperative, subject ≤ 50 chars.
- This repo is a submodule of werkstatt: commit here first, then bump the pointer in the parent.
  NEVER stage across that boundary in one commit.

### The project rule that came out of a mismeasurement

> **In a gjsify project you import `node:child_process` — not `@gjsify/child_process`.**

Not a gjsify bug: the package specifier bypasses the bundler's resolution. The two failures that
looked like two bugs: [docs/toolchain-traps.md](docs/toolchain-traps.md#nodechild_process-not-gjsifychild_process).

## The CLI

```bash
lotse start [prompt..] --agent opencode   # new session, one prompt turn
lotse sessions [--all] [--long]           # lotse's own records, one principal
lotse resume <id> [prompt..]              # reattach, then optionally one turn
lotse cancel <id>                         # session/cancel
lotse auth [--agent opencode]             # trap 1's way out
lotse login [provider] [--method id]       # login, no terminal (docs/login.md)
lotse agents                              # launchers, SOURCE, what lotse would use
lotse listen [--quiet]                  # receive only: chat requests, answers, question notices (ADR 0003)
lotse questions [--all] [--json]          # what the tasks' agents are waiting on
lotse answer <id> [text..] [--dialog]     # yes/no or a reply; no text opens the answer window
lotse run <id> [--param k=v] [--json]     # a task now; exit 0 done 1 failed 2 usage 3 needs a person
lotse tasks | status [--json]             # runnable tasks (docs/tasks.md) | running, last runs, open questions
```


**Read before touching the CLI** — full prose in [docs/cli-behaviour.md](docs/cli-behaviour.md):

- `listen` is [ADR 0003](docs/adr/0003-serve-tasks-questions-channel.md); read it before touching `packages/core/src/task/` and `questions/`. A new task field goes into `task/skill.ts` first. Pure logic in core, GI only in `app/src/core/desktop-channel.ts` (imported lazily so `answer` stays GI-free). Guide: [docs/listen.md](docs/listen.md).
- **Bundled before host, and the bundled copy is off PATH** (`/app/extra/agents`, never `/app/bin`: it would shadow the person's own opencode and its login). Precedence `--agent` / `LOTSE_APP_AGENT` > setting > bundled > host; a setting that cannot be honoured is reported, never skipped silently; a recorded `agentSource` is resumed on that copy or fails, never falls to the other. A bundled copy runs in the sandbox with its own `HOME`/`XDG_*`.
- **One turn, not a REPL** — a decision, not a missing feature. **stdout is the answer, stderr is everything about it.** Ctrl-C is `session/cancel`, not a kill. A piped stdin cannot ask, so it declines. Read every option with `pickArgv` (yargs exposes `--deny-all` under two spellings; a gate that silently stopped firing is the worst failure).

## Licence

Apps (`app/`, the repo root) are AGPL-3.0-or-later; the reusable packages under `packages/*` are
LGPL-3.0-or-later (own `LICENSE` + `COPYING`). A LGPL package never depends on an AGPL one; new
packages under `packages/*` follow the same split. No SPDX headers in sources.

## Privacy — this repo is PUBLIC

- The session file holds **the text of a person's conversations with an agent**. It lives at
  `$XDG_DATA_HOME/lotse/sessions.json`, mode `0600` in a `0700` directory, **never** inside the
  repository. `.gitignore` is the second line of defence; not writing there is the first, and it
  lives in `app/src/core/paths.ts`. Backup tier: `state` — declared in `.werkstatt-state.json`.
  **Through 0.1.1 that directory was `kurier`**, so both entry points resolve their paths through
  `migratedPaths()` (`app/src/core/migrate.ts`), which renames each old directory once if the new
  name is free, never merges two of them, and keeps using the old one — out loud — when the move
  fails. Every `LOTSE_*` knob also answers to its `KURIER_*` spelling (`envKnob`), new name wins,
  and a pinned path turns the move off.
- There is **no `secret` tier, and adding one needs a reason.** lotse stores no credential:
  `lotse auth` runs the agent's own login. The agent keeps its credentials and lotse never reads them
  back; a pasted API key (`lotse login`, login dialog) is held in memory for one call, never written. Do not
  put a token in a session record, in a launcher `env`, or in any file here — there is no file here
  with a safe place for it.
- Test fixtures are **synthetic only**. A real session id, a real prompt or a real model reply from
  a machine's history never goes into a test.
- The transcript is a *record of what happened*, not a re-derivation of it. The agent's own
  `session/load` is the authority on history; lotse's copy exists so `lotse sessions` can show
  something without spawning a process. Do not add filtering to it as "protection" — a filter with
  no gate behind it is a policy in the wrong place.

## The four guardrails

1. **A session is a scope, not a permission.** A stored or bound session may never be
   pre-authorized. It says what is *reachable*; every call inside it is checked again. A session
   with "may use Troedler" is a corridor, not a key — otherwise a group chat is a handed-around
   permission key. Derived from beifahrer [ADR 0006](../beifahrer/docs/adr/0006-recipes-are-data-run-as-ordinary-calls.md).
   `assertScopeIsNotAuthority` (`gate.ts`) is the runtime canary: it throws if a persisted record
   ever grows an `allow`/`permissions`/`grants`/`capabilities`/`policy` key, because a TypeScript
   type alone cannot stop a later `{ ...session, grants: [...] }` from type-checking.
2. **Fail closed on `request_permission`.** `denyAll` remains the default `PermissionGate`; the Adwaita
   surface passes its own, which asks a person and answers `cancelled` on every path where nobody chose
   — Escape, Stop, a closing window, an agent that died, a closed dialog. Never "auto-allow because the
   agent asked". **`allow_always`/`reject_always` are passed through**, not filtered: the **agent**
   remembers an "always" (ACP has no `allowed_always` — the answer is `selected` plus the agent's own
   option id, and it decides whether to ask again), while lotse stores no policy at all. What still
   holds is everything about *how* the choice is made: no allow option holds the focus in any frame, only
   `allow_once` is `SUGGESTED`, the terminal's `y` takes `allow_once` when both allows are offered *and
   says so on the prompt line*, and there is **no timeout** — a diff takes longer than any deadline
   lotse could pick. **`lotse listen` amends this** ([ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md), built per [ADR 0003](docs/adr/0003-serve-tasks-questions-channel.md), `serve/gate.ts`):
   its gate answers `allow_once` only for a question the person answered yes or an area the person
   released in the task configuration, and that policy only narrows what the owning app allows. It
   strips every `*_always` option and never selects one; a yes mints one single-use token bound to
   session, tool and a digest of the call arguments; a question expires to `cancelled`. Guardrail 1
   stands: a session record never holds a grant.
3. **`fs/read_text_file` and `fs/write_text_file` are answered `false`** in the capability
   announcement, and answered a refusal error if an agent asks anyway. The agent gets no file
   access through that channel at all. File access is a decision, not a default — these two may be
   enabled later for a **canvas surface**, where lotse would hold the real buffer and hand it over
   deliberately rather than proxying a path the agent named.
4. **`_meta` is passed through, never parsed.** `opencode acp` sends
   `_meta: {"opencode/child-session-updates": true}` and a `sessionCapabilities.fork` marker the v1
   schema does not define. Unknown `_meta` must never be an error — otherwise every agent with an
   extension lotse doesn't know breaks.

Plus two more that are in the code, not just the plan: **no central capability registry** (not
even in gjsify — it would be exactly the gate beifahrer forbids, one level up and worse because it
looks neutral; manifest and policy stay in the app that holds the gate), and **MCP is passed
through, not known** (`newSession` forwards `mcpServers` to `session/new` as opaque objects and
never reads past `type`, so the project stays standalone-publishable and gets suite integration for
free).

## The two traps

**Trap 1 — `authMethods` is real and interactive.** Measured against `opencode acp` 2.0.19 (the
`authMethods` entry is in the handshake below): no `type` tag, and a `description` the schema does not
define. Without `lotse auth` the first
session dies on an error message instead of on code. `classifyAuthMethods` (`gate.ts`) reads this
as the protocol's *agent* auth method: it means the client has to arrange the login itself, which
is what `lotse auth` runs outside the ACP channel.

**What to do about it is decided once, in `@lotse/core`'s `auth.ts`** — `authPlan` (which of the two
paths the methods allow), `describeAuthMethods` (the handshake notice), `loginCommandFor` (the program,
the bundled copy's own) and `arrangeAuth` (ask the agent, run the login, **ask it again** — the second
handshake is the agent's own yes rather than an exit code read as one). A surface passes in only what
genuinely differs: `runLogin`, which the CLI runs with inherited stdio because a login that opens a
browser cannot open one from a pipe, and `open` for a test. It lived in `frontends/cli/auth.ts` once,
which is why the window had no way to log anyone in.

**Trap 2 — capability negotiation is uneven.** `loadSession`, `sessionCapabilities.{list,resume,
close,delete,fork}` — not every agent can do everything. **Check the capability, do not assume
it.** `AcpClient.reattach` tries `session/load` first (the default), falls back to `session/resume`,
and rejects with `UnsupportedCapabilityError` rather than a silent empty session if the agent
offers neither. Asking for a capability the agent never advertised is a hard error, always.

**What a real agent answers** — the verbatim `initialize` result of `opencode acp` 2.0.19, measured
inside one GJS process with no Node in the chain — is in
[refs/acp/SOURCE.md](refs/acp/SOURCE.md#what-one-real-agent-answers), beside the schema.

## Run / build / test

```bash
gjsify install                                  # never npm install
gjsify foreach -A check                          # type-check everything
node scripts/check-schema.mjs                    # the code against refs/acp/schema.v1.json
gjsify workspace lotse-cli build                # → app/dist/lotse.gjs.mjs
gjsify workspace lotse-cli test                 # @gjsify/unit, on gjs AND node
gjsify workspace lotse-cli test:real-agent      # the real stdio chain against a real agent
gjsify run app/dist/lotse.gjs.mjs <command>
gjsify workspace lotse-cli build:app            # → app/dist/lotse-app.gjs.mjs (GTK, separate bundle)
```

**GTK behaviour setup:** [docs/dev-fixtures.md](docs/dev-fixtures.md#gtk-behaviour-moved-from-agentsmd) — GUI is looked at, not believed: start detached, dev tools, synthetic sessions.

**Hooks, stand-in agent, failure dialogs, permission dialog:** [docs/surface-rules.md](docs/surface-rules.md) (rules and incidents), [docs/dev-fixtures.md](docs/dev-fixtures.md) (knobs, probes). The rules that change behaviour on every task:

- **A hook set to `0` or `false` is off**, in lotse and the stand-in alike; the reading rules live in `frontends/gui/hook-value.ts`, not `hooks.ts` (the barrel imports `Adw`, so a Node test could not import it).
- **Every pointer-only hook goes through the surface** (the composer's own `clicked`, the dialog's own `close()`/`response`, `#open`), never around it.
- **Failures are classified by type and turn state, never by wording** (`failureKind`, `failure.ts`); only `auth`, `model` and `unsupported` earn a dialog. `'auth'` vs `'model'` is `FailureContext.promptSent`, required so a call site cannot omit it.
- **Free models are detected by rule (`isFreeModel`), never listed by hand, never auto-selected or hidden**; every one in use earns `FREE_MODEL_WARNING`.
- **The permission dialog: both end button slots are a decline**, `buildDialog` names `default_response` explicitly, no allow option holds the focus, and decisions live in `packages/core/src/permission.ts`.
- Phone floor is 360 px (`WINDOW_MIN_WIDTH_PX`).
- **GJS is mandatory, not optional**: a pure Node test would be green and would not answer the real question. Node runs the injected `Transport` + `FixtureAgent`; GJS runs `test:real-agent`. If a change makes the Node run impossible, the change is in the wrong file ([why](docs/surface-rules.md#why-the-test-run-is-dual)).

**Freshness: a green run can be the wrong bundle.** Before gjsify 0.53.0 a green `gjsify test` tested
the last build, not the source; 0.53.0 fixed it with `<outfile>.inputs.json`, and the measurement is
worth repeating whenever the toolchain moves — treat a suspiciously fast green as this, not as a win.
**Run a fix's new test against the unfixed code first**: a test that cannot fail without its fix is
decoration. And **the `gjsify` on `PATH` decides**: a global install wins over
`node_modules/.bin/gjsify`. The incidents: [docs/toolchain-traps.md](docs/toolchain-traps.md).

`refs/acp/schema.v1.json` is the normative artifact `packages/acp`'s types are written against,
refreshed by `./scripts/update-acp-schema`. `scripts/check-schema.mjs` fails the build when the
code and the schema disagree about a method name or a required field — read the diff before
committing a refresh; a refresh that only changes the JSON is a sign the schema was copied but not
read (see [refs/acp/SOURCE.md](refs/acp/SOURCE.md)).

## Packaging

**The `gjsify.flatpak` block in `package.json` is the source of truth**: desktop entry, metainfo,
manifest and `flathub.json` are generated from it, so a hand edit of `data/*` is lost.
`npm run packaging:validate` is THE gate (`--show-manifest` only prints). Three finish-args are not
free (`--talk-name=org.freedesktop.Flatpak` + `--filesystem=host` make the sandbox close to
decorative; `--share=network` is for the bundled agent), and `packages/core/src/agents/sandbox.ts`
rests on four measured facts — read [data/README.md](data/README.md) before changing either.

## What is deliberately not here yet

A web surface (**not** adwaita-web, which is the browser path per beifahrer ADR 0008) · Telegram bot (becomes a Curlew
backend) · the XMPP channel for `lotse listen` (the `Channel` seam is there, curlew is not wired) · MCP
wiring against the real apps and the principal policy beyond one task's rights (decided in
[ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md), not built) · troedler integration ·
a Claude Code adapter (decided, not built; terms and billing: [docs/claude-code.md](docs/claude-code.md)).
