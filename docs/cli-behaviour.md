# CLI behaviour

Moved from `AGENTS.md` (issue #15, context budget). The command list stays in [AGENTS.md](../AGENTS.md#the-cli); the reasons behind it are here.

**`listen` is [ADR 0003](adr/0003-serve-tasks-questions-channel.md), read it before touching
`packages/core/src/serve/`**; the person's guide is [docs/listen.md](listen.md). It only receives (chat requests, answers, question notices) and starts no task; tasks run on demand
([docs/tasks.md](tasks.md)). Users, channels and legacy tasks live in
`$XDG_CONFIG_HOME/lotse/tasks.json` (never in the repo, `examples/tasks.example.json` is the shape), reloaded in place when it or a prompt file changes (`app/src/frontends/cli/listen-reload.ts`; running tasks
finish with their old definition, an invalid file keeps the old one). Pure logic in core, GI
only in `app/src/core/desktop-channel.ts`, which `listen.ts` imports lazily so `answer` stays GI-free.
`serve/schema.ts` (`SERVE_CONFIG_SCHEMA`) is the one list of allowed keys, and the parser derives
from it: a new field goes there first, with a title and a description.

**Bundled before host, and the bundled copy is off PATH.** A Flatpak build unpacks the agents in
`packages/core/data/bundled-agents.json` under `BUNDLED_PREFIX` (`agents/catalog.ts` there, the one place the
prefix is written), never `/app/bin` — there it would shadow the person's own opencode, which carries
their login. The prefix is `/app/extra/agents`, not `/app/libexec`: the archive is Flatpak `extra-data`,
fetched at *install* time, and `apply_extra` can write only `/app/extra` (data/README.md).
`detectAgents` ignores a host hit under the prefix; `resolveAgent` takes the setting, else the first
bundled copy, else the first host install (`agents/detect.ts`, pure over facts gathered by
`probe.ts`). **The bundled copy is the default because other people configure the shipped opencode (own
isolated config and login); the person's own global opencode is an explicit opt-in, `agent.source: "host"`**,
and host is the default only where nothing is bundled (a dev checkout). A setting that cannot be honoured
falls back to that same default. The catalog's `env` is flags only, never a credential.
The person's choice (`{id, source}`, so "bundled opencode" ≠ "my opencode") is `app/src/core/settings.ts`, in
`$XDG_CONFIG_HOME/lotse/settings.json` (`LOTSE_SETTINGS_FILE`), 0600/0700, an allowlist that accepts no secret;
precedence is `--agent` (CLI) / `LOTSE_APP_AGENT` (GUI dev hook) > setting > bundled > host, and a setting that names something
unavailable is reported (`note`), never skipped silently; a corrupt file falls back to defaults and says so.
`lotse agents --use <id>[:bundled|host]|none` writes it.
The GUI writes it from Preferences (`<Ctrl>comma`); a change applies the next time lotse starts, and a settings file lotse could not read is never destroyed by a save (`saveDecision`). The dialog's rows, its Flatpak async path and the hooks `LOTSE_APP_PREFERENCES[_AGENT]`: docs/dev-fixtures.md#the-preferences-dialog.
An empty session file opens on a live composer: the first prompt sends `session/new` (cwd: `LOTSE_CWD` → host cwd → `$HOME`), writes the record through the same `conversationRecord` as `lotse start`, and New chat is `win.new-chat` (`<Ctrl>n`). A stored session reattaches on the copy its record names (`agentSource`) unless `LOTSE_APP_AGENT` pins one; hooks `LOTSE_APP_NEW_CHAT`/`LOTSE_APP_CWD` are in docs/dev-fixtures.md#first-run-and-new-chat. A bundled agent earns a one-time banner (`notices.json`), no agent at all an empty state naming the remedy; hooks in docs/dev-fixtures.md#the-bundled-agent-notice-and-the-no-agent-page.
With no `--agent` (CLI) or `LOTSE_APP_AGENT` (GUI), every command and the window use that resolution; `resume` and `cancel`
use the agent the session recorded. A **bundled copy runs inside the sandbox** (`AgentCommand.bundled`;
`toHostCommand` leaves it alone, the host cannot see `/app/extra`) with its own `HOME` and `XDG_*` under
`<data dir>/agents/<id>/` (`isolation.ts`, 0700), because `--filesystem=host` puts the person's real
`~/.config/opencode` in reach and its login must not be shared; `lotse auth` logs in there too.
The two copies keep separate histories, so `lotse start` records `SessionRecord.agentSource`
(`host`|`bundled`; **absent = host**, the old records) and `resolveRecorded` resumes on that copy — a copy
that is gone is an error naming why, never a fall to the other. The window resolves with
`gatherResolveContext(paths, false)`: no `--version` spawn, so it never waits on a child before it appears.

**One turn, not a REPL**, and that is a decision rather than a missing feature. A REPL needs
somewhere to put the approval surface, and the plan puts the surface in a later slice; a REPL now
would either prompt on a stdin that is also carrying the questions, or pretend the gate is not
there. `lotse start` with no prompt opens a session and stops, which is how you get an id for
`lotse resume`.

- **stdout is the answer, stderr is everything about it.** The agent's message goes to stdout so
  `lotse start "…"` pipes somewhere useful; progress, notices, tool questions, thought chunks and
  the agent's own log lines go to stderr. A model's private reasoning is never on stdout.
- **Ctrl-C is the protocol's cancellation, not a kill**: `session/cancel` goes out, the agent stops
  cleanly and answers the turn with `cancelled`, and the transcript ends where the work ended.
- **A piped or redirected stdin cannot ask, so it declines.** The terminal gate needs a person;
  without one the only honest answer is no. `--deny-all` forces that even on a terminal.
- Every option is read with `pickArgv`, which asks for both spellings. yargs exposes `--deny-all`
  as `denyAll` or `deny-all` depending on version, and a gate that silently stopped firing is the
  worst failure a flag whose whole job is stopping things can have.
