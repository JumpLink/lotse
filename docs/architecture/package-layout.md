# Package layout

Moved from `AGENTS.md` (issue #15, context budget). The rules stay in `AGENTS.md`; the full table
and the reasoning behind the split live here.

| Package | Contains | May import |
|---|---|---|
| `@lotse/acp` | **Pure.** The ACP wire types against `refs/acp/schema.v1.json`, the JSON-RPC codec (`jsonrpc.ts`), the `Transport` seam (`transport.ts`), the client session lifecycle (`client.ts`), the gate that answers what an agent may ask of a client (`gate.ts`) | nothing |
| `@lotse/session` | The model (`SessionRecord`, transcript, resume binding, principal, scope) and a JSON file store | `@lotse/acp`, `node:fs` — no `gi://`, no agent adapter |
| `@lotse/core` | Everything decision-shaped that is not a surface: the agents (`agents/*`, with `data/bundled-agents.json`), the session controller (`agent-session.ts`), one turn (`run.ts`, `turn.ts`), the login (`auth.ts`, `login/*`), the failure classification (`failure.ts`) and the view-model files the widget will need | `@lotse/acp`, `@lotse/session`, `node:*` — no `gi://`, no yargs, no widget |
| `@lotse/widget` | **The chat surface, as a widget.** `LotseChat` (`chat.ts` + `chat.blp`) — one conversation: transcript (`transcript-view.ts`, `tool-line.ts`), composer (`composer.ts`, `config-row.ts`), the approval dialog (`permission-dialog.ts` + `permission-body.blp`), the failure and login dialogs, self-installed CSS | `@lotse/core`, `@lotse/session`, `gi://` (GTK 4, Adw 1) — no app, no decisions of its own |
| `lotse-cli` (`app/`) | yargs CLI, the terminal permission gate, the XDG path resolver, the settings and notices files, and the Adwaita shell in `src/frontends/gui/` (its own bundle) around one `LotseChat` | all of the above; `gi://` only under `frontends/gui/` |

**`packages/acp` does not know that subprocesses exist.** No `spawn`, no `node:child_process`, no
`gi://`, no dependencies at all — the transport is an injected interface (`Transport` in
`transport.ts`). That is curlew's `store`-knows-no-backend rule one layer up, and it is what lets
the same protocol code run as the Node unit test and the GJS integration test.

**There are two directories called core, and the difference is the whole point.** `packages/core/src` is
LGPL and holds what a *host* would need; `app/src/core` is AGPL and holds what is true of **this** app
only — the XDG resolver (`paths.ts`), the settings file (`settings.ts`, `settings-view.ts`), the notices
file (`notices.ts`), `session-groups.ts`, `private-file.ts`. Three of those are split on purpose: the
`LotsePaths` shape, `AgentChoice`/`describeChoice` and `NOTICE_IDS`/`noticeDue` are decisions and live in
the package, while reading and writing one app's file stays here. Before adding to `app/src/core`, ask
whether a host would want it; if yes it belongs one level down. [ADR
0001](../adr/0001-lotse-as-an-embeddable-widget.md) records what stayed and why.

**The app imports `@lotse/core`, never a file inside it** — and the same for `@lotse/widget`. Each
package's `src/index.ts` is a deliberate barrel, so what is public is a decision somebody made rather than
whatever a consumer reached for; a new export is one line there. The widget also exports `./tool-line` and
`./permission-dialog`, both **for measurements, not for hosts** (a Node-capable unit test, the focus probe).
The unit tests live in `app/tests/unit/` and import the barrels like any other consumer — one runner
(`app/tests/test.mts`) is what keeps the dual GJS + Node run working.

**`app/src/frontends/gui/` is the shell around one `LotseChat`.** Window, sidebar, menu, Preferences and
the `LOTSE_APP_*` hooks are this app's; the transcript, composer, dialogs and chat states are the widget's,
reached only through its getters and methods. The two idle pages are built in `window.blp` and handed in as
`closedPage`/`noAgentPage` — their copy belongs to whatever surrounds a chat. **No named imports from a
`.blp`, anywhere**: [docs/toolchain-traps.md](../toolchain-traps.md#named-imports-from-a-blp).

`@lotse/session`'s store takes a path and never decides one: the app resolves `$XDG_DATA_HOME` once into a
`LotsePaths` (`app/src/core/paths.ts`, passed to the commands and the window; `lotsePathsUnder(root)`
from `@lotse/core` for a host), a test passes a temp dir.
