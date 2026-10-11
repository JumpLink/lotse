# `lotse serve` — scheduled tasks that ask before they act

`lotse serve` is a long-running process. It runs agent tasks on a schedule and sends a desktop
notification when an agent needs a decision from you. You answer with `lotse answer`. The contract
behind it is [ADR 0003](adr/0003-serve-tasks-questions-channel.md); the design it builds on is
[ADR 0002](adr/0002-assistant-in-continuous-operation.md).

```bash
lotse serve [--once] [--quiet]     # run due tasks; --once runs what is due now and exits
lotse questions [--all] [--json]   # open questions (--all: also answered, expired, cancelled)
lotse answer <id> [text…] [--dialog]  # yes/no for a permission, free text for a reply;
                                      # without text (or with --dialog) the answer window opens
```

## The task file

Tasks live in `$XDG_CONFIG_HOME/lotse/tasks.json` (`LOTSE_TASKS_FILE` overrides it), never in this
repository. Start from [examples/tasks.example.json](../examples/tasks.example.json) and keep the
file at mode `0600`; `serve` warns when it is readable by others.

- **users**: `{id, addresses}`. The desktop channel needs no address.
- **profiles**: `{id, user, agent?, model?, data}`. `data` is `private` or `public` and is required.
  `model` is optional: leave it out and the agent's default model applies. A private profile on a
  free model gets a note at start. That choice is yours, so `serve` does not block it.
- **tasks**: `{id, profile, schedule, prompt | promptFile, cwd, mcpServers, rights, released,
  questions, notify, precheck?}`. A `promptFile` resolves relative to the task file. `mcpServers` is passed to
  `session/new` unchanged. `answerMcpServers` (optional) replaces it for the turn that continues
  a reply question (`lotse answer`).

Unknown keys are errors, and every problem is reported at start. `serve` reads the file once. When
the file or a prompt file changes, it stops with exit 0 and tells you; restart it to load the edit.

### Schedules

- `{"every": "30m"}`: units `m`, `h`, `d`, at least `1m`.
- `{"at": "07:30", "days": ["mon", "fri"]}`: local time; no `days` means every day. A run missed
  while `serve` was down fires once on start. A task that has never run waits for the next time.

Runs of one task never overlap, across `serve` and `lotse answer` alike.

### Precheck

`precheck: {profile?, prompt | promptFile}` runs a cheap turn before the task, usually on a small
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

## Where the state lives

`$XDG_STATE_HOME/lotse/` (`LOTSE_STATE_DIR` overrides it), mode `0600` in a `0700` directory:
`questions.json`, `runs.json` (last run, outcome, precheck verdict and session per task; outcome is
`done`, `asked`, `declined`, `nothing`, `skipped` or `failed`), `serve.log` (JSON lines, ids and
kinds only, never a prompt or a reply) and `locks/`. Closed questions are kept for 7 days.

## Running it as a service

[data/lotse-serve.service](../data/lotse-serve.service) is an example systemd user unit. Nothing
installs it; the install commands are in its header. `Restart=on-failure` does not restart the clean
stop after a config change, so `systemctl --user restart lotse-serve` applies an edit.

## Channels

Messages go through one `ServeChannel` (`packages/core/src/serve/channel.ts`): a desktop
notification over `org.freedesktop.Notifications` (stderr when there is no session bus), and the
messenger channel below. A task never names a channel; `channel.active` in the settings file picks
which ones ask, and with both active a question goes to both. The first answer wins: every answer
ends in `answerQuestion`, so the other channel is told the question is already answered.

### Answering from the desktop

When the notification server can show actions (`GetCapabilities` lists `actions`), a question's
notification gets buttons: **Answer…** (and a click on the notification itself) opens the answer
window; a permission question also gets **Allow once** and **Decline**. A button answers through the
same `answerQuestion` as `lotse answer <id> yes|no`, so the run that waits picks it up as before. A
server without actions gets the plain notification, whose text still names `lotse answer`.

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
file rather than the task file because a change to the task file stops `serve`.

The window is part of the GUI bundle (`lotse-app.gjs.mjs`, built by `gjsify workspace lotse-cli
build:app`) and is looked up next to the CLI bundle, else as `lotse-app` beside it.
`LOTSE_ANSWER_DIALOG` names another program (split on spaces); it is started with
`--answer <id>` and writes one line `lotse-answer:{"text":…}` on stdout, or nothing for Later.

### Answering in a chat (the messenger channel)

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
      "account": "assistant",
      "peer": "person@example.org",
      "sendTool": "send_message",
      "waitTool": "xmpp_wait_reply"
    }
  }
}
```

`command`, `args`, `sendTool` and `waitTool` show their defaults; `account` and `peer` have none.
`account` is the messenger account to send from, `peer` the address to talk to. No secret belongs in
`args` (the settings file refuses secret-looking keys). The same fields are under *Preferences →
Messenger* in the app. `serve` reads `active` and `messenger` once at start, so **restart `serve`
to apply a change**. Incomplete settings (no account or peer) are reported at start and `serve` runs
with the desktop channel alone.

For curlew, three things must hold:

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
- Plain text while exactly one question is open: answers it.
- Plain text while several are open: nothing is answered; lotse replies with the open ids.
- An unknown or already answered id: lotse replies with that.
- A permission question takes `yes`, `no`, `ja`, `nein`, `allow`, `decline` (and `deny`); anything
  longer is refused with a reply.

The position in the conversation is kept in `messenger-cursor.json` in the state directory, so a
restart neither replays old replies nor loses one. The first start begins at "now". If the MCP
server dies, `serve` restarts it with a growing pause (5 s up to 5 min). There is no receive loop in
`serve --once`: that run ends before anyone could reply. A channel that fails while another one
delivers is never silent: `serve` prints `<channel>: <error>` on stderr and writes an `error` entry
(channel, kind, message) to `serve.log`. A question the messenger could not send is sent again by the
receive loop after 30 s, 1, 2, 5 and 10 min, while it is still open; after the last try `serve` says
it gave up (`lotse questions` still lists it). The retry list lives in memory, so a restart of
`serve` drops it. lotse adds no encryption of its own: a
question is as private as the messenger path it travels, and it names the task and the action.
