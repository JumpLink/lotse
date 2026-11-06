# Packaging

Moved from `AGENTS.md`.


**The `gjsify.flatpak` block in `package.json` is the source of truth**: desktop entry, metainfo,
manifest and `flathub.json` are generated from it, so a hand edit of `data/*` is lost.
`npm run packaging:validate` is THE gate (`--show-manifest` only prints). Three finish-args are not
free (`--talk-name=org.freedesktop.Flatpak` + `--filesystem=host` make the sandbox close to
decorative; `--share=network` is for the bundled agent), and `packages/core/src/agents/sandbox.ts`
rests on four measured facts — read [data/README.md](data/README.md) before changing either.

