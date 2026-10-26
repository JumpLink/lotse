# Profiles

A profile says who a session runs as: which agent, which model, which tools, how much it may do.
It is a concept of Lotse's own ([ADR 0007](adr/0007-profiles-tasks-triggers.md)), so every host
that starts a session reads the same file: `lotse serve`, requests from the chat and, as they pick
it up, the widget and headless jobs.

## The file

`$XDG_CONFIG_HOME/lotse/profiles.json` (`LOTSE_PROFILES_FILE` overrides it). Start from
[examples/profiles.example.json](../examples/profiles.example.json). The schema is `PROFILES_SCHEMA`
in `@lotse/core`; every property has a title and a description.

| Key | Default | Meaning |
|---|---|---|
| `id` | — | Letters, digits, `-` and `_`. Unique. |
| `agent` | the one `lotse start` picks | A launcher id, for example `opencode`. |
| `model` | the agent's default | A value of the agent's `model` option. Not offered: the run stops, no fallback. |
| `configOptions` | `{}` | Other session options by id (`{"thought_level": "high"}`), set after the model. An option or value the agent does not offer stops the run; there is no fallback. |
| `mcpServers` | `[]` | Passed to `session/new` as is. |
| `preamble` | none | Put in front of the first message of a new session. Not added when a session is continued. |
| `rights` | no limit | `read`, `confirm` or `released`: the most a session may do, whatever a task or request asks for. |
| `data` | — (required) | `private` or `public`. A label for the person; it never blocks a run. |

## Serve keeps the binding

tasks.json still has `profiles`, but there they only bind a profile to a person: `id`, `user`,
`channels`, `messengerDetail`. For an id that exists in profiles.json, `agent`, `model` and `data`
come from profiles.json and win over tasks.json, silently, and `data` may be left out. An id only in
tasks.json works as before (it still needs `data`). Requests from the chat name a tasks.json profile,
because they need a user.

## How a session gets its tools and rights

- **MCP servers.** A task's `mcpServers`, when it has any, replace the profile's; otherwise the
  profile's apply. An answer turn uses `answerMcpServers`, else the first turn's. The read-only
  precheck takes only its own servers, never the profile's. A request's `mcpServers` and `preamble`,
  when set, replace the profile's.
- **Rights.** The lower of the task's (or request's) and the profile's. Narrowed below `released`,
  the released areas are dropped.

## Migration

With no profiles.json and a tasks.json that has `profiles`, `serve` writes profiles.json once from
them (`id`, `agent`, `model`, `data`), prints one notice and never changes tasks.json, which keeps
working. An existing profiles.json is never overwritten. Behaviour is unchanged: a migrated profile
has no options, servers, preamble or rights limit.

## For hosts

`resolveProfile(profile, { agent })` returns a `ProfileSession`: command, model, options, servers,
preamble, rights, data. Finding the launcher stays with the host, so it is passed in. For
`runJob`, whose API is unchanged, spread `jobOptionsOf(session)` into its options and wrap the prompt
with `withPreamble(session.preamble, prompt)`.
