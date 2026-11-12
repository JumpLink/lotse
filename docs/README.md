# lotsman docs

Agent-facing guidance is in [../AGENTS.md](../AGENTS.md). The files here expand on specific areas.

## Development

- [Conventions](conventions.md) — toolchain, gjsify, commits, submodule rules.
- [CLI behaviour](cli-behaviour.md) — command semantics, bundled-agent precedence, one-turn rule.
- [Toolchain traps](toolchain-traps.md) — stale bundles, `node:child_process`, `.blp` imports,
  `@gjsify/napi`.
- [Surface rules](surface-rules.md) — hooks, failure dialogs, permission dialog, dual test run.
- [Dev fixtures](dev-fixtures.md) — stand-in agent, dev hooks, GTK probes, measurements.
- [Login](login.md) — OAuth and API-key login, provider catalog, inline onboarding.
- [Guardrails and privacy](guardrails.md) — the full text and incidents behind the four guardrails and the privacy rules.
- [Packaging](packaging.md) — the `gjsify.flatpak` source of truth, the finish-args that are not free.
- [ACP auth trap](acp-auth-trap.md) — the `authMethods` trap and how `auth.ts` answers it.

## Architecture

- [ADR index](adr/README.md)
- [Package layout](architecture/package-layout.md) — what lives in each package and why.
- [Embeddable widget study](architecture/embeddable-widget-study.md) — extracting `@lotsman/widget`.

## Product

- [Vision](vision.md) and [roadmap](roadmap.md) — what lotsman is and what it is not.
- [Tasks](tasks.md), [profiles](profiles.md), [listen](listen.md), [messenger contract](messenger-contract.md).
- [Custom providers](custom-providers.md), [i18n](i18n.md), [releasing](releasing.md).
- [Claude Code adapter](claude-code.md) — terms and billing notes.

## Design and packaging

- [GUI design](design/README.md) — principles and screenshots.
- [Embedding guide](embedding.md) — for hosts using `@lotsman/widget`.
- [Packaging and Flatpak details](../data/README.md) — desktop entry, metainfo, finish-args,
  bundled agent.
