# Vision

Lotse is a general assistant. It is a pure [ACP](https://agentclientprotocol.com) client that other
apps embed, and it has no agent, no model and no policy engine of its own.

Everything Lotse does is a standard it did not invent: ACP brings the agent, MCP brings the
capabilities, Agent Skills bring the knowledge. Lotse owns the glue between them and nothing else.

## Four terms

| Term | Meaning | Comes from |
|---|---|---|
| **Agent** | The ACP process (opencode, `claude-agent-acp`, Codex, Gemini CLI). | Outside |
| **Profile** | An agent plus model and config options, a list of MCP servers, a preamble, a rights limit and a private/public flag. | Lotse |
| **Task** | A `SKILL.md`-compatible file that tells a profile what to do. | Lotse |
| **Trigger** | Whatever starts a task. It knows a task id and parameters, nothing else. | The caller |

The profile is the only abstraction Lotse adds. The chat, the widget, the messenger, tasks and a
later voice mode all use the same one. A task narrows its profile and never widens it. A trigger
is never a permission.

[ADR 0007](adr/0007-profiles-tasks-triggers.md) records the decision and the API; the file format
is in [Profiles](profiles.md).

## The standard per layer

| Layer | Standard | What Lotse does with it |
|---|---|---|
| Agents | ACP | Starts the agent as a subprocess, manages sessions, answers `session/request_permission` from the person's decisions only. Refuses `fs/*`. |
| Capabilities | MCP | Hands the profile's server list to the agent in `session/new` and `session/resume`. Passes `_meta` and MCP through and never interprets them. |
| Tasks | Agent Skills (`SKILL.md`) | Reads the file. Lotse's own fields live in `metadata`, the field the specification reserves for clients. `allowed-tools` (experimental) can narrow further. |

Skills reach an agent through its session `cwd` (`.claude/skills`), because ACP has no field for a
skills path and the agents differ in where else they look. A profile therefore has no generic
skills-path setting.

## Own apps are optional

Curlew (mail, contacts, calendar, messaging), reminder and the other apps of the suite are MCP
servers like any other. Lotse has no package dependency on them. Curlew is the default for the
messenger channel because it fits, and [ADR 0008](adr/0008-messenger-channel-as-mcp-contract.md)
documents the contract any other MCP server can meet instead.

## Non-goals

- An agent or a model of Lotse's own.
- A package dependency on Curlew or any other app of the suite.
- A messaging protocol (XMPP or other) inside Lotse.
- An AI assistant inside Curlew. Curlew never calls Lotse.
- A scheduler. Scheduling was removed in ADR 0007 and has no replacement yet.
- An open HTTP port.
- A permission that a trigger brings along.
- Writing systemd units for the user.
