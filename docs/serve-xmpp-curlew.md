# Answering `lotse serve` over XMPP with Curlew

This guide wires the [messenger channel](serve.md#answering-in-a-chat-the-messenger-channel) to
[Curlew](https://github.com/JumpLink/curlew): a bot account sends each question to your own XMPP
address, and you answer from any XMPP client on your phone or desktop. lotse speaks no XMPP itself;
it starts `curlew mcp` and calls two of its tools.

> **Warning: the chat is not end-to-end encrypted.** Curlew has no OMEMO yet
> ([JumpLink/curlew#76](https://github.com/JumpLink/curlew/issues/76)), so a question travels as
> plain text through both XMPP servers. A question names the task and the action, and a reply
> question carries whatever the agent wrote. For tasks that touch private documents, send a
> notice instead of the question, or keep the messenger out of the task: see
> [Keep private tasks out of the chat](#keep-private-tasks-out-of-the-chat).

## What you need

- Two XMPP accounts: one for the bot (for example `bot@example.org`) and your own
  (`person@example.org`). Your server must keep a message archive (MAM); Curlew refuses one without.
- Curlew built or installed, with the bot account added:

  ```bash
  curlew backends enable xmpp
  curlew accounts add xmpp                # the bot's JID and password
  curlew accounts list --backend xmpp     # prints the account id, e.g. xmpp-abc123
  ```

  lotse's `account` setting and Curlew's grant both use this **account id**, not the JID.

## One grant

Add one grant to Curlew's configuration (`$XDG_CONFIG_HOME/curlew/config.json`):

```json
{ "grants": [{ "capability": "xmpp.send", "target": "xmpp-abc123/person@example.org" }] }
```

That is all the messenger channel needs. `send_message` (questions and lotse's short replies such as
"answered") requires it, for that exact account and address. `xmpp_wait_reply` reads Curlew's local
index and needs no grant. Without the grant, `curlew mcp` does not list `send_message`, every send
fails, and `serve` prints the error on stderr and in `serve.log`.

## Keep `curlew daemon` running

`xmpp_wait_reply` only sees what is in Curlew's index, and `curlew daemon` is what puts a reply
there: it follows every XMPP account named by an `xmpp.send` grant, with carbons and an archive
catch-up after each reconnect. Without a running daemon every wait times out, so questions go out
but answers never come back. Run it as a service (Curlew ships a systemd user unit) and restart it
after you edit the grants: the daemon reads them once at start.

## The lotse settings

In `$XDG_CONFIG_HOME/lotse/settings.json` (or *Preferences → Messenger*):

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

When Curlew is not on `PATH`, `command` and `args` may start it any other way, for example from a
checkout: `"command": "gjsify", "args": ["run", "/path/to/curlew/app/dist/curlew.gjs.mjs", "mcp"]`.
Restart `serve` after any change to these settings.

## The tool contract

Any MCP server that offers these two tools works in Curlew's place:

| Call | Arguments lotse sends | Result lotse reads |
|---|---|---|
| `sendTool` | `{account, to, text}` | `originId`, the id a reply to that message will name (optional); an error result counts as not sent |
| `waitTool` | `{account, peer, after, timeout_s, include_bodies: true}` | `{status: "reply" \| "timeout", messages: [{id, bodyText, sentAt, fromSelf, replyToId?}], cursor}` |

`replyToId` is the id of the message a message replies to (XEP-0461); Curlew also removes the quoted
fallback text (XEP-0428) from `bodyText`. See [Reply to the question's message](serve.md#reply-to-the-questions-message).

`after` is an ISO 8601 time: on the first start, the time `serve` started, and from then on the
`cursor` the wait tool returned (else the `sentAt` of the last handled message), kept in
`messenger-cursor.json`. The tool must return only messages sent strictly after `after`. A message
with `fromSelf: true` is skipped. lotse reads the result from `structuredContent`, else from the
first text block as JSON.

`timeout_s` is 60 for the long wait. Two messages can share a millisecond, and a server may list the
second one only in a later poll, after the cursor already reached that time. So lotse remembers the
`id` of every message read at the cursor's millisecond, and before each long wait it looks once, with
`after` one millisecond earlier and `timeout_s: 0` (return at once), for a message of that
millisecond it has not read yet. A server without `id` works too: lotse then tells messages apart by
a hash of `sentAt` and the text, so two identical texts in one millisecond count as one.

With [requests from the chat](serve.md#requests-from-the-chat) on, a message that answers no question
starts an agent session, and the answer comes back through `sendTool`. A request that should reach
Curlew's own tools (or another server) names it in `requests.mcpServers`.

## Keep private tasks out of the chat

By default every active channel gets every question. Two keys narrow that per task or per profile
(details: [Which channels a task uses](serve.md#which-channels-a-task-uses)):

- `messengerDetail: "notice"` sends the chat only the question id and that a question waits in the
  task. Read the question with `lotse questions` or on the desktop; you can still answer in the chat
  with its id.
- `channels: ["desktop"]` leaves the messenger out of the task entirely.

```json
{
  "id": "inbox-review",
  "profile": "assistant",
  "prompt": "Sort the new documents and ask before you change anything.",
  "cwd": "/tmp",
  "mcpServers": [],
  "rights": "read",
  "channels": ["desktop", "messenger"],
  "messengerDetail": "notice"
}
```

Replace `assistant` here and below with your profile's id. A task can only narrow its profile:
`channels` is the overlap of both lists, and a `notice` on the
profile stays a `notice` whatever the task says. The notice still names the task id, so pick a
neutral id.

Buttons for answering in the chat are planned
([JumpLink/lotse#65](https://github.com/JumpLink/lotse/issues/65),
[JumpLink/curlew#81](https://github.com/JumpLink/curlew/issues/81)). Text answers stay the fallback.

## Test the round trip

1. Start `lotse serve` and check that its first lines say `questions via desktop + messenger` and
   name no `messenger:` error.
2. Add a task that touches nothing and ends with a question, for example:

   ```json
   {
     "id": "messenger-test",
     "profile": "assistant",
     "prompt": "Reply with exactly one line: 'Messenger test: reply with any word?'",
     "cwd": "/tmp",
     "mcpServers": [],
     "rights": "read"
   }
   ```

   A running `serve` picks up the saved task file within a minute, with no restart. Nothing runs the task by itself;
   start it with `lotse run messenger-test`.
3. The question arrives in your XMPP client as `lotse · messenger-test · #A1`. Reply `#A1 hello`.
4. Within about a minute lotse answers in the chat with a short "Got it, #A1.", and
   `lotse questions --all` shows the question as answered.

If the question arrives but the answer does not, check that `curlew daemon` is running. If nothing
arrives, check the grant (the account id and the address must match exactly) and `serve`'s stderr.
Remove the test task when you are done.
