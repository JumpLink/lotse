# Changelog

Notable changes to lotse. The per-release notes that ship in the AppStream metainfo are generated
from the `gjsify.flatpak.releases` block in `package.json`; this file is the developer-facing view
and also records changes that are not a release of their own.

## Unreleased

### Added

- **Profiles are Lotse's own concept** (ADR 0007, step 1–3). A standalone `Profile` with its own
  `profiles.json` (agent, model, `configOptions`, `mcpServers`, `preamble`, `rights`, `data`) is shared by
  `lotse serve`, requests from the chat and, exported as `resolveProfile`, the widget and `runJob` hosts.
  An existing tasks.json with `profiles` is migrated to profiles.json once, with one notice; tasks.json is
  never changed and keeps working. See [docs/profiles.md](docs/profiles.md).
- **Tasks run on demand** (ADR 0007, items 4–11). `runTask(id, params, deps)` in `@lotse/core`, tasks as
  `tasks/<id>/SKILL.md`, a one-shot migration of `tasks.json`, `lotse run`, `lotse tasks`, `lotse status`
  and the chat commands `/run`, `/tasks`, `/status`. See [docs/tasks.md](docs/tasks.md).

- **MCP server toggles in the widget.** One toggle per MCP server in the composer config row; a change
  applies from the next turn via ACP `session/resume` and is disabled when the agent lacks that
  capability. The widget accepts a resolved `profile` besides `mcpServers`. Boolean agent config
  options now show as switches, and Lotse advertises the `boolean` config-option capability. See
  [docs/profiles.md](docs/profiles.md).

### Removed

- **Time-based scheduling in `lotse serve`.** The `schedule` task key, the scheduler loop, `serve --once`
  and the due-time bookkeeping are gone; `serve` now only answers chat requests and handles questions.
  An old `schedule` key in `tasks.json` is ignored with one notice per task. `precheck` stays in the
  schema, unused. Running a task on demand (`lotse run`) is planned.

### Changed

- **Toolchain:** gjsify 0.54.0 → 0.64.11 (also the committed `build-aux/gjsify.gjs.mjs` and the offline
  Flatpak sources), `@girs/*` 5.5.0, oxlint 1.89, oxfmt 0.74, `@modelcontextprotocol/sdk` 1.32.2.
- **Bundled opencode 2.0.22 → 2.1.4.**

### Fixed

- The Flatpak manifest's source tag is `v0.5.0` in `package.json` too, so regenerating it no longer
  builds the 0.4.0 sources.

## 0.5.0 — 2026-10-22

### Added

- **A per-user install of the pinned agent.** `lotse agents --install [id]` downloads the catalog's pinned
  opencode into `<data dir>/agent-binaries/`, after asking (`--yes` skips the question). Size and sha256 are
  checked before anything is unpacked; the copy then counts as the bundled one, between the shipped copy
  and the person's own install. `@lotse/core` exports `installAgent`, `effectiveCatalog` and friends for
  host apps. See [ADR 0006](docs/adr/0006-per-user-agent-install.md).

## 0.4.0 — 2026-10-22

### Added

- **Tools the embedding host confirms itself.** `hostTools.hostConfirmed` marks a tool by name or kind,
  and lotse then never approves it through `session/request_permission` — not from its own dialog, not
  from an "always allow", not from a grant given earlier in the session. The host's `confirmTool` shows
  its own dialog (a PIN, a signature) and a `true` is worth one call: what goes on the wire is the
  agent's own `allow_once`. Everything else — `false`, a throw, no callback — is a decline. See
  [docs/embedding.md](docs/embedding.md#tools-you-confirm-yourself).

- **An "always allow" that ends with the conversation.** With `hostTools.alwaysAllow: 'session'` an
  "Always allow" press is sent to the agent as its narrower `allow_once` and remembered by lotse itself,
  in memory and keyed by the ACP session id, so it is written nowhere and a new conversation asks again.
  Where the agent offers no `allow_once`, the button is withdrawn rather than shown as a promise lotse
  cannot keep that narrow.

- **The provider settings and the onboarding page are mountable by a host.**
  `createProviderSettingsPage` and `createOnboardingPage` (plus `probeConnections`) are exported from
  `@lotse/widget`, for an app with its own preferences dialog and its own welcome screen. Both are the
  pages lotse builds for itself — the same provider file, the same private login server, the same
  `modelPolicy` — and `createOnboardingPage` returns `null` where `onboardingView` says the ordinary chat
  is the right page. See [docs/embedding.md](docs/embedding.md#mount-the-two-pages-yourself).

- **Reply to the question's message in the chat.** A messenger reply (XEP-0461) binds the answer to
  the question that message carried, ahead of the one-open-question guess; the quote fallback is dropped.
  Needs a Curlew that returns `replyToId`. See [docs/serve.md](docs/serve.md#reply-to-the-questions-message).

- **Translations.** The app, the widget, the CLI and the notifications are translated with gettext
  (English msgids, German catalogue). Two domains: `eu.jumplink.Lotse` (app) and `lotse` (widget and core).
  Hosts compile the shipped `.po` files themselves; see [docs/i18n.md](docs/i18n.md) and
  [docs/embedding.md](docs/embedding.md#translations).

- **`person_needed`: a running task can ask for you.** A task with `personNeeded: {enabled}` tells you
  that only you can go on (a login, a code, an approval), waits, and continues on `done` or on a code you
  reply with. No reply in time leaves a deferred open question in `lotse questions`. The code never
  reaches the store, the log or a transcript, and a task that may receive one is refused on a free model.
  The wait is a setting (Preferences, `--person-needed-minutes`). See `docs/serve.md`.

- **A warning while a free model is in use.** A card above the composer says that free-model providers
  may store what is sent and train on it, so it is not for tax or client data. Closing it holds for that
  model in that conversation; it comes back for another free model and in the next conversation.

### Fixed

- **A never-run `at` task now starts.** The schedule measured "after now" on every tick, so the candidate
  time slipped past just as it arrived and the task moved to tomorrow forever. `serve` now fixes a task's
  baseline when it first sees it (start or reload) and runs it at the first matching time after that.

### Changed

- **The fallback note names no CLI command unless the caller supplies one.** `resolveAgent` and
  `ResolveContext` take an optional `remedy`; only the lotse CLI passes ``choose again with `lotse agents --use` ``,
  so a host app such as an embedded chat pane no longer tells people to run a command that cannot run there.
- **Free models are detected, not listed.** `isFreeModel` is a rule over the id (`-free` suffix plus
  `opencode/big-pickle`); `packages/core/data/free-models.json` and its exports (`FREE_MODELS`,
  `FREE_MODEL_IDS`, `FreeModelList`) are gone, and no model is called zero-retention any more.
  `freeModelFirst` keeps the agent's order in both groups.

- **Chat messages are styled for XMPP and carry images.** The messenger channel turns the agent's Markdown
  into XEP-0393 styling (`*bold*`, `_italic_`, `• ` lists, `text: url` links) and sends a standalone
  `![alt](https://…)` line as its own image message (curlew's `send_message` `image_url`), in order, at most
  8 per message. A server without `image_url` gets the plain link.
- **The bundled opencode is the default agent; your own is an opt-in.** With no `agent` setting, lotse
  now starts the shipped opencode (own isolated config and login) and falls back to an opencode on your
  `PATH` only where no copy is bundled, such as a dev checkout. Other people configure the shipped
  copy; your own global opencode is never picked up unasked. To keep using it, choose **Your own opencode
  (global configuration)** in Preferences or run `lotse agents --use opencode:host`. A setting that
  names something unavailable now falls back to the same default. Sessions recorded on your own
  opencode still resume on it. Preferences lists the bundled copy first, marked *recommended*.

## 0.3.0 — 2026-10-11

First release published by CI with provenance: the app and the four libraries share this version.

### Added

- **Answering from the desktop.** A `lotse serve` question's notification gets an **Answer…** button
  and, for a permission, **Allow once** / **Decline**, when the notification server shows actions.
  `lotse answer <id>` without text (or with `--dialog`) opens an answer window. The setting
  `channel.desktop.mode` (`notification` | `dialog`, also in Preferences) can open the window
  right away instead. See [docs/serve.md](docs/serve.md#answering-from-the-desktop).
- **Answering over a messenger** (#57). `lotse serve` reaches its person through an MCP server
  (curlew by default); lotse itself speaks no XMPP. Settings `channel.active` and
  `channel.messenger` (also in Preferences). The first answer wins across desktop and messenger,
  and `parseAnswer` also reads `allow` / `decline` / `deny`.
- **Structured tool calls in the transcript** (#43). Each tool line now also stores `tool`: ACP kind,
  title, status, the input up to 8 KiB (`rawInputOmitted` above that) and `mcp`, the MCP tools the
  call reached (opencode's code-mode report, or a reading of the code while it runs). `text` is
  unchanged, and older files read as before. `ToolItem.call` folds a call across its lines;
  `mcpCallsOf` and `fitsInputCap` are exported from `@lotse/core`.
- **`LotseChatOptions.toolPresenter`**: a host draws its own MCP calls with its own title, subtitle
  and icon. The status stays the agent's; a presenter that throws falls back to lotse's row.
- **Host entries**: `LotseChat.appendHostItem({type, text, data?, icon?})` (core:
  `AgentSession.appendHostEntry`) records a line of kind `host` in the open conversation. It
  rejects without an `appendTurns`, and for `data` that is not JSON or over the 8 KiB cap. A line
  of a kind this lotse does not know shows as a note instead of breaking the transcript.
  **Downgrade limit:** lotse versions before this one crash when resuming a session that contains a
  `host` line.
- **Custom providers** (#17): local models (Ollama, LM Studio, llama.cpp, vLLM presets) and any
  OpenAI-compatible endpoint for the bundled opencode, via `lotse provider list|add|remove` and
  `@lotse/core` (`planCustomProvider`, `checkEndpoint`, `createProviderApi`, `withProvider`, …).
  lotse writes its own `lotse-providers.json` through `OPENCODE_CONFIG`; keys go only to opencode's
  `connect/key`. https and loopback are accepted, LAN http needs `--allow-lan`, anything else is
  refused, and a catalog id is never shadowed. A keyless local provider counts as connected for the
  onboarding. See [docs/custom-providers.md](docs/custom-providers.md).
- **Provider settings page** (#45, `@lotse/widget`): `LotseChat.providerSettingsPage()` and
  `openProviderSettings()` list connected providers (connect, log out), custom providers and the
  privacy notes; lotse's preferences gain it as the `providers` page. The host option
  `allowCustomProviders` (default off) enables add and remove; a `modelPolicy` also filters the login
  dialog (`providerOffered`). The logic is core's `ProviderSettingsController`.
- **Headless jobs** (`@lotse/core`): `runJob<T>` runs one prompt with no widget and returns your
  `parse`d JSON value or a typed `JobError`. One agent per job, a required `modelPolicy`, every
  permission declined by default, timeout and abort as cancel-then-close, nothing persisted
  ([ADR 0004](docs/adr/0004-headless-job-api.md)).

## 0.2.0 — 2026-10-11

Libraries only: `@lotse/{acp,session,core,widget}@0.2.0` were published to npm by hand from c0839df. The app was
never released as 0.2.0; its first release is 0.3.0, which also carries everything listed under 0.3.0.

### Added

- **The libraries are on npm.** `@lotse/acp`, `@lotse/session`, `@lotse/core` and `@lotse/widget`
  (LGPL-3.0-or-later) are published to npm (by hand, without provenance). They ship TypeScript sources, the `.blp` templates and the data JSON; see
  [docs/releasing.md](docs/releasing.md). The `@girs/*` packages are peers of the widget.
- **`@lotse/widget`**, the embeddable chat (`LotseChat`), with the host's `mcpServers`, its own
  permission gate and an onboarding page for a host without an agent.
- **Host model policy** (`@lotse/core`): a host narrows which models a chat may use
  (`allowOnlyProviders`, `denyFreeHostedModels`), and the widget takes it.
- **Flatpak module generator** (`@lotse/core`): the module that bundles the agent is generated from
  `bundled-agents.json` instead of written by hand.
- **`lotse serve` precheck.** A task can have `precheck: {profile?, prompt | promptFile}`: a cheap
  read-only turn whose last line is `WORK` or `NOTHING`. Only `WORK` starts the real run, and
  `NOTHING` is recorded as outcome `nothing`.
- **`SERVE_CONFIG_SCHEMA`** (`@lotse/core`): the task file as a JSON Schema with a title and a
  description on every field. The parser takes its allowed keys from it.

### Changed

- **`lotse serve`: the model is optional** on every profile. Without one, the agent's default
  applies. A private profile on a free model is a note at start, no longer an error (ADR 0002 §5,
  amended).
- **The login offers xAI** (Grok, including the "SuperGrok Subscription" device login), under
  **Other**. The exclusion list in `login-providers.json` stays, now empty.

- **The project is now called lotse** (German for the pilot who comes aboard a ship and steers it
  through unfamiliar water). Everything up to and including 0.1.1 was released as **Kurier**; the
  rename happened before the first npm publish, so no published package name changes:
  - npm packages `@kurier/{acp,session,core,widget}` → `@lotse/{acp,session,core,widget}`
  - the command and the binary `kurier` → `lotse`
  - the application id `eu.jumplink.Kurier` → `eu.jumplink.Lotse`. The metainfo carries
    `<provides>` and `<replaces>` for the old id, so an installed Kurier is upgraded rather than
    duplicated.
  - the data and config directories `$XDG_DATA_HOME/kurier` and `$XDG_CONFIG_HOME/kurier` →
    `.../lotse`. Each one is renamed **once** on startup when the new name is free; two
    directories are never merged, and a move that fails leaves lotse on the old directory and
    says so.
  - every environment knob `KURIER_*` → `LOTSE_*`. The old spelling is still read as a fallback —
    the new name wins when both are set.
  - the development hooks `KU_APP_*` / `KU_STANDIN_*` → `LOTSE_APP_*` / `LOTSE_STANDIN_*`, with
    no fallback: those are for working on lotse, not for using it.

## 0.1.1 — 2026-10-10

Released as **Kurier**. The first release with installable packages: login to a model provider
from the app, a Flatpak that brings its own copy of opencode, a distinct message for an account
without credit, Windows and macOS fixes, and packages for `.deb`, `.rpm`, AppImage, macOS,
Windows and Flatpak (all unsigned).

## 0.1.0 — 2026-10-01

Released as **Kurier**. The first release: the session list, one real agent turn with streaming
and Stop, the permission dialog, and the agent resolution that prefers your own opencode over the
bundled copy.
