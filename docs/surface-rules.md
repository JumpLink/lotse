# Surface rules: hooks, failure dialogs, permission dialog

Moved from `AGENTS.md` (issue #15, context budget). Every rule below still holds; AGENTS.md keeps a one-line summary of each. Measurements and knobs: [dev-fixtures.md](dev-fixtures.md).

## Watching a turn without a model

`scripts/stand-in-agent.mjs` is a real ACP peer over stdio — real framing, real method names, the
`fork` marker `opencode acp` sends and the v1 schema does not define — and `LOTSE_APP_AGENT=stand-in`
selects it: it is reachable through the dev hooks and **not** in `LAUNCHERS`, which is the table of
programs a person installs.

**Every knob, every recipe and every measured GTK fact is in
[docs/dev-fixtures.md](dev-fixtures.md)** — the stand-in's turn knobs, its three permission-option
knobs, the config row's four values and its two known limits, the per-session option cache, the failure
knobs (`LOTSE_STANDIN_AUTH` / `LOTSE_STANDIN_PROMPT_AUTH` / `LOTSE_STANDIN_NO_RESUME` / `LOTSE_STANDIN_USAGE`), and
[the two kinds of GTK probe](dev-fixtures.md#probes) with the commands that print the numbers. Two
rules that change behaviour stay here:

- **`LOTSE_STANDIN_CHUNKS` takes a prefix** of the stand-in's four fixed sentences, so its default is `4`
  and a value above it is the same four sentences. It is a knob for a *shorter* answer — a reply still
  arriving, where the newest bubble is below the fold — and the default was `5` against a list of four,
  which read as a knob that could grow and could not.
- **A hook set to `0` or `false` is off**, in lotse and in the stand-in alike, so there is one rule
  for "is this on" in the repo. The reading rules are in `frontends/gui/hook-value.ts`, not in
  `hooks.ts`: `readHooks` imports the framework's reader, whose barrel imports `Adw`, so a test that
  imported it could not run on Node at all — and the rules (unset, empty, `0` and `false` are off; a
  comma list keeps its order and drops its blanks) are the part a future key gets wrong. One rule, two
  copies: the stand-in agent has the same `flag()` and cannot import this file, so it is copied and
  both files say so.

## The states only a hook can reach

**Five pointer-only controls, and a hook for each** — `LOTSE_APP_STOP`, `LOTSE_APP_STOP_ESCAPE`,
`LOTSE_APP_DISMISS_FAILURE`, `LOTSE_APP_CHOOSE_MODEL`, `LOTSE_APP_SWITCH=id[,id…]`, what each does and the
measurements that forced a hook rather than a pointer are in
[docs/dev-fixtures.md](dev-fixtures.md#the-five-pointer-only-controls). What stays here is the rule
they all follow: every one goes **through the surface** (the composer's own `clicked`,
`dismissPermission('dismissed')`, the dialog's own `close()` and its own `response` signal, and `#open` —
the same call a sidebar row makes) rather than around it, so a screenshot is of the window and not of a
re-implementation.

**Three dialogs, and only three failures earn one.** Plan §6 asks for the auth trap and the reattach
refusal to be *shown*, and `@lotse/core`'s `failure.ts` is where that is decided: `failureKind` classifies an error
by its **type and the turn state** (`RpcError` -32000, `UnsupportedCapabilityError`,
`FailureContext.promptSent`), never by its wording; `failureNotice` returns a dialog for `auth`, `model`
and `unsupported` and **`null` for `start`** — a bad command or a handshake timeout is already the
composer's caption. No failure is written to the transcript: no turn ran, so nothing to record.

**`'auth'` and `'model'` are told apart structurally, because the wire cannot** ([issue
#2](https://github.com/JumpLink/lotse/issues/2), measured in
[docs/dev-fixtures.md](dev-fixtures.md#ku_standin_prompt_auth1--the-same-error-code-a-different-kind)):
a **geo-blocked provider 403** reaches `session/prompt` as the login trap's own `-32000`, so matching the
message is one reword from wrong and matching the code is *already* wrong. What survives is whether a
prompt had gone out — `AgentSession.#promptSent`, as a **required** `FailureContext.promptSent`, so a new
call site cannot omit it and get the login-trap advice back. **A login that expires mid-turn lands here
too**, which is why the notice names *both* remedies in provider-neutral words. This path keeps the agent
(`agentStatus` reads `kind === 'model'` as attached) and the config row, whose model dropdown the one
button opens, and writes no transcript line — the agent answered, so `agentExitedEntry` would be one.

**Free models are detected, sorted first and warned about — never chosen, never listed by hand.**
`isFreeModel` (`packages/core/src/free-models.ts`) is a rule over the id the agent sends: the `-free`
suffix plus `FREE_MODELS_WITHOUT_SUFFIX` (`opencode/big-pickle`). A hand-kept id list rotted in two weeks
(2 of 12 on 2026-10-16), so none comes back. `freeModelFirst` applies it to a **model** control's values
only, keeping the agent's order inside both groups — the one named exception to "the agent's order is the
order it sent". It never selects, hides or probes: plan §3 rejected those, a default rots, probing burns
quota. **Every free model in use earns `FREE_MODEL_WARNING`** (no zero-retention claim, for any model);
the widget shows it above the composer, and closing it holds for that model in that conversation only
(`freeModelWarningDue`) — no "never again". A host that must not reach a free model passes
`denyFreeHostedModels`, which is a refusal, not a dismissible note.

**Once per failure, and never over a window that has moved on.** Two more functions in the same file
answer the two questions a surface asks on every state move, and both are needed: `failureToShow` is
`null` for a failure **this window has already shown** — compared by the attachment's *identity*, not
by "is a dialog up right now", because a dismissed dialog closes itself and `attachment` stays `failed`
until the next attach, so a dialog up/down guard re-opens it on the next emit — and `staleDialog` is
`true` for anything that is not the failure that was shown, so an attached agent or another session
takes a modal down rather than leaving it swallowing the close button. Identity rather than a "have I
ever shown one" flag, because `AgentSession` builds a **new** attachment per failure and a genuine
second failure has to be shown.

**Two refusals, two buttons.** `auth` offers **Log in…** (opencode only, `@lotse/core`'s `login/`, [docs/login.md](login.md)): the
agent's own browser login or an API key (kept by the agent) through a private `opencode serve`, `LoginController` (no widget) under `login-dialog.ts`; lotse
stores no credential, and `restartAgent()` makes the next prompt read the new one. Without that login (another agent,
a host opencode in a Flatpak) the dialog names `lotse auth`. `'model'`/`'quota'` offer **Choose another model**: it
opens the row's dropdown and picks nothing, and `failureAction` withholds either button when the window cannot do it.

**The permission dialog, in two halves.** `LOTSE_STANDIN_PERMISSION=1` is the *agent's* own mid-turn
`session/request_permission`, carried over the real stdio chain, with **all four option kinds on the
wire** — so a screenshot shows lotse's ordering, labels, styling and focus rules acting on the full
set the agent offered, `*_always` included. `LOTSE_APP_PERMISSION=1` is lotse's side: it puts a fixture
request through **the same gate** the agent's requests go through, so a screenshot shows the gate's
behaviour rather than a dialog built for the screenshot. It is a fallback, not a competitor, and it
waits by polling for the gate to be asked rather than for a fixed delay (`window.ts`) — a fixed delay
would either beat the agent's question or lose to it. The dialog's behaviour, the two halves and the
measured GTK facts behind it are in
[docs/dev-fixtures.md](dev-fixtures.md#the-permission-dialog); what it does and does not do is
decided in `packages/core/src/permission.ts` and tested on both runtimes, while the widget only renders.

**Lotse owns the button order** (`orderOptions`): the rank, the three orders it produces and the two
measured GTK facts that fix them are in [docs/dev-fixtures.md](dev-fixtures.md#gtk-behaviour-moved-from-agentsmd).
The rules that survive here: the first added button is the bottom one and the last added is the topmost,
so **both end slots are a decline**; `buildDialog` names `default_response` explicitly rather than letting
the add order choose it; and `show()` grabs the focus.

**The button labels** are lotse's four short sentences; the agent's own names are not on them
(captions moved to the body as `agentNames` in [docs/dev-fixtures.md](dev-fixtures.md#gtk-behaviour-moved-from-agentsmd)). A button label must fit one line.

The phone floor is 360 px (`WINDOW_MIN_WIDTH_PX` in `constants.ts`), and it is the width
`Adw.NavigationSplitView` stops at on its own — not a preference. Narrower than that the window is
unusable. [docs/dev-fixtures.md](dev-fixtures.md#gtk-behaviour-moved-from-agentsmd) has the
reproduction sweep and the cost to the config row.

## Why the test run is dual

**GJS is mandatory, not optional.** A pure Node test would be green and would not answer the real
question. Both runtimes, as in curlew and beifahrer:

- **Node**: fast, injected `Transport` and `FixtureAgent` (`app/tests/support/fixture-agent.ts`), no
  subprocess. The fixture is a real ACP peer, not a mock — it speaks the protocol including the
  inconvenient parts (a `_meta` bag it invented, a mid-turn `request_permission`, a paginated
  `session/list`), so a client that only passes against a polite peer is not tested.
- **GJS**: one integration test that proves the real stdio chain against a real agent
  (`lotse-cli test:real-agent`).

If a change makes the Node run impossible, the change is in the wrong file — that dual run is the
entire point of the `packages/acp` ↔ `app` split.
