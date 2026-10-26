# 7. Profiles, tasks and triggers

- Status: **Accepted**
- Date: 2026-10-26
- Deciders: Pascal Garber
- Related: [vision](../vision.md),
  [ADR 0002](0002-assistant-in-continuous-operation.md) and
  [ADR 0003](0003-serve-tasks-questions-channel.md) (partly superseded here: scheduling and the task
  format), [ADR 0004](0004-headless-job-api.md) (stays as it is)

## Context

ADR 0002 and 0003 built tasks as entries in `tasks.json`, each with its own schedule, prompt,
profile and rights. That format is Lotse's own invention, and it ties one way of starting a task
(a timer inside `lotse serve`) to the task itself. Three things changed the picture:

- Chat, widget, messenger and later voice all want the same agent setup. Today only tasks have a
  "profile", and it lives inside the task file.
- Agent Skills (`SKILL.md`) are a standard that both measured agents already read.
- The person wants to ask for the state of things in chat, and to start work from a CLI or an
  outside timer, instead of having Lotse decide when to act.

Two measurements on 2026-10-26 settle open points:

- **M1, MCP list on resume.** ACP `session/resume` with a changed `mcpServers` list is honoured by
  opencode 2.1.2 and `claude-agent-acp` 0.97.0. `claude-agent-acp` stops the servers that left the
  list. opencode leaves the old server running. That is an agent-side leak and Lotse does not work
  around it.
- **M2, skills path.** ACP has no field for a skills path. Both agents read `<cwd>/.claude/skills`.
  opencode also reads `.opencode/skills`, `.agents/skills` and `$OPENCODE_CONFIG_DIR`;
  `claude-agent-acp` reads `$CLAUDE_CONFIG_DIR/skills` and `_meta.claudeCode.options`. No two
  agents agree on more than the `cwd` path.

## Decision

1. **The profile is the only abstraction Lotse adds.** A profile holds the agent, model and config
   options, the MCP server list, a preamble, a rights limit and a private/public flag. Chat,
   widget, messenger, tasks and later voice resolve the same profile into session options.
2. **MCP servers can be switched per conversation.** The widget offers a toggle for each server of
   the profile. A change applies from the next turn: Lotse calls `session/resume` with the new
   `mcpServers` list (M1). The known opencode leak is documented, not patched.
3. **A profile has no skills-path field** (M2). Where a task needs skills, Lotse reaches the agent
   through the session `cwd` and its `.claude/skills` directory.
4. **A task is a `SKILL.md`-compatible file.** Lotse's own fields (profile, rights, parameters,
   precheck) sit in `metadata`. `allowed-tools` may narrow the tool set. A task narrows its
   profile and never widens it.
5. **A trigger is a task id plus parameters.** Chat, CLI, an outside timer and later a webhook are
   all triggers. A trigger never carries a permission. Rights come from the profile and the task.
6. **Scheduling is removed with no replacement** (decided 2026-10-26). Lotse has no scheduler and
   writes no timer. The person may rethink it later: an external timer, the Background portal, or
   nothing. Until `lotse run` exists, tasks cannot run, on purpose.
7. **The task runner is a second function next to `runJob`.** `@lotse/core` exports
   `runTask(id, params)`. `runJob` (ADR 0004) stays narrow: one round, structured output,
   `denyAll`, two minutes. `runTask` adds the gate, questions, `person_needed`, the precheck and a
   run log.
8. **One result, no channel.** A run ends as one of:
   - `done`, with the output;
   - `needs-person`, with a question id (the question stays in the question store and
     `lotse answer` resumes the run);
   - `failed`, with a reason.

   The caller decides where the result goes.
9. **The CLI and chat share one set of functions.**

   | CLI | Chat | Does |
   |---|---|---|
   | `lotse run <id> [--param k=v] [--json]` | `/run` | Runs a task. |
   | `lotse tasks` | `/tasks` | Lists tasks. |
   | `lotse status [--json]` | `/status` | Shows running and recent runs, open questions. |

   Chat commands make no model call.
10. **Exit codes of `lotse run`:** 0 `done`, 1 `failed`, 2 usage error, 3 `needs-person`. The
    distinct code for `needs-person` lets a shell script or timer tell "waiting for a person" from
    "broken".
11. **One lock per task id.** A second run of the same task while one is active ends as `failed`
    with reason `locked`. Different tasks run side by side.
12. **No HTTP port.** A D-Bus or Unix-socket service API comes only if voice needs a warm session.

## Consequences

- The parts of ADR 0002 and 0003 about schedules, the scheduler loop, `runs.json` due times and
  `serve --once` go away. Their status line says so. Questions, the gate and `person_needed`
  stay as built.
- `tasks.json` migrates to profile files and `SKILL.md` tasks. The migration keeps the old file
  and never overwrites it.
- Private profiles, addresses and task texts stay under `$XDG_CONFIG_HOME/lotse/`, never in the
  repo.
- Until the runner and CLI land, the messenger answers `/ask` and nothing runs on its own.
- An outside timer or script can start any task. Because a trigger brings no rights, that is no
  more dangerous than the person typing `/run`.

## Order of work

1. Remove scheduling.
2. Profile type, parser and resolver in `@lotse/core`; the per-conversation MCP toggle.
3. `runTask`, the `SKILL.md` format and its migration, then CLI and chat commands.
