# AGENTS.md — lotse

AI-agent guide for the **lotse** repo. Follows the [agents.md](https://agents.md/) convention;
the human overview is [README.md](README.md). This repo is a submodule of **werkstatt**, whose
[AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file is the lotse-specific
layer.

## What this is

An **ACP client** for coding agents as subprocesses over the [Agent Client Protocol](https://agentclientprotocol.com), bound to a surface on **GJS via gjsify**.
Direction: [docs/vision.md](docs/vision.md).

## Package layout — and the one rule that holds it together

`@lotse/acp` is pure and knows no subprocesses; `@lotse/session` has no `gi://`; `@lotse/core` has
no `gi://`, yargs or widget; `@lotse/widget` is the chat surface and has no app logic; `lotse-cli`
(`app/`) is the shell around them. Import packages by their barrel `src/index.ts`, never by file.
Details: [docs/architecture/package-layout.md](docs/architecture/package-layout.md).

**There are two `core` directories on purpose.** `packages/core/src` (LGPL) holds what any host
would need; `app/src/core` (AGPL) holds what is true of **this** app only. Before adding to
`app/src/core`, ask whether a host would want it; if yes it belongs one level down. [ADR
0001](docs/adr/0001-lotse-as-an-embeddable-widget.md).

**No named imports from a `.blp`, anywhere.** See [docs/toolchain-traps.md](docs/toolchain-traps.md#named-imports-from-a-blp).

## Conventions

Hard toolchain and commit rules: [docs/conventions.md](docs/conventions.md).

## The CLI

```bash
lotse start [prompt..] [--agent opencode]   # new session, one prompt turn
lotse sessions [--all] [--long]             # lotse's own records
lotse resume <id> [prompt..]                # reattach, then one turn
lotse cancel <id>                           # session/cancel
lotse auth [--agent opencode]               # interactive-login escape hatch
lotse login [provider] [--method id]        # login, no terminal
lotse agents                                # launchers and source
lotse listen [--quiet]                      # receive requests, answers, notices
lotse questions [--all] [--json]            # what agents are waiting on
lotse answer <id> [text..] [--dialog]       # yes/no or reply
lotse run <id> [--param k=v] [--json]       # run a task now
lotse tasks | status [--json]               # tasks / running, last runs, questions
```

Full behaviour, bundled-agent precedence and one-turn semantics:
[docs/cli-behaviour.md](docs/cli-behaviour.md).

## Licence

Apps (`app/`, repo root) are AGPL-3.0-or-later; packages under `packages/*` are
LGPL-3.0-or-later. A LGPL package never depends on an AGPL one. No SPDX headers.

## Privacy — this repo is PUBLIC

Full text: [docs/guardrails.md](docs/guardrails.md).

- Session text lives at `$XDG_DATA_HOME/lotse/sessions.json`, mode `0600` in a `0700` directory,
  **never** in the repository. Through 0.1.1 the directory was `kurier`; `migratedPaths()` renames
  each old directory once if free, loudly on failure. Every
  `LOTSE_*` knob also answers to `KURIER_*` (`envKnob`).
- There is **no `secret` tier**. lotse stores no credential: `lotse auth` runs the agent's own login;
  `lotse login` holds an API key in memory for one call only. Never put a token in a session record,
  launcher `env`, or file here.
- Test fixtures are **synthetic only**. A real session id, prompt or reply never goes into a test.
- The transcript is a *record of what happened*, not a re-derivation. Do not add filtering as
  "protection" — a filter with no gate behind it is a policy in the wrong place.

## The four guardrails

Incidents and full wording: [docs/guardrails.md](docs/guardrails.md).

1. **A session is a scope, not a permission.** A stored session may never be pre-authorized; it says
   what is *reachable*, every call is checked again ([why](../beifahrer/docs/adr/0006-recipes-are-data-run-as-ordinary-calls.md)). `assertScopeIsNotAuthority` (`gate.ts`) throws
   if a persisted record ever grows an `allow`/`permissions`/`grants`/`capabilities`/`policy` key.
2. **Fail closed on `request_permission`.** `denyAll` is the default; the surface asks a person and
   answers `cancelled` if nobody chose. `allow_always`/`reject_always` are **passed through**, not
   filtered: the agent remembers an "always", lotse stores no policy. Only `allow_once` is
   `SUGGESTED`; there is **no timeout**. `lotse listen` narrows this further
   ([ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md),
   [ADR 0003](docs/adr/0003-serve-tasks-questions-channel.md)): it strips `*_always`, mints a
   single-use token for a yes, and never stores a grant.
3. **`fs/read_text_file` and `fs/write_text_file` are answered `false`** in the capability
   announcement and refused if asked anyway. File access is a decision, not a default.
4. **`_meta` is passed through, never parsed.** Unknown `_meta` and unknown capability keys must
   never be errors ([measured handshake](refs/acp/SOURCE.md#what-one-real-agent-answers)).

Plus: **no central capability registry**, and **MCP is passed through, not known** (`newSession`
forwards `mcpServers` as opaque objects and only reads `type`).

## The two traps

**Trap 1 — `authMethods` is real and interactive.** `opencode acp` sends a `description` the schema
does not define and no `type` tag. `lotse auth` exists because without it the first session dies on
an error message instead of on code. Details: [docs/acp-auth-trap.md](docs/acp-auth-trap.md).

**Trap 2 — capability negotiation is uneven.** Not every agent can do everything. **Check the
capability, do not assume it.** `AcpClient.reattach` tries `session/load` first, falls back to
`session/resume`, and rejects with `UnsupportedCapabilityError` if the agent offers neither. Asking
for an unadvertised capability is a hard error, always.

## Run / build / test

```bash
gjsify install                              # never npm install
gjsify foreach -A check                      # type-check everything
node scripts/check-schema.mjs                # code against refs/acp/schema.v1.json
gjsify workspace lotse-cli build            # → app/dist/lotse.gjs.mjs
gjsify workspace lotse-cli test             # @gjsify/unit, GJS and Node
gjsify workspace lotse-cli test:real-agent  # real stdio chain against a real agent
gjsify run app/dist/lotse.gjs.mjs <command>
gjsify workspace lotse-cli build:app        # → app/dist/lotse-app.gjs.mjs (GTK bundle)
```

Behaviour rules that change every task:

- **A hook set to `0` or `false` is off**, in lotse and the stand-in alike.
- **Every pointer-only hook goes through the surface**, never around it.
- **Failures are classified by type and turn state, never by wording**; only `auth`, `model` and
  `unsupported` earn a dialog. `'auth'` vs `'model'` is `FailureContext.promptSent`, required so a
  call site cannot omit it.
- **Free models are detected by rule (`isFreeModel`), never listed by hand, never auto-selected or
  hidden**; every one in use earns `FREE_MODEL_WARNING`.
- **The permission dialog: both end button slots are a decline**, `buildDialog` names
  `default_response` explicitly, no allow option holds the focus.
- Phone floor is 360 px (`WINDOW_MIN_WIDTH_PX`).
- **GJS is mandatory, not optional**: a pure Node test would be green and miss the real question. If
  a change makes the Node run impossible, the change is in the wrong file.

Measurements, dev hooks, GTK behaviour and the dual-run rationale:
[docs/dev-fixtures.md](docs/dev-fixtures.md), [docs/surface-rules.md](docs/surface-rules.md),
[docs/toolchain-traps.md](docs/toolchain-traps.md).

`refs/acp/schema.v1.json` is the normative artifact; refresh with `./scripts/update-acp-schema`.
`scripts/check-schema.mjs` fails the build when code and schema disagree — read the diff before
committing a refresh.

## Packaging

**The `gjsify.flatpak` block in `package.json` is the source of truth**. `npm run packaging:validate`
is THE gate (`--show-manifest` only prints). Details: [docs/packaging.md](docs/packaging.md), [data/README.md](data/README.md).

## What is deliberately not here yet

A web surface · Telegram bot · XMPP channel for `lotse listen` · MCP wiring beyond one task's rights
· troedler integration · Claude Code adapter. Status and rationale: [docs/roadmap.md](docs/roadmap.md).
