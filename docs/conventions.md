# Conventions

Toolchain and commit rules moved from `AGENTS.md`.

- `gjsify install` — never `npm install`, it prunes gjsify deps.
- All `@gjsify/*` packages are pinned to the **same exact version** (0.64.11 here). gjsify ships as
  one release train; a CLI ↔ libs skew produces silently broken bundles. `@gjsify/napi` is absent on
  purpose: [toolchain-traps.md](toolchain-traps.md#why-gjsifynapi-is-not-pinned).
- `gjsify foreach -A check` (the `-A` includes `private: true` workspaces), `gjsify workspace
  <name> <script>` for one — **no `run` keyword**.
- Use `./node_modules/.bin/gjsify`, not the `gjsify` on `PATH`, whenever the toolchain version
  matters. The global install wins, and a run that looks linked is then a released CLI.
- `typescript` is pinned to `^6.0.3`, **not** 7: `gjsify tsc` runs a bundle with 6.0.3 baked in,
  regardless of what is installed locally.
- Conventional commits (`feat(acp): …`, `fix(session): …`), imperative, subject ≤ 50 chars.
- This repo is a submodule of werkstatt: commit here first, then bump the pointer in the parent.
  Never stage across that boundary in one commit.
- In a gjsify project you import `node:child_process` — not `@gjsify/child_process`. The package
  specifier bypasses the bundler's resolution. The two failures that looked like two bugs:
  [toolchain-traps.md](toolchain-traps.md#nodechild_process-not-gjsifychild_process).
