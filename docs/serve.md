# `lotse serve` — chat requests and questions that ask before they act

`lotse serve` is a long-running process. It answers [requests from the chat](#requests-from-the-chat)
and sends a desktop notification (or a chat message) when an agent needs a decision from you. You
answer with `lotse answer`. Time-based scheduling was removed; running a task on demand is
[`lotse run`](tasks.md). A `schedule` key left in `tasks.json` is ignored, with one notice per task. The contract
behind it is [ADR 0003](adr/0003-serve-tasks-questions-channel.md); the design it builds on is
[ADR 0002](adr/0002-assistant-in-continuous-operation.md).

```bash
lotse serve [--quiet]              # serve chat requests and questions
lotse questions [--all] [--json]   # open questions (--all: also answered, expired, cancelled)
lotse answer <id> [text…] [--dialog]  # yes/no for a permission, free text for a reply;
                                      # without text (or with --dialog) the answer window opens
```

## The task file

Tasks live in `$XDG_CONFIG_HOME/lotse/tasks.json` (`LOTSE_TASKS_FILE` overrides it), never in this
repository. Start from [examples/tasks.example.json](../examples/tasks.example.json) and keep the
file at mode `0600`; `serve` warns when it is readable by others.

- **users**: `{id, addresses}`. The desktop channel needs no address.
- **profiles**: `{id, user, agent?, model?, data, channels?, messengerDetail?}`. This is the serve binding of a profile: its person and channels. For an id that is also in [profiles.json](profiles.md), `agent`, `model` and `data` come from there and `data` may be left out; otherwise `data` is `private` or `public` and is required.
  `model` is optional: leave it out and the agent's default model applies. A private profile on a
  free model gets a note at start. That choice is yours, so `serve` does not block it.
  When the agent does not offer the pinned model, `serve` retries once after about 15 s with the same
  model and a fresh session (the agent may be refreshing its list), then fails; there is no fallback model.
- **tasks**: `{id, profile, prompt | promptFile, cwd, mcpServers, rights, released,
  questions, notify, precheck?, channels?, messengerDetail?}`. A `promptFile` resolves relative to the task file. `mcpServers` is passed to
  `session/new` unchanged. `answerMcpServers` (optional) replaces it for the turn that continues
  a reply question (`lotse answer`).

Unknown keys are errors, and every problem is reported at start.

### Editing the task file while `serve` runs

`serve` looks at the task file and its prompt files at least once a minute and
applies a change in place; there is nothing to restart.

- A **run in progress is never interrupted.** It finishes with the definition it started with. A task
  you removed is not started again, but its running instance completes; a changed task uses the new
  definition from its next run.
- **An invalid file is ignored.** `serve` keeps the previous tasks, prints the problem, writes an
  `error` entry (`kind: reload`) to `serve.log` and keeps running. Fix the file and the next pass loads
  it; the same bad save is reported once.
- Channels and agents come from `settings.json` and are read at start. A reload re-resolves each
  profile's agent, but a change to which channels are open needs a restart. The routing per task
  (`channels`, `messengerDetail`) follows the reloaded tasks.

Runs of one task never overlap, across `serve` and `lotse answer` alike.

### Precheck

`precheck: {profile?, prompt | promptFile}` is part of the task schema, but nothing runs it while
scheduling is gone; `lotse run` runs it (see [tasks](tasks.md)). It describes a cheap turn before the task, usually on a small
model, that answers one question: is there anything to do? Its last line must be `WORK` or
`NOTHING`. Only `WORK` starts the real run.

- It gets the task's `mcpServers`, always with `read` rights. It never gets `answerMcpServers` and
  never asks you a question.
- Its model comes from its own `profile`. Without one, it uses the task's profile with no model,
  so the agent's default applies.
- `NOTHING` records outcome `nothing` in `runs.json`, which is not `done`. A missing verdict or a
  failed precheck records `failed`, and the task does not run.

lotse puts one line in front of the precheck prompt: the time and outcome of the task's last run
from `runs.json`, or that it has not run before. Compare against it, for example: "WORK if a message
is newer than the last run or the last run failed, else NOTHING."

### Rights

- `read`: every permission request is declined, and no question is asked.
- `confirm` (default): every permission request becomes a question to you.
- `released`: the areas in `released` (`{tool, kind?}`, exact tool title) are allowed once per
  call; anything else becomes a question.

lotse strips every `allow_always`/`reject_always` option and never selects one.

### Question limits

`questions: {expiresIn, maxOpen, maxPerHour}`, defaults `12h`, `3`, `6`. A task at its ceiling is
skipped before an agent starts.

`notify: "questions"` (default) notifies only when the agent asks. `"always"` also sends the
run's final message.

### Which channels a task uses

By default every message goes to every active channel. Two optional keys narrow that, on a profile
for all its tasks or on a task. A task can only narrow its profile, never widen it:

- `channels`: a non-empty list of `desktop` and `messenger`. The task's messages go only there.
  With a list on both, the task gets the channels in both. A channel the profile excludes stays
  excluded when a task names it, and `serve` says so at start. A reply in the chat cannot answer a
  question that was not sent to the chat. When none of the remaining channels is active, `serve`
  says so at start; the questions are then in `lotse questions` only.
- `messengerDetail`: `full` (default) sends the question to the chat. `notice` sends only its id
  and that a question waits in the task, without the question text or the run's message. Read it
  with `lotse questions` or on the desktop; you can still answer in the chat with its id. `notice`
  on the profile or the task wins; a task cannot set `full` over a profile's `notice`.

Use them for tasks that handle private data when the messenger path is not end-to-end encrypted.
Two things they do not cover: the desktop answer window can answer any question whatever its
`channels` (a local, trusted path), and a notice still names the task id, so pick neutral task ids
when an id would name something private.

## Question → answer → resume

1. **Permission questions.** The agent asks for a tool the rights do not cover. You get a notification
   with an id such as `#A1`, and the run waits. `lotse answer A1 yes` (or `ja`, `ok`, `no`, `nein`)
   decides it; a yes allows that one call with those arguments, once. An unanswered question
   expires to `cancelled`. If the run ends or `serve` restarts first, the question is cancelled too,
   and a later yes allows nothing.
2. **Reply questions.** A turn that ends normally with a last line ending in `?` becomes a
   question. `lotse answer A2 <text>` continues the session: `session/load`, else `session/resume`,
   else a new session that carries the question and your answer as context. The command says which
   one it used. The agent's reply goes to stdout.

Write prompts so that an agent that needs you ends its message with a question.

**Propose first, write after the yes.** Give the first turn a read-only MCP server in `mcpServers`
and the writing one in `answerMcpServers`: the agent proposes a whole batch in one reply question, and
the write tools exist only in the turn that your answer starts. Nothing depends on the model keeping
a promise or on the agent asking permission for an MCP tool.

### When only you can continue: `person_needed`

A task with `personNeeded: {enabled: true, timeoutMin?}` gets an MCP tool, `person_needed`, served by
`serve` itself on 127.0.0.1 (a random path per run, never written to disk). The agent calls it when a
step is yours alone, for example a beifahrer recipe that returns `status: "needs_person"`:

```
person_needed({kind: "login"|"code"|"approval"|"device", origin, prompt, acceptsCode, link?, timeoutMin?})
  → {outcome: "done" | "code" | "timeout" | "declined", code?}
```

You get "I need you: <origin> wants <kind>." through every channel and a `person` question (`#A3`).
The run waits (default 30 min; the call's `timeoutMin`, else the task's `personNeeded.timeoutMin`, else
Preferences → "Wait for you", `lotse messenger --person-needed-minutes`).

- Reply `done` (`fertig`): you did it yourself → `done`. `no` → `declined`.
- With `acceptsCode: true` you may reply with the code (4–10 letters or digits) → `code`, and the agent
  enters it. The code lives only in `serve`'s memory: never in the question store, the log, a transcript or a
  message from lotse (`••••`).
- With `link` (a login QR code's content, from `person.link`) the message carries "Open or scan this: <link>".
  It is a session challenge: it goes into the message only — not into the question store or the log — and,
  like a code, is refused on a free or hosted-for-free model.
- No reply in time → `timeout`. The run goes on without you and the question stays open as *deferred*:
  `lotse questions` lists it. A later `done` continues the session; a late code is refused.

Prompt it like this:

> If a beifahrer `recipe_run` returns `needs_person`, call `person_needed` with its `person` fields
> (`acceptsCode` from `person.acceptsCode`, `link` from `person.link` when there is one). On `done`, `recipe_run` again with `from: <next>`. On `code`,
> the same with the code as the param named `person.codeParam`. On `timeout` or `declined`, stop and
> report what is still open. Never call it twice in a row.

Rules: only one waiting call per conversation. A task that may receive a code or a link must not run on a free or
hosted-for-free model, and the profile must name its model; otherwise the call is refused with a clear
error. The deferred item reaches the daily reminder task only if its prompt reads `lotse questions`
(the reminder MCP has no write tool).

## Where the state lives

`$XDG_STATE_HOME/lotse/` (`LOTSE_STATE_DIR` overrides it), mode `0600` in a `0700` directory:
`questions.json`, `runs.json` (last run, outcome, precheck verdict and session per task; outcome is
`done`, `asked`, `declined`, `nothing`, `skipped` or `failed`), `serve.log` (JSON lines, ids and
kinds only, never a prompt or a reply — the one exception is `run-summary`: the final message of a task run, flattened and cut to 300 characters), `pending-requests.json` (ids and times of chat requests not yet answered, never their text) and `locks/`. Closed questions are kept for 7 days.

## Running it as a service

[data/lotse-serve.service](../data/lotse-serve.service) is an example systemd user unit. Nothing
installs it; the install commands are in its header. An edit to the task file is picked up by the
running service; `systemctl --user restart lotse-serve` is only needed for a change to `settings.json`.

## Channels

Messages go through one `ServeChannel` (`packages/core/src/serve/channel.ts`): a desktop
notification over `org.freedesktop.Notifications` (stderr when there is no session bus), and the
messenger channel below. `channel.active` in the settings file picks which ones ask, and with both
active a question goes to both, unless the task narrows it
([Which channels a task uses](#which-channels-a-task-uses)). The first answer wins: every answer
ends in `answerQuestion`, so the other channel is told the question is already answered.

### Answering from the desktop

When the notification server can show actions (`GetCapabilities` lists `actions`), a question's
notification gets buttons: **Answer…** (and a click on the notification itself) opens the answer
window; a permission question also gets **Allow once** and **Decline**. A button answers through the
same `answerQuestion` as `lotse answer <id> yes|no`, so the run that waits picks it up as before. A
server without actions gets the plain notification, whose text still names `lotse answer`.

Every notification carries the `desktop-entry` hint `eu.jumplink.Lotse`, so the shell files them
under one "Lotse" app instead of one source per process. That only works where the desktop entry is
installed (`npm run packaging:install`). Only questions stay in the notification list; reports are
transient and show as a banner only.

The answer window shows the task, the question (selectable, scrolls when it is long) and when it
expires. A reply question gets a text field; a permission question gets only its two buttons.
<kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends, <kbd>Esc</kbd> or **Later** closes it and leaves the
question open. `lotse answer <id>` with no text opens the same window, and `--dialog` asks for it
explicitly; without a display the command says so and nothing opens.

`channel.desktop.mode` in the settings file (`$XDG_CONFIG_HOME/lotse/settings.json`, also under
*Preferences → Questions* in the app) picks how a question arrives:

```json
{ "version": 1, "agent": null, "channel": { "desktop": { "mode": "dialog" } } }
```

- `notification` (default): the notification with its buttons.
- `dialog`: the answer window opens right away. Without a display, or without the window, the
  notification is sent instead.

`serve` reads the setting for every question, so a change needs no restart; it lives in the settings
file rather than the task file because channels are opened once, at start.

The window is part of the GUI bundle (`lotse-app.gjs.mjs`, built by `gjsify workspace lotse-cli
build:app`) and is looked up next to the CLI bundle, else as `lotse-app` beside it.
`LOTSE_ANSWER_DIALOG` names another program (split on spaces); it is started with
`--answer <id>` and writes one line `lotse-answer:{"text":…}` on stdout, or nothing for Later.

### Answering in a chat (the messenger channel)

Everything sent to the chat goes through one renderer: Markdown becomes XEP-0393 styling (`**x**` and
headings → `*x*`, `*x*` → `_x_`, lists → `• `, `[t](url)` → `t: url`, code and fences unchanged). A line that is
only `![alt](https://…)` splits the message: the text before it, the image as its own message through the
send tool's `image_url` (curlew shows it inline), then the rest, in order — at most 8 images per message.
If the server refuses `image_url`, the image goes out as a plain link instead.

lotse speaks no XMPP. The channel is an MCP client: it starts the configured MCP server (curlew's
`curlew mcp` by default) over stdio, sends a question with the server's send tool, and long-polls its
wait-for-reply tool for the answer. Any MCP server with those two tools fits; their names are settings.

```json
{
  "version": 1,
  "agent": null,
  "channel": {
    "active": ["desktop", "messenger"],
    "messenger": {
      "command": "curlew",
      "args": ["mcp"],
      "account": "xmpp-abc123",
      "peer": "person@example.org",
      "sendTool": "send_message",
      "waitTool": "xmpp_wait_reply"
    }
  }
}
```

`command`, `args`, `sendTool` and `waitTool` show their defaults; `account` and `peer` have none.
`account` is the messenger account to send from (for curlew its account id, not the address), `peer`
the address to talk to. No secret belongs in
`args` (the settings file refuses secret-looking keys). The same fields are under *Preferences →
Messenger* in the app. `serve` reads `active` and `messenger` once at start, so **restart `serve`
to apply a change**. Incomplete settings (no account or peer) are reported at start and `serve` runs
with the desktop channel alone.

For curlew, three things must hold ([XMPP via Curlew](serve-xmpp-curlew.md) is the step-by-step
guide, with the tool contract and a round-trip test):

- `curlew daemon` is running; replies only arrive while it is.
- The account may send. Add a grant to curlew's configuration:
  `{"capability":"xmpp.send","target":"<account>/<address>"}` (same account and peer as above).
- `curlew mcp` is on `PATH` (inside the Flatpak, on the host: lotse starts it through
  `flatpak-spawn --host`).

A question arrives as one message whose first line carries the id, with a reply hint:

```
lotse · backup · #A3

Allow rm -rf build/?

Reply: #A3 yes or #A3 no
```

Replies are read like `lotse answer`:

- `A3 yes` or `#A3 only the first one`: answers that question.
- Plain text while exactly one question is open **in this chat**: answers it, no id needed. Questions
  kept off the chat (`channels`, `notice`) do not count as open here.
- Plain text while several are open: nothing is answered; lotse replies with the open ids only.
- An unknown or already answered id: lotse replies with that.
- A permission question takes `yes`, `no`, `ja`, `nein`, `allow`, `decline` (and `deny`); anything
  longer is refused with a reply.

#### Reply to the question's message

Use your messenger's *Reply* on the question's message: the answer then belongs to **that** question,
whatever else is open. This beats the rules above (one open question, several open) but not an id you
type yourself (`#A1 yes` still answers `#A1`). The quote the messenger puts before your text is dropped.

- lotse keeps the id the send tool returned (`originId`) for each question message in
  `messenger-refs.json` in the state directory (message id, user and question id, never a text; the
  last 200), and matches it against the `replyToId` the wait tool returns.
- A reply to the message of a question that is already settled, expired or kept off the chat is told so
  ("#A1 is already answered."); it is never applied to another question.
- A reply to any other message, or one the server gives no `replyToId` for, is read by its text as before.

The deadline ("Valid until Tue, 10/13, 18:14") is shown in the machine's local time and locale. The
chat hears a short "Got it, #A1." after an answer; how the session was continued goes to the log, not
the chat. A reply the server delivers without a timestamp is still read, and the cursor moves to the
result's cursor.

The position in the conversation is kept in `messenger-cursor.json` in the state directory, so a
restart neither replays old replies nor loses one. The first start begins at "now". If the MCP
server dies, `serve` restarts it with a growing pause (5 s up to 5 min). A channel that fails while another one
delivers is never silent: `serve` prints `<channel>: <error>` on stderr and writes an `error` entry
(channel, kind, message) to `serve.log`. A question the messenger could not send is sent again by the
receive loop after 30 s, 1, 2, 5 and 10 min, while it is still open; after the last try `serve` says
it gave up (`lotse questions` still lists it). The retry list lives in memory, so a restart of
`serve` drops it. lotse adds no encryption of its own: a
question is as private as the messenger path it travels, and it names the task and the action. To
keep a task's questions out of the chat, set its `channels` or `messengerDetail: "notice"`.

The position is a time plus the ids of the messages already read at that millisecond, so two
messages sent in the same millisecond are both read even when the server lists them in different
polls (`{"cursor": "…", "seen": ["…"]}`; a file with `cursor` alone still reads). Handling a reply
never waits for an agent: an answer that continues a session runs beside the receive loop, and the
next message is read at once.

### Requests from the chat

With `channel.messenger.requests.enabled`, a message that answers no question starts an agent
session, and its final answer comes back over the same chat. It is off by default.

Which message is a request is decided without a model, in this order:

1. A message that starts with the `prefix` (default `/ask`, any case; a prefix ending in a letter or
   digit must be followed by a space or the end) is **always** a new request, never an answer. The
   bare prefix gets a short "what should I do?".
2. Otherwise the message is read as a reply, exactly as above.
3. When that finds **no open question in this chat**, the message is a request — unless it is a bare
   yes or no (`yes`, `ja`, `nein`, `decline`, …), which still hears "No question is waiting".

So with one question open, plain text answers it (rule 2); a request then needs the prefix. A
message that starts like an id (`A4 …`) is read as one. With `enabled: false` nothing of this applies
and replies work as before.

**Follow-ups.** For `followUpMinutes` after an answer reached the chat, a request without the prefix
continues that session (`session/load`, else `session/resume`). A request with the prefix always
starts a new one. After the window, or when the session can no longer be continued, a new session
starts and the answer says so first.

**Runs never block the chat.** At most `maxConcurrent` requests run at a time; another one is queued
and hears "Busy with another request; yours is queued (position n)". Two follow-ups of one session
never run at once. A long answer is sent as up to three numbered messages of at most 1,500
characters; beyond that the last is cut short with a note.

```json
"messenger": {
  "…": "…",
  "requests": {
    "enabled": true,
    "prefix": "/ask",
    "profile": "assistant",
    "preamble": "Answer briefly; the reply is read on a phone.",
    "cwd": "",
    "mcpServers": [{ "name": "calendar", "command": "reminder", "args": ["mcp"] }],
    "rights": "read",
    "followUpMinutes": 30,
    "maxConcurrent": 1
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Requests on or off. |
| `prefix` | `/ask` | Marks a message as a new request. |
| `profile` | — | A profile id of `tasks.json`: agent, model, user. Required when enabled. |
| `preamble` | `""` | Put before the first message of a new session. |
| `cwd` | `""` | The session's working directory; empty: the home directory. |
| `mcpServers` | `[]` | Stdio MCP servers the session gets (`name`, `command`, `args`, optional `env` as `[{name, value}]` like tasks.json; a credential-looking name is refused). |
| `rights` | `read` | `read`: every permission request is declined, nothing is asked. `confirm`: each one becomes a question in the chat (and on the desktop), and a write needs your yes. |
| `followUpMinutes` | `30` | How long after an answer a plain message continues that session; `0`: never. |
| `maxConcurrent` | `1` | Requests running at the same time. |

Set them from the CLI with `lotse messenger` (without flags it shows them):

```sh
lotse messenger --requests on --request-profile assistant --request-rights confirm \
  --request-mcp-server 'calendar=reminder mcp; mail=curlew mcp' --follow-up-minutes 30
```

The other flags are `--request-prefix`, `--request-preamble`, `--request-cwd` and
`--max-concurrent`; `--request-mcp-server none` clears the list. `--request-mcp-env 'calendar:NAME=value; …'` sets the servers' environment (`none` clears it); setting servers again keeps the env of servers with the same name. The same fields are under
*Preferences → Requests from the chat*. A running `serve` applies a change within a minute, like tasks.json: a request in progress finishes as it was started, new messages use the new settings, and a `reload` entry is logged. A profile `tasks.json` does not define is reported, and the chat then answers questions only.

Requests accepted and not yet answered are noted in `pending-requests.json`. If `serve` dies meanwhile, its next start tells the chat once "not completed, please send it again"; it never re-runs a request, since it may already have written something.

`serve.log` gets a `request` entry when a request is queued, starts and ends (request number,
profile, `new`/`loaded`/`resumed`/`fresh`, outcome, session id, number of messages sent) and an
`error` entry (`phase: request`) when a run throws — never what was asked or answered. A request
runs as the synthetic task `@chat` (no `run-summary`).
