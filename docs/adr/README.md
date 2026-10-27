# Architecture decision records

One file per decision that is expensive to reverse. Name: `NNNN-short-title.md`, numbered in
order, never reused.

Each record has a title, then `Status`, `Date`, `Deciders` and optionally `Related`, followed by
**Context**, **Decision**, **Consequences**. Add **Order of work** when the decision is a plan.

Statuses: **Proposed** (written, not yet agreed), **Accepted**, **Superseded by NNNN**,
**Rejected**. A superseded record stays; only its status changes. A record that loses only some
parts stays **Accepted** and names the record and the parts.

| # | Title | Status |
|---|---|---|
| [0001](0001-lotse-as-an-embeddable-widget.md) | lotse as an embeddable widget | Accepted |
| [0002](0002-assistant-in-continuous-operation.md) | The assistant in continuous operation | Accepted |
| [0003](0003-serve-tasks-questions-channel.md) | `lotse serve`: tasks, questions and the channel seam | Accepted |
| [0004](0004-headless-job-api.md) | A headless job API in `@lotse/core` | Accepted |
| [0005](0005-two-gettext-domains.md) | Two gettext domains: the app's and the library's | Accepted |
| [0006](0006-per-user-agent-install.md) | A per-user install of the pinned agent, on request | Accepted |
| [0007](0007-profiles-tasks-triggers.md) | Profiles, tasks and triggers | Accepted |
| [0008](0008-messenger-channel-as-mcp-contract.md) | The messenger channel as an MCP contract | Accepted |
| [0009](0009-voice-as-a-surface.md) | Voice as a surface | Proposed |
