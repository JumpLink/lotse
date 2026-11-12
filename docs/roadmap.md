# Roadmap and non-goals

Moved from `AGENTS.md` (issue #15, context budget). What is deliberately not built yet, and where
the decision lives.

- **A web surface** — not adwaita-web, which is the browser path per beifahrer [ADR
  0008](adr/0008-messenger-channel-as-mcp-contract.md).
- **Telegram bot** — becomes a Curlew backend.
- **The XMPP channel for `lotsman listen`** — the `Channel` seam is there, curlew is not wired.
- **MCP wiring against the real apps and the principal policy beyond one task's rights** — decided
  in [ADR 0002](adr/0002-assistant-in-continuous-operation.md), not built.
- **Troedler integration**.
- **A Claude Code adapter** — decided, not built; terms and billing: [claude-code.md](claude-code.md).

See also the non-goals in [docs/vision.md](vision.md): no agent or model of Lotsman's own, no package
dependency on Curlew or any other suite app, no messaging protocol inside Lotsman, no scheduler, no
open HTTP port, no trigger-borne permission, no user systemd units.
