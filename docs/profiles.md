# Profiles

A profile says who a session runs as: which agent, which model, which tools, how much it may do.
It is a concept of Lotse's own ([ADR 0007](adr/0007-profiles-tasks-triggers.md)), so every host
that starts a session reads the same file: `lotse listen`, requests from the chat and, as they pick
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
| `voice` | no limit | `any`, `local-only` or `off`: which speech engines a session may use ([ADR 0009](adr/0009-voice-as-a-surface.md)). A host's policy can only narrow it: the narrower of the two wins. |
| `data` | — (required) | `private` or `public`. A label for the person; it never blocks a run. |

## Serve keeps the binding

A profile carries its own `user` (an id from [users.json](listen.md)), `channels` and
`messengerDetail`; with one user in users.json, `user` may be left out. Requests from the chat name a
profile, because they need a user.

## How a session gets its tools and rights

- **MCP servers.** A task's `mcpServers`, when it has any, replace the profile's; otherwise the
  profile's apply. An answer turn uses `answerMcpServers`, else the first turn's. The read-only
  precheck takes only its own servers, never the profile's. A request's `mcpServers` and `preamble`,
  when set, replace the profile's.
- **Rights.** The lower of the task's (or request's) and the profile's. Narrowed below `released`,
  the released areas are dropped.

## MCP server toggles

The widget's config row shows one toggle per MCP server of the session (by name, all on by default),
so a person can switch a server off for one conversation. A change applies from the NEXT turn: Lotse
calls ACP `session/resume` with the new server list before delivering that prompt. It never starts a
new session silently.

- **Requirement.** The agent must advertise `agentCapabilities.sessionCapabilities.resume`. Without
  it the toggles are disabled with a tooltip that says why.
- **Before the first turn.** Choices made before a conversation exists are kept and applied when it
  is created.
- **Hosts.** Pass either `profile` (a `ProfileSession`) or the older `mcpServers` option to the
  widget; `mcpServers` wins when both are set.
- **Agent-side leak.** opencode keeps the previously started MCP server running after a resume with
  a shorter list. That is the agent's behaviour, not Lotse's, and there is no workaround here: the
  toggle stops the agent from being offered the tools, not the process from running.

Boolean agent config options are shown the same way, as switches in the config row.

## Migration

With no profiles.json and a legacy tasks.json that has `profiles`, `listen` writes profiles.json once
from them (`id`, `agent`, `model`, `data`), prints one notice and never changes tasks.json, which is
not read afterwards. An existing profiles.json is never overwritten. A migrated profile has no
options, servers, preamble or rights limit; with several users, set `user` by hand.

## For hosts

`resolveProfile(profile, { agent })` returns a `ProfileSession`: command, model, options, servers,
preamble, rights, data. Finding the launcher stays with the host, so it is passed in. For
`runJob`, whose API is unchanged, spread `jobOptionsOf(session)` into its options and wrap the prompt
with `withPreamble(session.preamble, prompt)`.
