# 8. The messenger channel as an MCP contract

- Status: **Accepted**
- Date: 2026-10-26
- Deciders: Pascal Garber
- Related: [vision](../vision.md),
  [ADR 0003](0003-serve-tasks-questions-channel.md) (the channel seam),
  [ADR 0007](0007-profiles-tasks-triggers.md),
  [docs/serve-xmpp-curlew.md](../serve-xmpp-curlew.md),
  [gjsify#2389](https://github.com/gjsify/gjsify/issues/2389) (MCP SDK v2 on GJS)

## Context

ADR 0003 put a channel seam into `lotse serve` and filled it with Curlew. In practice Lotse also
carries protocol knowledge that belongs to the messaging side: XEP-0393 styling, Curlew's length
limit and wait timeout as constants, and quote stripping for replies.

Measurement on 2026-10-26 (M3): `curlew mcp` speaks MCP protocol 2025-06-18 and offers only the
`tools` capability, no resources and no subscriptions. The messaging tools are
`send_message[account, to, text, image_url]`, `xmpp_wait_reply[account, peer, after, timeout_s,
include_bodies, reply_to]`, `conversations_list` and `conversations_get`. `xmpp_wait_reply` is a
long-poll and the only way to receive.

Three processes keep a message flowing:

1. `curlew-daemon.service` holds the XMPP connection of accounts with the `xmpp.send` grant and
   writes incoming messages into Curlew's local index.
2. `curlew mcp`, started by `lotse serve` as a child, serves that index. `xmpp_wait_reply` polls
   it every 500 ms for up to 120 s. Without the daemon it only times out.
3. `lotse serve` waits for new messages, starts a session on `/ask` and answers with
   `send_message`.

Without `lotse serve`, messages pile up in the index and nobody answers.

## Decision

1. **The messenger stays part of Lotse, but Lotse speaks no messaging protocol.** It speaks MCP
   against a documented contract. The contract is in [docs/messenger-contract.md](../messenger-contract.md).
2. **Curlew is the optional default.** Lotse has no package dependency on it. Any MCP server that
   meets the contract can take its place.
3. **Curlew never calls Lotse.** There is no AI in Curlew. The daemon receives, `curlew mcp`
   serves, `lotse serve` reacts and answers. Lotse keeps one long-running process, for receiving
   only.
4. **What moves to Curlew:** accepting Markdown on send and formatting it per protocol (XEP-0393
   for XMPP), length limits, splitting, images, and stripping quotes from replies. A tool or
   resource describes the capabilities of an account. The change is backward compatible and ships
   with its own Curlew commit and version.
5. **What stays in Lotse:** deciding whether a message is for the assistant (`/ask`, commands),
   the session, the gate, the question store and the result routing.
6. **Receiving sits behind one seam in the code.** Today the implementation behind it is the
   `xmpp_wait_reply` long-poll on MCP SDK v1. The target is `subscriptions/listen` from MCP
   2026-07-28. That needs MCP SDK v2 running on GJS, tracked in gjsify#2389. Switching replaces
   one implementation and touches no caller.
7. **Order across repos:** Curlew first, released. Then Lotse raises its pointer and deletes
   `xmpp-style.ts`, the Curlew constants (8000 characters, 120 s) and its quote stripping.

## Consequences

- Lotse shrinks. It loses its XMPP styling and its knowledge of Curlew's limits.
- A second messenger (another MCP server, another protocol) needs only the contract, not a change
  in Lotse.
- The long-poll stays a workaround. It costs a held tool call per wait and cannot report several
  conversations at once. `subscriptions/listen` removes that.
- Curlew's daemon unit description names Signal and WhatsApp only. The code also follows XMPP. A
  small Curlew commit fixes the text.
- `lotse serve` keeps its name and process until a later phase trims it to receiving.
