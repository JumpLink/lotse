# Custom providers: local models and any OpenAI-compatible endpoint

Status: **the core (`@lotse/core`, `custom/`) and `lotse provider` exist; the widget's settings group is
[#45](https://github.com/JumpLink/lotse/issues/45).** Design decided in
[#17](https://github.com/JumpLink/lotse/issues/17). Measured on opencode 2.0.25, 2026-10-11.

## What it is

A provider opencode does not ship (Ollama, LM Studio, llama.cpp, vLLM, a company gateway) added as an
`@ai-sdk/openai-compatible` entry in opencode's config. That adapter is the only one lotse writes: every
local server speaks it, and one adapter keeps the written shape small enough to validate.

## Where it is written

Only into the **bundled** opencode, into a file of lotse's own:
`<dataDir>/agents/opencode/config/lotse-providers.json` (file `0600`, directory `0700`, written atomically).
`bundledCommand` points `OPENCODE_CONFIG` at it (`customProvidersEnv`). A host's own opencode keeps its
providers in `~/.config/opencode`, which lotse never edits; `lotse provider list` still shows them, marked
with the file they come from.

The written v2 shape, per provider:

```json
{ "providers": { "local-ollama": {
  "name": "Ollama",
  "package": "aisdk:@ai-sdk/openai-compatible",
  "settings": { "baseURL": "http://127.0.0.1:11434/v1" },
  "models": { "qwen3:4b": { "name": "qwen3:4b", "limit": { "context": 8192, "output": 4096 } } }
} } }
```

`limit` is written only when a context is given; `output` is `min(4096, context / 2)`.

## Keys

**Never in a file, the state or argv.** A key goes to opencode through
`POST /api/integration/{id}/connect/key` and lives in opencode's store. `lotse provider add --key` reads
it from stdin. `remove` deletes the credentials first (ids from the provider's `connections` in
`GET /api/integration/{id}`, never from `GET /api/credential`, which answers raw keys), then the entry.

## Rules (`planCustomProvider`)

| Endpoint | Answer |
|---|---|
| `https://…`, or `http://` on loopback (`127/8`, `::1`, `localhost`) | accepted |
| `http://` on the local network (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`, a bare hostname, `.local`, `.lan`, `.home.arpa`, `.internal`) | asks first (`--allow-lan`): the prompt and the key cross the network in the clear |
| `http://` anywhere else; `user:pass@` in the URL; a query or a fragment | refused |

- **No shadowing.** An id opencode already knows (from `/api/integration` or `/api/provider`, which
  also lists the auto-detected `ollama`) is refused. That is why the presets are `local-ollama`,
  `local-lmstudio`, `local-llamacpp` and `local-vllm`.
- **Privacy note** for every endpoint not on this machine: what you type goes there.
- **An honest hint** for local models: agent work needs roughly a 30B model and a lot of VRAM; small
  models answer, but rarely use tools well. A context below 8k (`MIN_CONTEXT_TOKENS`) gets a warning:
  opencode's system prompt alone fills most of it.
- **Onboarding:** a keyless provider on loopback or the LAN counts as connected (`connectionFacts`),
  since it has nothing to log in to.

## CLI

```bash
lotse provider list                                   # every custom provider, its models and source
lotse provider add --preset local-ollama              # models from <baseUrl>/models
lotse provider add my-gw --url https://gw.example/v1 --name "Gateway" --model big=32768 --key < key.txt
lotse provider add lan-box --url http://192.168.1.20:8080/v1 --allow-lan
lotse provider remove my-gw
```

`add` and `remove` work only on the bundled copy; with a host opencode they say so and name
`lotse agents --use opencode:bundled`. A hand-written provider is read-only and shown with its path.

## Measured (opencode 2.0.25)

- `OPENCODE_CONFIG` is merged with the directory config; a missing file is fine.
- A running server hot-reloads an added and a removed provider within 2 s (`waitForProvider` waits up
  to `RELOAD_TIMEOUT_MS`).
- The new provider shows in `/api/integration` with `connections: []`, so a keyless one looks
  unconnected there — hence the onboarding rule above.
- A key from `connect/key` arrives at the endpoint as `Authorization: Bearer`; without a key no header
  is sent. `DELETE /api/credential/{id}` answers 204.

## Not measured

- Whether the bundled opencode inside the **Flatpak** reaches a loopback server on the host (the
  sandbox shares the network namespace, so it should).
- Whether the ACP model dropdown of an already running `opencode acp` picks up a new provider without
  a restart.
