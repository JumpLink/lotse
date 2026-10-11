# @lotse/widget

The chat surface, as a widget another GTK4 / libadwaita app embeds. `LotseChat` is an `Adw.Bin` that
shows **one conversation**: the transcript, the composer with its model, effort and mode controls, the
tool and thought cards, the approval dialog, failure notices and the provider login. It owns one agent
subprocess and renders what `@lotse/core` reports.

Licence: **LGPL-3.0-or-later** (`LICENSE`, `COPYING` in this directory).

The widget draws; every decision (may Send be pressed, what does this failure say, which options may a
permission dialog show) is made in [`@lotse/core`](../core/README.md). The host brings the window, the
session list, the menu and the preferences. The full walkthrough, from data directory to shutdown, is
the [host guide](../../docs/embedding.md); the design of the split is
[ADR 0001](../../docs/adr/0001-lotse-as-an-embeddable-widget.md).

Requires GJS with GTK 4 and libadwaita, and an ACP agent (opencode today) on `PATH` or bundled.

## Install and import

The packages are `private` and not yet on a registry; depend on them as a workspace:

```json
{ "dependencies": { "@lotse/widget": "*", "@lotse/core": "*", "@lotse/session": "*" } }
```

```ts
import { LotseChat } from '@lotse/widget';
```

`.` is the public entry. Two further sub-paths exist for lotse's own tests (`@lotse/widget/tool-line`,
`@lotse/widget/permission-dialog`); a host does not need them.

## Minimal example

```ts
import { homedir } from 'node:os';

import type Adw from '@girs/adw-1';

import {
  DEFAULT_AGENT,
  emptyStateView,
  gatherResolveContext,
  lotsePathsUnder,
  requireLauncher,
  resolveDefault,
  resolveRecorded,
  type McpServer,
} from '@lotse/core';
import { createSessionStore } from '@lotse/session';
import { LotseChat } from '@lotse/widget';

export function embedChat(window: Adw.ApplicationWindow, dataRoot: string, projectDir: string): LotseChat {
  const paths = lotsePathsUnder(dataRoot);
  const store = createSessionStore(paths.sessionsFile);

  const found = resolveDefault(gatherResolveContext(paths, false));
  const empty = emptyStateView({ agent: found });

  const mcpServers: McpServer[] = [
    { name: 'my-tools', command: '/usr/bin/my-mcp-server', args: [], env: [] },
  ];

  const chat = new LotseChat({
    agent: found?.command ?? requireLauncher(DEFAULT_AGENT),
    agentSource: found?.source ?? 'host',
    newChat: { cwd: projectDir, home: homedir() },
    createSession: (record) => store.create(record),
    appendTurns: (id, entries) => store.append(id, entries),
    resolveAgent: async (id, source) =>
      resolveRecorded(id, source, gatherResolveContext(paths, false, false)),
    mcpServers,
    ...(empty.kind === 'no-agent' ? { noAgent: empty } : {}),
    gate: (question) => (question.view.kind === 'delete' ? 'decline' : 'ask'),
    onNotice: (message) => console.log(`agent: ${message}`),
  });

  window.set_content(chat);
  chat.newChat();

  window.connect('close-request', () => {
    void chat.shutdown().finally(() => window.destroy());
    return true;
  });
  return chat;
}
```

This is `app/tests/examples/embed.ts`, which is type-checked with the app. Each line is explained in the
[host guide](../../docs/embedding.md).

## `LotseChatOptions`

`new LotseChat(options)`. Only `agent` and `newChat` are required.

| Option | Type | Meaning |
|---|---|---|
| `agent` | `AgentCommand` | The agent to start on the first prompt, and the one a login is for. Required even when nothing was found (see `noAgent`). |
| `agentSource` | `'host' \| 'bundled'` | Which copy `agent` is; what a new conversation's record names. Default `host`. |
| `newChat` | `{ cwd: string; home: string \| null } \| null` | Where a new chat runs, and the home it is abbreviated against (`~/…`). `null`: no directory was found; `newChat()` does nothing and `hasNewChat` is `false`. |
| `createSession` | `(record: SessionRecord) => void` | Write a new conversation's record. `SessionStore.create`. |
| `appendTurns` | `(sessionId, entries) => void` | Persist streamed transcript lines, once per arriving batch, in order. `SessionStore.append`. |
| `resolveAgent` | `(id, source) => Promise<RecordedResolution>` | The agent a stored session names, on the copy that held it: `resolveRecorded`. Leave out to run every session on `agent`. |
| `mcpServers` | `readonly McpServer[]` | Your MCP servers, sent unchanged in `session/new` and on reattach. Never read by lotse past `type`. |
| `noAgent` | `{ kind: 'no-agent', … }` | Nothing was found: Send is off, and `showNoAgent()` shows the `noAgentPage`. Take the value from `emptyStateView`. |
| `closedPage` | `Gtk.Widget` | Your "nothing is open" page. Absent: that state renders nothing. |
| `noAgentPage` | `Gtk.Widget` | Your "no agent found" page. Absent: that state renders nothing. |
| `gate` | `(question) => 'ask' \| 'decline' \| Promise<…>` | Your permission policy, asked **before** the person. See below. |
| `modelPolicy` | `(model: string) => 'allow' \| 'deny'` | Which models your data may reach. Absent: every model, which is lotse's own window. See below. |
| `toolPresenter` | `(call: ToolCallView) => ToolPresentation \| null` | Draw your own MCP calls in your words. Absent: every tool row is lotse's. See below. |
| `providerOnboarding` | `boolean` | Off by default. On: a new chat with no provider connected shows "Connect a provider" first. |
| `onConversation` | `(record, current) => void` | A new conversation has its session and record; list it. Runs before the widget updates its own view. |
| `onNotice` | `(message) => void` | A line from the agent that is not a transcript entry (it is also logged). |
| `now` | `() => string` | ISO clock for transcript timestamps. Default is the real clock; inject one for screenshots and tests. |

### `gate` can only add restrictions

The agent asks permission through `session/request_permission`. Without `gate`, every question is put
to the person in a dialog. With it, your function sees the question first (`question.view` has the tool,
its kind, locations and raw input) and answers one of two words:

- `'ask'` — show the dialog; the person decides.
- `'decline'` — answer the agent without asking: the question resolves as not answered (`null`), which the
  agent sees as a cancelled request.

There is **no answer that approves.** A host may narrow what the agent gets ("never in this directory",
"not while unattended"); it cannot hand out an approval nobody gave. The gate is fail-closed: a throw, a
rejected promise or any value other than the literal `'ask'` counts as a decline. `HostGateAnswer` is the
type of the two words.

### `modelPolicy` blocks the send, it never switches the model

Your app's data reaches the model the agent is configured to use. If some of that data must not leave
for some destinations, say so once:

```ts
import { denyFreeHostedModels } from '@lotse/core';

new LotseChat({ …, modelPolicy: denyFreeHostedModels });
```

A `ModelPolicy` is `(model: string) => 'allow' | 'deny'`, called with the agent's own model id
(`openrouter/qwen/qwen3-coder:free`, `anthropic/claude-sonnet-4-5`). Three things happen with one set:

1. **Denied models are not offered.** The composer's model dropdown lists only what you allow, and the
   model-refusal dialog's **Choose another model** is withheld when nothing is left to choose.
2. **A denied model blocks the send.** The composer turns Send off and says why; the prompt does not
   reach the agent. Lotse **never picks a different model for the person** — a silent switch is a
   different conversation with a different model, made by nobody.
3. **The check runs again whenever the agent reports a configuration change**, not only at startup.

**Fail-closed, including the model nobody named.** A policy that throws is a deny. A model the widget
cannot identify — an empty id, or an agent that reports no model control — is a deny too. Before the
first prompt nothing is known yet and Send stays on (the first prompt is what starts the agent), but
the controller checks again once the agent has answered and refuses to send if the model is denied or
still unnamed.

`denyFreeHostedModels` (from `@lotse/core`) denies what `isFreeModel` calls free, which is the same
classification `lotse serve` has used since ADR 0003: the maintained ids in
`packages/core/data/free-models.json`, plus any id ending in `-free`, plus an empty or blank id. The
file's own criterion is "free to run without a paid key **and** documented as zero-retention" — the
suffix rule is what catches the rest of the free tier, where a model is merely free and may be trained
on. Free also means hosted: the prompt goes to whoever runs it.

**A well-formed id the classification has never heard of is allowed**, deliberately. Denying the
unknown reads safer and is unusable: the classification knows two exact ids and one suffix, so
"unknown" is nearly every model an agent reports, *including every paid one*, and a widget with no
allowed model left asks the person to pick something that does not exist. If your data needs certainty
rather than a known-bad list, pass an allowlist: `allowOnlyProviders(['anthropic'])` from `@lotse/core`
allows only ids whose provider (the part before the first `/`) is listed, exactly, and denies every other
id, however new — it does not look inside a provider, so pair it with `denyFreeHostedModels` where
that matters. Or write your own predicate; it is the same one-line option. The genuinely uncertain case, "which model is even in
use?", is caught by the fail-closed rule above and not by this one.

### `toolPresenter` renames a row, it never restatuses it

Every tool line in the transcript written by this version carries a structured record: ACP kind, title, status,
the input up to 8 KiB (larger is replaced by `rawInputOmitted: true`), and `mcp` — the MCP tools the
call reached. For opencode's code-mode `execute`, `mcp` comes from the agent's own report once the call
completed (`source: 'reported'`, with `input` and `status`), and from reading the code while it runs
(`source: 'code'`, names only). The presenter gets the call folded across all its lines so far:

```ts
toolPresenter: (call) => {
  const order = call.mcp.find((m) => m.server === 'shop' && m.tool === 'place_order');
  return order ? { title: 'Order placed', subtitle: String((order.input as { sku?: string })?.sku ?? ''), icon: 'cart-symbolic' } : null;
},
```

`null` draws lotse's row. **The status stays the agent's**: a host that could restyle a failed call
could hide that it failed. A presenter that throws, or returns no non-empty `title` or a field of the
wrong type, falls back to lotse's row and logs one `lotse:` warning — a broken hook must never make a
tool call vanish. Lines written by older lotse versions carry no record and never reach the presenter.

### Host entries

`chat.appendHostItem({ type, text, data?, icon? })` records something your app did into the open
conversation — kind `'host'`, persisted through `appendTurns` like any line and shown on resume as a
small row with your icon. `data` is yours and must be JSON (no functions, `Map`, `BigInt` or cycles) and
small (8 KiB). It rejects when you passed no `appendTurns`, when no session is open yet (a new chat is
filed after its first prompt), or when `type`, `text` or `data` is unusable, instead of drawing a row that
would be lost.

### `providerOnboarding`

When on, the widget starts a private login server once (bounded to 10 s) to read which providers the agent
has connected. It shows **Connect a provider** only if the agent reports none; browser login and API key
are offered with provider counts, plus **Use free hosted models**, labelled as time-limited and sent to
the hosting provider. An unreadable state shows the ordinary chat: the page is an offer, never a wall.
After a successful login the agent restarts. Nothing here reads or keeps a credential. Core's
`probeConnections` and `onboardingView` are the pieces, if you want the signal elsewhere.

## `LotseChat` members

| Member | Use |
|---|---|
| `open(record)` | Show a stored session. Spawns nothing; the agent starts on the first prompt. Takes `record.turns` as given. |
| `newChat()` | The empty composer; the first prompt creates the session. Keeps a draft. No-op when `hasNewChat` is `false`. |
| `hasNewChat` | Whether a new chat has a directory to run in. Disable your own control when `false`. |
| `showNoAgent()` | Show your `noAgentPage`. |
| `hasLogin`, `openLogin()` | Whether a login can run at all, and open the login dialog. After a login the agent restarts. |
| `prompt(text)`, `clearDraft()`, `stop()` | Drive the composer from code. |
| `snapshot`, `turnRunning`, `agentRunning`, `hasChat`, `openSessionId`, `sendReason` | Read-only state, for enabling your own controls. |
| `dismissPermission(reason)`, `closePermission()`, `closeFailure()`, `closeLogin()` | Take a dialog down, e.g. when your window closes. Call `dismissPermission` first so the reason is recorded. |
| `appendHostItem({ type, text, data?, icon? })` | Record a line of your own in the open conversation. Returns `Promise<void>`; rejects with no session open or no `appendTurns`. See above. |
| `shutdown()` | **Async.** Aborts the onboarding probe, cancels the running turn, waits, then terminates the agent. Call it from your window's close path and wait for it. |

`stageOnboarding`, `stagePermissionRequest`, `stageConfigOption`, `openModelDropdown`,
`chooseModelInDialog`, `hasModelControl`, `permissionAsked`, `streamed` and `failureShown` exist for
lotse's own dev fixtures and screenshots ([dev-fixtures](../../docs/dev-fixtures.md)); a host does not
need them.

`shutdown()` order matters: it cancels first so the agent can answer `cancelled` and flush, and
terminates only afterwards. Terminating first would lose the work of the turn in flight.

## Other exports

| Export | What it is |
|---|---|
| `HostGateAnswer` | `'ask' \| 'decline'`. |
| `LotseChatOptions` | The options above. |
| `ToolPresenter`, `ToolPresentation`, `ToolCallView`, `McpCall`, `HostItem` | The types `toolPresenter` and host entries use. |
| `CSS` | The widget's class-name map, for a host that styles its own widgets next to the chat. The stylesheet itself is installed by `LotseChat`; a host needs no CSS of its own. |

## Related

[`@lotse/core`](../core/README.md) · [host guide](../../docs/embedding.md) · [design](../../docs/design/README.md)
(what the widget looks like, with screenshots) · [login](../../docs/login.md)
