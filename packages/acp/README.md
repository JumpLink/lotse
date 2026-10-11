# @lotse/acp

The [Agent Client Protocol](https://agentclientprotocol.com) from the client side: the wire types
(generated against `refs/acp/schema.v1.json`), the JSON-RPC 2.0 codec, the client session lifecycle,
and the gate that answers what an agent may ask of a client.

Pure TypeScript with **no dependencies, no `spawn`, no `gi://`** — the transport is an injected
interface, so the same code runs on GJS and on Node.

Licence: **LGPL-3.0-or-later** (`LICENSE`, `COPYING` in this directory).

```bash
npm i @lotse/acp
```

The package ships TypeScript sources; consume it with a bundler that compiles `.ts` (gjsify, esbuild,
rolldown). Part of [lotse](https://github.com/JumpLink/lotse); see the
[package layout](https://github.com/JumpLink/lotse/blob/main/AGENTS.md#package-layout--and-the-one-rule-that-holds-it-together).
