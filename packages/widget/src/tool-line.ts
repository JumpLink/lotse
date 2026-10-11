/**
 * A recorded tool line, taken apart for drawing.
 *
 * Two sources, and the newer one wins where it exists. A line written since issue #43 carries a
 * structured record, folded into `ToolItem.call` by the projection, and its title, status and ACP kind
 * are read from there (`toolRow`). A line older lotse wrote has only the one string
 * `"<title> — <status>"` (`core/transcript.ts`), and `parseToolLine` reads that back out of the text —
 * the icon then a guess from the title's wording, and the guess is the surface's: it never reaches the
 * record. No `gi://` import, so Node can test both, and the host presenter's fallback with them.
 */

import type { ToolCallView } from '@lotse/core';

export type ToolStatus = 'running' | 'done' | 'failed';

export interface ToolLine {
  /**
   * The title the agent sent, or `''` when this line carries only a status.
   *
   * A `tool_call_update` may arrive with a status and no title (`core/transcript.ts` writes
   * `"— completed"`), and that is a real shape rather than a malformed line. It stays empty here: a
   * heading invented here ("Tool call") would put a name on the agent that the agent never sent.
   */
  readonly title: string;
  readonly status: { readonly label: string; readonly tone: ToolStatus } | null;
}

const STATUSES: Record<string, { label: string; tone: ToolStatus }> = {
  pending: { label: 'Pending', tone: 'running' },
  in_progress: { label: 'Running', tone: 'running' },
  completed: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'failed' },
};

export function parseToolLine(summary: string): ToolLine {
  const match = /^(.*?)\s*— (\w+)$/su.exec(summary.trim());
  const status = match?.[2] ? STATUSES[match[2]] : undefined;
  if (!match || !status) return { title: summary.trim(), status: null };
  return { title: match[1]?.trim() ?? '', status };
}

/** Icon names checked against the Adwaita theme with `scripts/probes/icon-names.mjs`. */
const ICONS: readonly (readonly [RegExp, string])[] = [
  [/^(read|open|cat|view)\b/i, 'document-open-symbolic'],
  [/^(edit|write|create|patch|update|modify)\b/i, 'document-edit-symbolic'],
  [/^(delete|remove|rm)\b/i, 'edit-delete-symbolic'],
  [/^(move|rename|mv)\b/i, 'folder-symbolic'],
  [/^(search|find|grep|glob|list)\b/i, 'edit-find-symbolic'],
  [/^(fetch|http|web|download|curl)\b/i, 'network-workgroup-symbolic'],
  [/^(run|exec|execute|bash|shell|\$)/i, 'system-run-symbolic'],
];

/** The icon for a tool nothing above matched, and for a status line that names no tool at all. */
export const TOOL_FALLBACK_ICON = 'system-run-symbolic';

/** The icon for a tool title, or for an ACP `kind` word — the permission dialog has the real one. */
export function toolIcon(text: string): string {
  for (const [pattern, icon] of ICONS) if (pattern.test(text.trim())) return icon;
  return TOOL_FALLBACK_ICON;
}

/**
 * How a host wants one of its own tool calls drawn. `LotseChatOptions.toolPresenter` returns it.
 *
 * Title, subtitle and icon only — never the status, which stays the agent's: a host that could
 * restyle a failed call as anything else could hide that it failed.
 */
export interface ToolPresentation {
  readonly title: string;
  readonly subtitle?: string;
  /** A themed icon name. The host's to check exists; a missing one renders as the theme's placeholder. */
  readonly icon?: string;
}

/** The host hook. `null` is "not mine — draw it as lotse would". */
export type ToolPresenter = (call: ToolCallView) => ToolPresentation | null;

/** What a tool row draws, whichever source it came from. */
export interface ToolRow extends ToolLine {
  readonly subtitle: string | null;
  readonly icon: string;
}

/**
 * The row for one tool item: the host's presentation if it gave a usable one, else the standard line.
 *
 * **Fail-closed the way `modelAllowed` is, with the opposite default.** A presenter that throws or
 * answers something that is not a `ToolPresentation` (no title, an empty one, a field of the wrong
 * type) is treated as if it had not been asked, and the standard line is drawn — because the one
 * outcome a broken host hook must not have is a tool call that vanishes from the transcript, and an
 * empty title would be exactly that. `warn` is told once per failed presentation; `null` is a
 * legitimate answer and is not warned about.
 *
 * A legacy line (`call === null`) never reaches the presenter: there is nothing structured to hand
 * it, and a view rebuilt from the text would be a guess presented as the record.
 */
export function toolRow(
  summary: string,
  call: ToolCallView | null,
  presenter?: ToolPresenter,
  warn: (message: string) => void = () => {},
): ToolRow {
  const line = call === null ? parseToolLine(summary) : lineOfCall(call, summary);
  const standard: ToolRow = { ...line, subtitle: null, icon: iconOf(line.title, call?.kind) };
  if (call === null || presenter === undefined) return standard;
  let presented: unknown;
  try {
    presented = presenter(call);
  } catch (error) {
    warn(`the tool presenter threw, so the call is drawn as lotse would: ${String(error)}`);
    return standard;
  }
  if (presented === null) return standard;
  if (!isPresentation(presented)) {
    warn('the tool presenter returned no usable title, so the call is drawn as lotse would');
    return standard;
  }
  return {
    title: presented.title,
    status: line.status,
    subtitle: presented.subtitle && presented.subtitle !== '' ? presented.subtitle : null,
    icon: presented.icon && presented.icon !== '' ? presented.icon : standard.icon,
  };
}

/**
 * Title and status from the folded record. The text is the fallback only for a call whose record
 * never carried a title — not a shape seen from an agent, but a hand-edited store can have it.
 */
function lineOfCall(call: ToolCallView, summary: string): ToolLine {
  const status = call.status === undefined ? null : (STATUSES[call.status] ?? null);
  const title = call.title === undefined ? parseToolLine(summary).title : call.title.trim();
  return { title, status };
}

/** ACP's own `kind` names the icon when it says something; `other` and `think` say nothing about a tool. */
function iconOf(title: string, kind: string | undefined): string {
  if (kind !== undefined && kind !== 'other' && kind !== 'think') return toolIcon(kind);
  return toolIcon(title);
}

function isPresentation(value: unknown): value is ToolPresentation {
  if (typeof value !== 'object' || value === null) return false;
  const { title, subtitle, icon } = value as Record<string, unknown>;
  return (
    typeof title === 'string' &&
    title.trim() !== '' &&
    (subtitle === undefined || typeof subtitle === 'string') &&
    (icon === undefined || typeof icon === 'string')
  );
}
