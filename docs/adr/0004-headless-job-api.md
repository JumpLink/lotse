# 4. A headless job API in `@lotse/core`

- Status: **Proposed**
- Date: 2026-10-11
- Deciders: Pascal Garber
- Related: [ADR 0001](0001-lotse-as-an-embeddable-widget.md) (its open question),
  [ADR 0003](0003-serve-tasks-questions-channel.md) (the runner this borrows from),
  [Steuererklärung ADR 0002](https://github.com/JumpLink/steuererklaerung/blob/main/docs/adr/0002-all-ai-through-lotse-and-opencode.md)
  (the first consumer), issue #46

## Context

ADR 0001 leaves one question open: one-shot AI jobs (receipt extraction, document
classification, metadata review) are not a chat, so a chat widget does not cover them. The
Steuererklärung has since decided that every AI feature goes through lotse: its one-shot jobs
run "through lotse's headless job API against the same agent, data directory and login as the
widget", with deny-all permissions, a model allow-list and output it validates itself. It names
`opencode serve` structured output (`json_schema`) as the transport, and ACP with a result-sink
tool as the fallback.

Most of what a job needs already exists: `openAgent` and `runTurn` (`run.ts`) start an agent and
run one turn; `DENY_EVERYTHING` refuses every permission request; `modelBlock` and the
`ModelPolicy` predicates (`model-policy.ts`) decide whether a prompt may reach a model;
`serve/runner.ts` pins a model and runs one unattended turn with no window. What is missing is a
function a host calls with input and gets a typed value back, or a typed failure, on GJS and Node
alike.

## Decision

1. **One function, no widget, no state of its own.** `@lotse/core` exports
   `runJob<T>(options): Promise<JobResult<T>>`. The options are `command` (an `AgentCommand`, the
   same the widget gets, so the same agent, `HOME`/`XDG_*` and login), `cwd`, `prompt`,
   `parse: (value: unknown) => T`, `modelPolicy`, and optionally `model`, `schema`, `mcpServers`,
   `gate`, `signal`, `timeoutMs`, `onLog` and `open`. It imports nothing from `gi://` and
   nothing from `@lotse/widget`. The result is `{value, sessionId, model, stopReason}`.

   *Weighed:* a `Job` class with events, as `AgentSession` has. Rejected: a job has no turns to
   show and nobody watching, and `AgentSession`'s state machine exists for a composer. A single
   awaited call is what the consumer's `LLMProvider` port already looks like.
2. **The result is the final message, parsed as JSON and validated by the host.** lotse reads the
   agent's message text after `end_turn`. It accepts exactly two shapes: the whole trimmed
   message is one JSON value, or the message's last ```` ```json ```` fenced block is. Nothing
   else is searched for: no brace hunting, no "repair". The parsed value goes through the host's
   `parse`, which throws on a mismatch (a Zod `schema.parse` fits as is; lotse does not depend on
   Zod). When the host passes `schema` (a JSON Schema object), lotse appends one fixed instruction
   with it to the prompt; validation is still `parse`'s job.

   *Weighed:* `opencode serve` `json_schema` gives the strongest guarantee, but it is a second
   protocol to one agent, it bypasses the ACP permission gate and the model gate, and it ties the
   job API to opencode. A result-sink MCP tool makes the model fill typed arguments, but lotse
   would have to host an MCP server for every job. Final text works with every ACP agent today;
   if a probe on real receipts shows it is unreliable, the result-sink tool is added behind the
   same `parse` without changing the signature.
3. **A malformed answer fails, once, with a type.** Every failure is a `JobError` with a `kind`:
   `'malformed'` (no JSON in either shape), `'invalid'` (`parse` threw), `'denied'` and
   `'unknown-model'` (the model gate), `'auth'`, `'refused'` (the turn did not end with
   `end_turn`, a permission was declined, or the agent stopped), `'timeout'`, `'cancelled'`,
   `'agent'` (the process failed). There is no automatic retry: a retry is another model call
   with private input, and that is the host's decision. The error `message` is lotse's own
   sentence and never contains the prompt or the answer; the raw answer is on the error as
   `output` for the host to inspect, and lotse never prints it.
4. **No transcript and no persistence in lotse.** A job opens a fresh agent, a fresh ACP
   session (`session/new`), runs one turn and closes. It writes no session record, no log file
   and no state; `AgentSession` and the transcript store are not involved. The agent itself may
   keep its session under the host's data directory (opencode does), which is the host's data
   directory and the host's backup, as ADR 0001 already says for the chat.
5. **The model gate is mandatory and checked before the prompt.** `modelPolicy` is a required
   option: a host that wants no restriction passes `() => 'allow'` and says so in its own code.
   When `model` is given, lotse selects it through the session's model config option, as `serve`
   does, and fails `'unknown-model'` if the agent does not offer it. Then `modelBlock` decides on
   the agent's reported current value, and both causes (`'denied'` and `'unknown'`) refuse: no
   prompt goes to a model nobody named. lotse never picks a model on its own.
6. **Permissions fail closed; nobody is asked.** The default gate is `DENY_EVERYTHING`. A host
   may pass a `PermissionGate` that allows a narrow set (its own read-only MCP tool, say);
   there is no question, no dialog and no `*_always` option. File system and terminal requests
   are refused. `mcpServers` default to `[]` and go unchanged into `session/new`.
7. **Cancellation is an `AbortSignal`; a timeout is an abort.** On abort lotse sends
   `session/cancel`, waits a short grace for the turn to settle, then closes the agent; the job
   rejects `'cancelled'`. `timeoutMs` (default 120 s, covering the handshake, `session/new` and
   the turn) aborts the same way and rejects `'timeout'`. The agent process is closed in a
   `finally` on every path, with the closer from `onSpawn`, so an abort during the handshake
   leaves no orphan.
8. **One agent process per job.** Jobs share nothing: a crash, a hung turn or a cancel touches
   one job only, and the close is exact. The cost is the agent's cold start per job. The `open`
   seam stays injectable, so a pooled opener can come later without a signature change; lotse
   sets no concurrency limit, the host does.
9. **Job input is private by default.** lotse logs ids and kinds only, as `serve.log` does: never
   the prompt, the answer, a `parse` error's text or a tool's arguments. Agent stderr reaches
   `onLog` only if the host passes one. No error message carries input.

## Consequences

- The Steuererklärung's `OpencodeProvider` calls `runJob` with its Zod schemas as `parse` and its
  own allow-list as `modelPolicy`. Its ADR 0002 names `opencode serve` structured output as the
  primary path; with this record the primary path is ACP final text, and that ADR needs the
  matching amendment.
- A job pays the agent's cold start (seconds for `opencode acp`). A batch of documents run one
  after another pays it per document.
- Final-text JSON depends on the model following the instruction; `'malformed'` and `'invalid'`
  will happen and the host shows them, never a silently cast value.
- Tests run `runJob` against `FixtureAgent` on Node and GJS: a valid answer, both shapes, a
  malformed one, a `parse` that throws, a denied and an unknown model, a declined permission,
  abort before and during the turn, and the timeout.

## Order of work

1. `runJob`, `JobError` and the tests above in `packages/core/src/job.ts`, exported from the
   barrel; a section in [docs/embedding.md](../embedding.md) and the core README.
2. A probe on demo text with a user-connected model: how often final-text JSON comes back
   malformed for the three Steuererklärung jobs. If it is not rare, add the result-sink tool.
3. The Steuererklärung moves its one-shot jobs onto `runJob` (its own PR and ADR update).
