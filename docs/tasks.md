# Tasks — run on demand

A task is a prompt a person can start by name: `lotse run <id>`, or `/run <id>` in the chat. It runs
with a [profile](profiles.md), the same gate, questions, `person_needed` and precheck as every other
run (ADR 0007, items 4–11). Nothing starts it by itself.

## Format

A task is a directory with a `SKILL.md`: `$XDG_CONFIG_HOME/lotse/tasks/<id>/SKILL.md`. The id is the
directory name and must equal `name`. The file follows the
[Agent Skills](https://agentskills.io) layout; Lotse's own fields live in `metadata`, so other tools
ignore them. The frontmatter is a small YAML subset: flat keys, one `metadata` map, plain,
single-quoted or JSON double-quoted values. The body is the prompt.

```markdown
---
name: inbox-report
description: Summarise what changed in a folder since a given day
allowed-tools: files
metadata:
  lotse-profile: public
  lotse-rights: read
  lotse-params: folder, since=yesterday
---
List what changed in {{folder}} since {{since}}.
```

| Field | Meaning |
|---|---|
| `name`, `description` | required; `name` is the directory name |
| `allowed-tools` | space-separated MCP **server names** of the profile this task may use; default all |
| `metadata.lotse-profile` | profile id; optional when there is exactly one profile |
| `metadata.lotse-rights` | `read` or `confirm` (default) |
| `metadata.lotse-params` | comma list: `name` (required) or `name=default` |
| `metadata.lotse-precheck` | one-line precheck prompt; `NOTHING` ends the run as done |
| `metadata.lotse-person-needed` | `true`, `false` or minutes to wait for a person |
| `metadata.lotse-cwd` | absolute working directory; default the task's own directory |

An unknown `lotse-*` key is an error, so a typo is not silently ignored.

## Narrowing

A task only narrows its profile. `allowed-tools` names a subset of the profile's MCP servers; a name the
profile lacks makes the task fail to load. A task can never add a server or raise rights.

## Parameters

Declared in `lotse-params`, passed as `--param name=value` (chat: `/run id name=value`, quote values with
spaces), and substituted for `{{name}}` in the body and the precheck. An unknown or missing parameter is a
usage error.

## Migration

Tasks in `tasks.json` stay runnable. The first time Lotse reads `tasks.json` it writes each task to
`tasks/<id>/SKILL.md` when that directory does not exist, and prints one notice. It never overwrites a
directory, never changes or deletes `tasks.json`, and does nothing the second time. Legacy tasks take no
parameters.

## Commands

```bash
lotse run <id> [--param k=v]... [--json]   # run now
lotse tasks [--json]                       # what can be run
lotse status [--json]                      # running, last run per task, open questions
```

Chat (configured users only, no model call): `/run <id> [k=v…]`, `/tasks`, `/status`. They use the same
functions as the CLI and reply with its text.

`lotse run` exit codes: `0` done, `1` failed (a second run of a task already running fails with
`locked`), `2` usage error, `3` a question waits for a person (`lotse answer`).

An example is in [examples/tasks/inbox-report](../examples/tasks/inbox-report/SKILL.md).
