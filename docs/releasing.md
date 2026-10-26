# Releasing

Two things ship from one tag `vX.Y.Z`, both from [release.yml](../.github/workflows/release.yml):

- the **app**: `.deb`, `.rpm`, `.AppImage`, macOS and Windows packages and the Flatpak, attached to the
  GitHub release (version taken from `app/package.json`);
- the **libraries** `@lotse/acp`, `@lotse/session`, `@lotse/core`, `@lotse/widget` (LGPL), published
  to npm by the `npm` job. All four share one version, and the job refuses a tag that disagrees with
  it.

## Cutting a release

1. Bump `version` in `packages/{acp,session,core,widget}/package.json` **and** `app/package.json`
   plus the `@lotse/*` ranges (`^X.Y.Z`) in the three packages that depend on each other and in
   `app/package.json`. Add the release to `CHANGELOG.md` and to `gjsify.flatpak.releases` in
   `package.json`, and set the `lotse` module's `tag` there to `vX.Y.Z` — then regenerate the
   manifest ([data/README.md](../data/README.md)); 0.5.0 bumped only the manifest, and the next
   `flatpak init --force` turned it back to `v0.4.0`.
2. `gjsify install` (refreshes `gjsify-lock.json`), then the checks from `AGENTS.md`.
3. Merge, then `git tag vX.Y.Z && git push --tags`.

The `npm` job runs after the `check` job (type check, format, build, tests on GJS and Node), publishes
in dependency order (acp, session, core, widget) and skips a name@version that is already on npm, so a
re-run after a partial failure finishes the rest. The GitHub release job waits for `npm`: if it fails,
re-run it before the app is attached.

## How npm authenticates

By **Trusted Publishing** (OIDC): the job has `id-token: write`, npm exchanges the GitHub token for a
short-lived publish token, and `provenance: true` in each `publishConfig` attaches a signed
attestation. There is no `NPM_TOKEN` secret. Each package has a Trusted Publisher entry on npmjs.com
naming repository `JumpLink/lotse` and workflow file `release.yml`, so **renaming that file breaks the
publish**.

Do not set `registry-url` on `actions/setup-node` in that job: it injects a placeholder
`NODE_AUTH_TOKEN`, which npm reads as "token auth requested" and skips OIDC.

Manual runs (Actions, "Run workflow", input `npm`):

| `npm` | does |
|---|---|
| `skip` | nothing (default) |
| `check` | audits every Trusted Publisher entry via `gjsify publish --check-trusted`; publishes nothing |
| `dry-run` | `npm publish --dry-run` for all four |
| `publish` | publishes; needs the version to be unpublished |

## First publish of a new name (once per package)

**A Trusted Publisher can only be configured for a package that already exists on the registry**
([npm docs](https://docs.npmjs.com/trusted-publishers), `npm trust`: "the package must already
exist"). OIDC cannot create a name. gjsify documents the same constraint
(`gjsify/gjsify/docs/publishing.md`, "first-publish + Trusted Publisher bootstrap"): the first publish
is a manual maintainer action. This is needed once, for each of the four names, by the owner of the
`lotse` npm org (it needs a 2FA code):

```bash
npm login
# from a clean checkout of main, in this order (dependencies first)
for p in acp session core widget; do
  npm publish ./packages/$p --access public --provenance=false --otp <code>   # fresh code per package
done
npm view @lotse/widget version      # check every name answers before going on
```

Then, per package, on npmjs.com: package page, Settings, Trusted Publisher, GitHub Actions:
organization `JumpLink`, repository `lotse`, workflow filename `release.yml`, environment empty.
Or from the terminal (npm 11.10+, interactive 2FA):

```bash
for p in acp session core widget; do npm trust github @lotse/$p --repo JumpLink/lotse --file release.yml; done
```

Verify with the workflow input `npm` = `check`. From then on a tag publishes everything by OIDC.

That first manual publish carries **no provenance** (it runs outside Actions; `--provenance=false`
overrides `publishConfig.provenance`, which npm rejects outside a supported CI). If 0.3.0 itself must be
attested, publish a placeholder `0.0.0` per name instead (`npm publish <dir with a bare package.json>
--access public`), configure the entries, and let the `v0.3.0` tag publish the real packages.
