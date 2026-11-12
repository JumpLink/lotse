# ACP auth trap

Moved from `AGENTS.md` § "The two traps" (issue #15, context budget).

**`authMethods` is real and interactive.** Measured against `opencode acp` 2.0.19 (the
`authMethods` entry is in the handshake below): no `type` tag, and a `description` the schema does
not define. Without `lotsman auth` the first session dies on an error message instead of on code.
`classifyAuthMethods` (`gate.ts`) reads this as the protocol's *agent* auth method: it means the
client has to arrange the login itself, which is what `lotsman auth` runs outside the ACP channel.

**What to do about it is decided once, in `@lotsman/core`'s `auth.ts`** — `authPlan` (which of the two
paths the methods allow), `describeAuthMethods` (the handshake notice), `loginCommandFor` (the
program, the bundled copy's own) and `arrangeAuth` (ask the agent, run the login, **ask it again** —
the second handshake is the agent's own yes rather than an exit code read as one). A surface passes
in only what genuinely differs: `runLogin`, which the CLI runs with inherited stdio because a login
that opens a browser cannot open one from a pipe, and `open` for a test. It lived in
`frontends/cli/auth.ts` once, which is why the window had no way to log anyone in.

What a real agent answers — the verbatim `initialize` result of `opencode acp` 2.0.19, measured
inside one GJS process with no Node in the chain — is in
[refs/acp/SOURCE.md](../refs/acp/SOURCE.md#what-one-real-agent-answers), beside the schema.
