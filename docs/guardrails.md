# Guardrails and privacy — full text

Moved from `AGENTS.md`. The short form of each rule stays there; the reasons and the incidents behind them are here so a rule is never "simplified" back into the bug.

## Privacy — this repo is PUBLIC

- The session file holds **the text of a person's conversations with an agent**. It lives at
  `$XDG_DATA_HOME/lotsman/sessions.json`, mode `0600` in a `0700` directory, **never** inside the
  repository. `.gitignore` is the second line of defence; not writing there is the first, and it
  lives in `app/src/core/paths.ts`. Backup tier: `state` — declared in `.werkstatt-state.json`.
  **Through 0.1.1 that directory was `kurier`**, so both entry points resolve their paths through
  `migratedPaths()` (`app/src/core/migrate.ts`), which renames each old directory once if the new
  name is free, never merges two of them, and keeps using the old one — out loud — when the move
  fails. Every `LOTSMAN_*` knob also answers to its `KURIER_*` spelling (`envKnob`), new name wins,
  and a pinned path turns the move off.
- There is **no `secret` tier, and adding one needs a reason.** lotsman stores no credential:
  `lotsman auth` runs the agent's own login. The agent keeps its credentials and lotsman never reads them
  back; a pasted API key (`lotsman login`, login dialog) is held in memory for one call, never written. Do not
  put a token in a session record, in a launcher `env`, or in any file here — there is no file here
  with a safe place for it.
- Test fixtures are **synthetic only**. A real session id, a real prompt or a real model reply from
  a machine's history never goes into a test.
- The transcript is a *record of what happened*, not a re-derivation of it. The agent's own
  `session/load` is the authority on history; lotsman's copy exists so `lotsman sessions` can show
  something without spawning a process. Do not add filtering to it as "protection" — a filter with
  no gate behind it is a policy in the wrong place.

## The four guardrails

1. **A session is a scope, not a permission.** A stored or bound session may never be
   pre-authorized. It says what is *reachable*; every call inside it is checked again. A session
   with "may use Troedler" is a corridor, not a key — otherwise a group chat is a handed-around
   permission key. Derived from beifahrer [ADR 0006](../beifahrer/docs/adr/0006-recipes-are-data-run-as-ordinary-calls.md).
   `assertScopeIsNotAuthority` (`gate.ts`) is the runtime canary: it throws if a persisted record
   ever grows an `allow`/`permissions`/`grants`/`capabilities`/`policy` key, because a TypeScript
   type alone cannot stop a later `{ ...session, grants: [...] }` from type-checking.
2. **Fail closed on `request_permission`.** `denyAll` remains the default `PermissionGate`; the Adwaita
   surface passes its own, which asks a person and answers `cancelled` on every path where nobody chose
   — Escape, Stop, a closing window, an agent that died, a closed dialog. Never "auto-allow because the
   agent asked". **`allow_always`/`reject_always` are passed through**, not filtered: the **agent**
   remembers an "always" (ACP has no `allowed_always` — the answer is `selected` plus the agent's own
   option id, and it decides whether to ask again), while lotsman stores no policy at all. What still
   holds is everything about *how* the choice is made: no allow option holds the focus in any frame, only
   `allow_once` is `SUGGESTED`, the terminal's `y` takes `allow_once` when both allows are offered *and
   says so on the prompt line*, and there is **no timeout** — a diff takes longer than any deadline
   lotsman could pick. **`lotsman listen` amends this** ([ADR 0002](docs/adr/0002-assistant-in-continuous-operation.md), built per [ADR 0003](docs/adr/0003-serve-tasks-questions-channel.md), `serve/gate.ts`):
   its gate answers `allow_once` only for a question the person answered yes or an area the person
   released in the task configuration, and that policy only narrows what the owning app allows. It
   strips every `*_always` option and never selects one; a yes mints one single-use token bound to
   session, tool and a digest of the call arguments; a question expires to `cancelled`. Guardrail 1
   stands: a session record never holds a grant.
3. **`fs/read_text_file` and `fs/write_text_file` are answered `false`** in the capability
   announcement, and answered a refusal error if an agent asks anyway. The agent gets no file
   access through that channel at all. File access is a decision, not a default — these two may be
   enabled later for a **canvas surface**, where lotsman would hold the real buffer and hand it over
   deliberately rather than proxying a path the agent named.
4. **`_meta` is passed through, never parsed.** `opencode acp` sends
   `_meta: {"opencode/child-session-updates": true}` and a `sessionCapabilities.fork` marker the v1
   schema does not define. Unknown `_meta` must never be an error — otherwise every agent with an
   extension lotsman doesn't know breaks.

Plus two more that are in the code, not just the plan: **no central capability registry** (not
even in gjsify — it would be exactly the gate beifahrer forbids, one level up and worse because it
looks neutral; manifest and policy stay in the app that holds the gate), and **MCP is passed
through, not known** (`newSession` forwards `mcpServers` to `session/new` as opaque objects and
never reads past `type`, so the project stays standalone-publishable and gets suite integration for
free).

