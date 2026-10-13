/**
 * `@lotse/widget` — the chat surface, as a widget a host embeds.
 *
 * Layer 3, above `@lotse/core` and below any application: `LotseChat` is one conversation — the
 * transcript, the composer with its model and mode controls, the tool and thought cards, the
 * approval dialog, the failure notices, the login — and nothing around one. The host brings the
 * window, the session list, the menu and the preferences; see
 * [ADR 0001](../../../docs/adr/0001-lotse-as-an-embeddable-widget.md) for where that line runs and
 * `app/src/frontends/gui/window.ts` for the first consumer on the other side of it.
 *
 * **This package knows a toolkit and no decisions.** GTK 4 and libadwaita are imported here, which
 * is exactly what `@lotse/core` may not do; in return every question a widget in here answers is
 * answered one layer down. A rule added to this package that is not about drawing belongs in core.
 *
 * **One door, and it is this file** — the same rule as `@lotse/core`'s barrel: `package.json`
 * exports `.` plus two deliberate reach-ins, so what a host may construct is a decision made here
 * rather than whatever a consumer could resolve. The two exceptions exist for measurements, not for
 * hosts, and each is one file with no widget in its import graph:
 *
 * - `@lotse/widget/tool-line` — `tool-line.ts` has no runtime imports (one `import type` from core,
 *   erased before it runs), so lotse's unit test for it and for the host presenter's fallback
 *   runs on **Node** as well as GJS. Reaching it through this barrel would pull `Adw` in and the
 *   Node half of the dual run would be gone, which is the split `AGENTS.md` calls the entire point.
 * - `@lotse/widget/permission-dialog` — `app/tests/probes/permission-focus.ts` measures where GTK
 *   puts the keyboard focus **on this very widget**, which a look-alike built from `Adw.AlertDialog`
 *   cannot answer (the probe's own header records the time the two disagreed). A host has no use for
 *   the dialog on its own: `LotseChat` raises it, and a host's say over it is `gate`.
 */

import './i18n.ts';

export { LotseChat, type HostGateAnswer, type LotseChatOptions } from './chat.ts';
// The host's say over how its own tool calls are drawn, and what it is handed to decide.
export type { ToolPresentation, ToolPresenter } from './tool-line.ts';
export type { HostItem, McpCall, ToolCallView } from '@lotse/core';
// The policy-side helpers a host may want next to `modelPolicy` and `allowCustomProviders`.
export { providerOffered, type ModelPolicy } from '@lotse/core';

// The stylesheet is installed by `LotseChat` itself; only the class-name map is public, for a host
// that styles its own widgets next to the chat (lotse's app reuses `calm`).
export { CSS } from './css.ts';
