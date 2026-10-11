# Answering `lotse serve` over XMPP with Curlew

This guide wires the [messenger channel](serve.md#answering-in-a-chat-the-messenger-channel) to
[Curlew](https://github.com/JumpLink/curlew): a bot account sends each question to your own XMPP
address, and you answer from any XMPP client on your phone or desktop. lotse speaks no XMPP itself;
it starts `curlew mcp` and calls two of its tools.

> **Warning: the chat is not end-to-end encrypted.** Curlew does not implement OMEMO, so a question
> travels as plain text through both XMPP servers. A question names the task and the action, and a
> reply question carries whatever the agent wrote. Every active channel gets every question, from
> every task: there is no per-task channel choice. Turn the messenger on only when no task can ask
> about data you would not send in plain text, or when the whole path is under your control.

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
| `sendTool` | `{account, to, text}` | anything; an error result counts as not sent |
| `waitTool` | `{account, peer, after, timeout_s: 60, include_bodies: true}` | `{status: "reply" \| "timeout", messages: [{bodyText, sentAt, fromSelf}], cursor}` |

`after` is an ISO 8601 time: on the first start, the time `serve` started, and from then on the
`sentAt` of the last handled message, kept in `messenger-cursor.json`. A message with `fromSelf: true`
is skipped. lotse reads the result from `structuredContent`, else from the first text block as JSON.

## Test the round trip

1. Start `lotse serve` and check that its first lines say `questions via desktop + messenger` and
   name no `messenger:` error.
2. Add a task that touches nothing and ends with a question, for example:

   ```json
   {
     "id": "messenger-test",
     "profile": "<a profile>",
     "schedule": { "every": "1d" },
     "prompt": "Reply with exactly one line: 'Messenger test: reply with any word?'",
     "cwd": "/tmp",
     "mcpServers": [],
     "rights": "read"
   }
   ```

   Saving the task file stops `serve`; start it again. The task has never run, so it waits for its
   first due time; `lotse serve --once` in a second terminal runs it right away without the receive
   loop.
3. The question arrives in your XMPP client as `lotse · messenger-test · #A1`. Reply `#A1 hello`.
4. Within about a minute lotse answers in the chat that it resumed the session, and
   `lotse questions --all` shows the question as answered.

If the question arrives but the answer does not, check that `curlew daemon` is running. If nothing
arrives, check the grant (the account id and the address must match exactly) and `serve`'s stderr.
Remove the test task when you are done.
