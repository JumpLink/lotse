/**
 * The two host rules that are about a **tool call** rather than a model, decided here as pure
 * functions over plain data — `permission.ts`'s split, one file along.
 *
 * **Rule one: a tool the host confirms itself.** An embedding host can own a tool whose approval is
 * not lotse's to give: a legal submission that asks for a PIN, a payment, a signature. lotse's dialog
 * knows none of that, so a host marks such a tool (by name, by kind, or both) and gets a callback
 * with its own dialog instead. The guarantee is negative and it is the whole feature: **lotse never
 * approves a host-confirmed tool through `session/request_permission`** — not from its own dialog, not
 * from an "always allow", not from a grant left over from earlier in the session. The host's `false`
 * is a `decline`, and so is a host that threw, a host with no callback at all, and an agent that
 * offered nothing narrower than a lasting approval (see `hostConfirmDecision`).
 *
 * **Rule two: an "always allow" that lives one session.** Normally the *agent* remembers an always
 * (`permission.ts`: ACP has no `allowed_always`, the answer is the agent's own option id and the agent
 * decides whether to ask again). A host carrying somebody's documents may not want a promise it cannot
 * see the end of, so it asks for `alwaysAllow: 'session'`: lotse then answers the agent's **narrower**
 * `allow_once` on the wire and remembers the always itself, in memory, keyed by the ACP session id. A
 * new session has an empty memory because the key is new; nothing is written anywhere, so there is
 * nothing to persist and nothing to clear. Where the agent offers no `allow_once` at all, the
 * `allow_always` button is **withdrawn** (`scopedOptions`) rather than shown as a promise lotse cannot
 * keep that narrow.
 *
 * **Nothing in here is a wider answer than lotse would give on its own**, which is the same rule
 * `ModelPolicy` and `LotseChat.gate` follow: a host policy narrows. The one thing a host *adds* is its
 * own approval for its own tool, and that approval is the host's, taken in the host's dialog, for one
 * call.
 */
import { _, fmt } from './i18n.ts';
import { mcpCallsOf } from './transcript.ts';

import type { PermissionOption, RequestPermissionRequest } from '@lotse/acp/types';
import type { PermissionDecision, PermissionView } from './permission.ts';

/**
 * The call a rule is matched against: what the agent called it, and the names it can be recognised by.
 *
 * **`names` is a list because one call has more than one honest name.** The agent reports a `title`,
 * which is a sentence for a person ("Write src/hello.ts") and a poor key; a call that reaches an MCP
 * server also names the server and the tool, and *that* is what a host recognises as its own
 * (`steuererklaerung.elster_submit`). So the title and every MCP name the call carries are all in the
 * list, and a rule matches when any one of them is the name it asked for — exactly, never as a
 * substring, which is `free-models.ts`'s rule for the same reason: a key that matches by fragment
 * matches something new the day somebody renames a tool.
 */
export type ToolRef = {
  /** The agent's own sentence for the call, capped by `permissionView`. */
  readonly title: string;
  /** The ACP tool kind (`read`, `edit`, `execute`, `fetch`…), or `'unknown'` when the agent sent none. */
  readonly kind: string;
  /** Every name the call may be matched by: the title, plus `server.tool` and `tool` per MCP call. */
  readonly names: readonly string[];
};

/**
 * One rule from the host. Both fields are optional and both are ANDed: `{ kind: 'execute' }` is every
 * command, `{ name: 'elster.submit' }` is one tool whatever its kind, and both together is the
 * intersection. A rule that names **neither** matches nothing — see `hostToolProblems`, which is how a
 * host hears about it rather than having every tool quietly routed into its own dialog.
 */
export type HostToolMatch = {
  readonly name?: string;
  readonly kind?: string;
};

/** Who remembers an "always allow": the agent, as ACP intends, or lotse for this one session. */
export type AlwaysAllowScope = 'agent' | 'session';

/** The host's rules about tool calls. Absent, and every field absent, is lotse's own behaviour. */
export type HostToolPolicy = {
  /** Tools lotse may never approve: the host is asked and shows its own dialog. */
  readonly hostConfirmed?: readonly HostToolMatch[];
  /** Default `'agent'`. `'session'` keeps an always-allow inside the ACP session it was given in. */
  readonly alwaysAllow?: AlwaysAllowScope;
};

/** What the desk does with a question once the host's rules have been read. */
export type ToolGate =
  /** The host's own dialog decides. lotse shows nothing and approves nothing. */
  | { readonly type: 'host-confirm' }
  /** An always-allow given earlier in this session covers it; answer with the agent's own id. */
  | { readonly type: 'granted'; readonly optionId: string }
  /** Put it to the person, with these options — `scopedOptions` may have withdrawn one. */
  | { readonly type: 'ask'; readonly options: readonly PermissionOption[] };

/** The lowercased, whitespace-trimmed form both sides of a comparison are reduced to. */
function key(text: string): string {
  return text.trim().toLowerCase();
}

/** A field a host filled in, or `null` for absent, wrong-typed and blank alike. */
function filled(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The call, as the host's rules see it — read off the request rather than off the projection, because
 * the MCP names live in `rawInput`/`rawOutput` and `permissionView` does not carry them.
 *
 * `mcpCallsOf` is the same reader the transcript's tool lines use, so a host matches the name it can
 * *see* in the conversation. Nothing here trusts the wire to be the shape the schema declares
 * (guardrail 4): a missing or wrong-typed `toolCall` yields the same fallbacks `permissionView` uses.
 */
export function toolRefOf(request: RequestPermissionRequest): ToolRef {
  const call = (request as { toolCall?: unknown } | null | undefined)?.toolCall;
  const object = typeof call === 'object' && call !== null ? (call as Record<string, unknown>) : {};
  const title = typeof object.title === 'string' && object.title.length > 0 ? object.title : 'unnamed tool';
  const kind = typeof object.kind === 'string' && object.kind.length > 0 ? object.kind : 'unknown';
  const names = new Set<string>([title]);
  for (const mcp of mcpCallsOf(object.rawInput, object.rawOutput)) {
    names.add(`${mcp.server}.${mcp.tool}`);
    names.add(mcp.tool);
  }
  return { title, kind, names: [...names] };
}

/** Whether one rule covers one call. A rule that names nothing covers nothing. */
export function matchesTool(match: HostToolMatch, ref: ToolRef): boolean {
  const name = filled(match.name);
  const kind = filled(match.kind);
  if (name === null && kind === null) return false;
  if (kind !== null && key(kind) !== key(ref.kind)) return false;
  if (name !== null && !ref.names.some((candidate) => key(candidate) === key(name))) return false;
  return true;
}

/** Whether the host owns the approval for this call. Asked before anything else is. */
export function hostConfirmed(policy: HostToolPolicy | undefined, ref: ToolRef): boolean {
  const rules = policy?.hostConfirmed;
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => typeof rule === 'object' && rule !== null && matchesTool(rule, ref));
}

/**
 * The rules lotse cannot use, as sentences for the log — one per rule that names neither a name nor a
 * kind.
 *
 * **Because the failure is silent in the direction that matters.** A host that meant to mark its
 * submission tool and passed a rule lotse reads as empty gets lotse's ordinary dialog for it, and the
 * person can approve something the host wanted a PIN for. Nothing in a pure matcher can report that, so the
 * list is returned and the controller says it once at startup.
 */
export function hostToolProblems(policy: HostToolPolicy | undefined): string[] {
  const rules = policy?.hostConfirmed;
  if (!Array.isArray(rules)) return [];
  const problems: string[] = [];
  for (const [index, rule] of rules.entries()) {
    const usable =
      typeof rule === 'object' &&
      rule !== null &&
      (filled((rule as HostToolMatch).name) !== null || filled((rule as HostToolMatch).kind) !== null);
    if (usable) continue;
    problems.push(
      fmt(_('Host-confirmed tool rule {index} names neither a tool nor a kind, so it matches nothing.'), {
        index: String(index + 1),
      }),
    );
  }
  return problems;
}

/** The narrowest allowing option the agent offered: `allow_once` ahead of `allow_always`, else `null`. */
export function narrowestAllow(options: readonly PermissionOption[]): PermissionOption | null {
  return (
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always') ??
    null
  );
}

/**
 * The narrowest rejecting option the agent offered: `reject_once` ahead of `reject_always`, else
 * `null`. **`initialFocusResponseId` reads its answer from here**, so the button a stray Enter lands on
 * and the id a host's refusal is answered with are the same decision made once.
 */
export function narrowestReject(options: readonly PermissionOption[]): PermissionOption | null {
  const narrow = options.find((option) => option.kind === 'reject_once');
  if (narrow !== undefined) return narrow;
  return options.find((option) => option.kind.startsWith('reject')) ?? null;
}

/**
 * What may be shown, under the host's always-allow scope.
 *
 * `'agent'` — and absent — is every option untouched, which is lotse's own window. `'session'` keeps
 * `allow_always` **only when the agent also offered an `allow_once`**, because that id is what lotse
 * answers with (`sessionAnswer`) and without it the button would be a session promise lotse hands to
 * the agent to keep forever. Withdrawing it can leave a question with nothing allowing on it; that is
 * the fail-closed direction, and it is a host's own choice of policy rather than something lotse
 * decided for it.
 */
export function scopedOptions(
  options: readonly PermissionOption[],
  scope: AlwaysAllowScope | undefined,
): PermissionOption[] {
  if (scope !== 'session') return [...options];
  if (options.some((option) => option.kind === 'allow_once')) return [...options];
  return options.filter((option) => option.kind !== 'allow_always');
}

/**
 * Every always-allow a person gave in a session, held in memory and nowhere else.
 *
 * **Keyed by the ACP session id, which is what makes "one session" true rather than promised.** A new
 * conversation gets a new id and therefore an empty answer to every question; a restart loses the
 * object with the process. There is no path from this class to a file, and guardrail 1 is why: a
 * session record may never hold a grant, and the way to keep that rule is to have nowhere to put one.
 *
 * **Keyed by the tool, not by the arguments.** A person who answers "always allow" to an `edit` has
 * answered about editing, not about the one path in the title — a key that carried the path would ask
 * again on the next file and the always would mean nothing. An MCP call keys on its own name, so one
 * server's tool does not stand in for another's. And a host-confirmed tool never reaches this class at
 * all (`toolGate` asks the host first), so a grant can never widen into one.
 */
export class SessionGrants {
  readonly #bySession = new Map<string, Set<string>>();

  /** The grant key for a call: its kind, plus the MCP tool name when the call named one. */
  static keyOf(ref: ToolRef): string {
    const mcp = ref.names
      .filter((name) => name !== ref.title)
      .map(key)
      .sort();
    return `${key(ref.kind)}\u0000${mcp.join(',')}`;
  }

  /** Remember an always-allow for this session. */
  allow(sessionId: string, ref: ToolRef): void {
    const existing = this.#bySession.get(sessionId);
    const grants = existing ?? new Set<string>();
    if (existing === undefined) this.#bySession.set(sessionId, grants);
    grants.add(SessionGrants.keyOf(ref));
  }

  /** Whether this session already carries an always-allow for this call. */
  allows(sessionId: string, ref: ToolRef): boolean {
    return this.#bySession.get(sessionId)?.has(SessionGrants.keyOf(ref)) ?? false;
  }

  /** Drop one session's grants, or all of them. Nothing depends on it; a session id is never reused. */
  forget(sessionId?: string): void {
    if (sessionId === undefined) this.#bySession.clear();
    else this.#bySession.delete(sessionId);
  }

  /** How many sessions carry a grant. For a test, and for a host that wants to see it is bounded. */
  get sessions(): number {
    return this.#bySession.size;
  }
}

/**
 * One question, read against the host's rules — the order is the rule.
 *
 * **The host is asked first, and that is not an optimisation.** A host-confirmed tool is checked
 * before the grants are, so an always-allow a person gave earlier in the session — for the same kind,
 * before the host's rule was ever exercised — cannot answer it. "lotse never approves it, not even via
 * always-allow" is this line.
 */
export function toolGate(input: {
  readonly view: PermissionView;
  readonly ref: ToolRef;
  readonly sessionId: string | undefined;
  readonly policy?: HostToolPolicy | undefined;
  readonly grants?: SessionGrants | undefined;
}): ToolGate {
  const { view, ref, sessionId, policy, grants } = input;
  if (hostConfirmed(policy, ref)) return { type: 'host-confirm' };
  const options = scopedOptions(view.options, policy?.alwaysAllow);
  if (grants !== undefined && typeof sessionId === 'string' && grants.allows(sessionId, ref)) {
    const allow = narrowestAllow(options);
    // No allowing option on *this* request is not a grant lotse may act on: there is no id to send.
    // The question goes to the person instead, which is the only other honest answer.
    if (allow !== null) return { type: 'granted', optionId: allow.optionId };
  }
  return { type: 'ask', options };
}

/**
 * What the host's own dialog answered, as a decision.
 *
 * **A host's yes is answered with `allow_once` and with nothing else.** The point of a host-confirmed
 * tool is that it is confirmed *every time* — a PIN asked once a session is not a PIN — so an
 * `allow_always` id would tell the agent to stop asking and the host's dialog would never open again.
 * An agent that offers no `allow_once` therefore gets no approval from here at all: the decision is
 * `not-answered`, the wire sees `cancelled`, and `HOST_CONFIRM_NO_ONCE_NOTE` is what says why.
 *
 * **A no is a decline with the agent's own narrowest rejecting id**, and `not-answered` when the agent
 * offered none — the same fail-closed ending every path in `permission.ts` has.
 */
export function hostConfirmDecision(view: PermissionView, confirmed: boolean): PermissionDecision {
  if (confirmed) {
    const once = view.options.find((option) => option.kind === 'allow_once');
    if (once === undefined) return { type: 'not-answered', reason: 'dismissed' };
    return { type: 'allowed', optionId: once.optionId };
  }
  const reject = narrowestReject(view.options);
  if (reject === null) return { type: 'not-answered', reason: 'dismissed' };
  return { type: 'declined', optionId: reject.optionId };
}

/** Said once, when a host's yes could only have been answered with a lasting approval. */
export const HOST_CONFIRM_NO_ONCE_NOTE = (): string =>
  _('The agent offered no one-time approval for a tool the host confirms, so nothing was approved.');

/**
 * The id that goes on the wire for a chosen option, and whether lotse remembers it for this session.
 *
 * Under `'agent'` scope — and for anything that is not an always-allow — this is the identity: the id
 * the person pressed, remembered by nobody but the agent. Under `'session'` scope an `allow_always`
 * becomes the agent's own `allow_once`, so the agent is told about *this* call only, and `remember` is
 * `true`, so the next matching call in the same session is answered by `toolGate` instead of by a
 * second dialog.
 */
export function sessionAnswer(
  view: PermissionView,
  optionId: string,
  scope: AlwaysAllowScope | undefined,
): { readonly optionId: string; readonly remember: boolean } {
  if (scope !== 'session') return { optionId, remember: false };
  const chosen = view.options.find((option) => option.optionId === optionId);
  if (chosen === undefined || chosen.kind !== 'allow_always') return { optionId, remember: false };
  const once = view.options.find((option) => option.kind === 'allow_once');
  // `scopedOptions` withdraws `allow_always` when there is no `allow_once`, so this cannot be reached
  // from a dialog lotse drew. A direct caller gets the fail-closed reading: lotse does not pass a
  // lasting id on under a session policy, and nothing is remembered either.
  if (once === undefined) return { optionId, remember: false };
  return { optionId: once.optionId, remember: true };
}
