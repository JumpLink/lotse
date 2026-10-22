# 6. A per-user install of the pinned agent, on request

- Status: **Accepted**
- Date: 2026-10-22
- Deciders: Pascal Garber
- Related: [ADR 0001](0001-lotse-as-an-embeddable-widget.md), `packages/core/src/agents/install.ts`,
  `packages/core/data/bundled-agents.json`

## Context

lotse starts coding agents as subprocesses, and the person's own `opencode` is only the fallback: the
default is the copy lotse ships. That copy exists for one package only. The Flatpak ships it as
`extra-data` under `/app/extra/agents`; a `.deb`, an AppImage, a source install or a host app that
embeds the widget has no such directory. There the person lands on "no agent" until they install
opencode by hand, or the package bundles 90 MB per architecture.

The catalog (`bundled-agents.json`) already pins what a build may ship: version, URL, size, sha256.

## Decision

1. **lotse can fetch the pinned archive for one person, into its own data directory.**
   `installAgent` writes `<dataDir>/agents/<id>/<version>` and nowhere else.
2. **It trusts only the catalog.** The bytes are checked against the pinned size and sha256 *before*
   `tar` sees them; a mismatch leaves nothing on disk. There is no "latest": a newer opencode arrives
   with a lotse release that moves the pin, so what runs next to tax data was read by someone.
3. **The mechanism never decides to download.** A program is a network download; the caller asks
   first (the CLI: `lotse agents --install`, with the size, and `--yes` as the explicit way to skip
   the question). A host app asks in its own surface.
4. **A per-user copy is a bundled copy that lives somewhere else.** `effectiveCatalog(dataDir)`
   rewrites an entry's `installPath` when only the per-user copy exists, and the resolver, detection
   and settings read that list instead of the constant. Nothing downstream learns a third source.
   Order: shipped copy, per-user copy, the person's own install. The isolation (own `HOME`, `XDG_*`)
   is the same as for a shipped copy, so it never sees the person's own opencode login.
5. **Flatpak keeps `extra-data`.** Flathub accepts the install-time download and dislikes
   self-updaters. The runtime install is for the other packages. Using it inside a Flatpak would put
   the copy in the sandbox's data directory and run it under the same finish-args — nothing widened —
   but whether it fits a restricted app's network permission is decided separately, per app.

## Consequences

- Non-Flatpak packages need no bundled agent; #95 item 1 of the Steuererklärung shrinks to "ask,
  then call `installAgent`".
- Linux x86_64 and aarch64 only, because the catalog pins only those. Windows and macOS need an
  `os` field and pins.
- Updates are as slow as lotse releases. An externally updated catalog would need a signature; it
  is built only if that proves too slow.
- Old versions are pruned after a successful install, so the directory holds one copy.
