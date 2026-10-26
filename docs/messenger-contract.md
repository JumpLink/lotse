# The messenger contract

Lotse speaks no messaging protocol. The [messenger channel](serve.md#answering-in-a-chat-the-messenger-channel)
is an MCP client: it starts one MCP server over stdio and calls a few of its tools. Any server that
meets this page can take [Curlew](https://github.com/JumpLink/curlew)'s place
([ADR 0008](adr/0008-messenger-channel-as-mcp-contract.md)). Curlew 0.2.0 is the first one that meets
all of it.

Lotse sends Markdown and lets the server render it, split it and strip quotes. The server knows its
protocol; Lotse does not.

## Required tools

The names are settings (`sendTool`, `waitTool`, `capabilitiesTool`); the defaults are Curlew's.

| Setting | Default | Required |
|---|---|---|
| `sendTool` | `send_message` | yes |
| `waitTool` | `xmpp_wait_reply` | yes |
| `capabilitiesTool` | `messaging_capabilities` | no |

### Send

Input: `{account, to, text, format?}`.

- `format` is `"plain"` or `"markdown"`. Lotse sends `"markdown"` when the tool's input schema lists
  `format`, and omits it otherwise. With `markdown` the server renders the text for its protocol
  (XMPP: XEP-0393 styling, images from `![alt](https://…)` lines) and splits what is too long.
- Result: `originIds` (array, one id per part sent), else `originId` (one id). A reply to a part names
  that id; Lotse binds an answer to the question by it. An error result counts as not sent.

### Wait

Input: `{account, peer, after, timeout_s, include_bodies: true, strip_quotes?}`.

- `after` is an ISO 8601 time; only messages sent strictly after it come back.
- `strip_quotes: true` asks the server to remove quoted fallback text (XEP-0428) from `bodyText`.
  Lotse sends it when the input schema lists it.
- `timeout_s` is the long wait: 60 s, kept under the server's advertised `waitTimeoutS.max`.
- Result: `{status: "reply" | "timeout", messages: [{id, bodyText, sentAt, fromSelf, replyToId?}], cursor}`,
  read from `structuredContent`, else from the first text block as JSON. Cursor, seen-set and the
  one-millisecond look-back are described in [serve-xmpp-curlew.md](serve-xmpp-curlew.md#the-tool-contract).

### Capabilities (optional)

`messaging_capabilities` is read-only and takes no input. Result:

```json
{
  "protocols": [
    {
      "protocol": "xmpp",
      "accounts": ["xmpp-abc123"],
      "maxMessageChars": 4000,
      "splitAtChars": 3500,
      "formats": ["plain", "markdown"],
      "markdownRendering": "xep-0393",
      "splitsLongText": true,
      "images": true,
      "waitTimeoutS": { "default": 60, "max": 300 }
    }
  ]
}
```

Lotse reads `waitTimeoutS` of the protocol that lists the configured account (else the only entry).
The other fields are informational; whether to send Markdown follows from the send tool's input schema.

## Fallback for an older server

If the capability tool is absent, or the send tool has no `format` input, Lotse treats the server as
older than this contract:

- it sends plain text, unrendered, and does no chunking of its own;
- it waits 60 s per poll and does not strip quotes itself;
- it logs one notice per connection.

Nothing else changes, so an older Curlew keeps working, with plainer messages.

## The receive seam

Receiving sits behind one interface, `MessageSource` (`packages/core/src/messenger/source.ts`):

```ts
interface MessageSource {
  next(after: string, opts: { waitS: number; signal?: AbortSignal }): Promise<MessagePage>;
  reset(): void;
}
```

`longPollSource(link, settings)` is the implementation today: one wait-tool call per `next`.
Cursor, seen-set, retries, `/ask`, `/run` and questions live above the seam and do not depend on how
messages arrive. `receive` takes an optional `source` and defaults to the long-poll.

### Outlook: `subscriptions/listen`

The second implementation would use MCP's `subscriptions/listen` (spec 2026-07-28): the server pushes
new messages instead of Lotse polling. It needs the MCP SDK v2 on GJS, tracked in
[gjsify/gjsify#2389](https://github.com/gjsify/gjsify/issues/2389). Until then the long-poll stays the
only implementation; swapping needs a new `MessageSource` and no change above it.
