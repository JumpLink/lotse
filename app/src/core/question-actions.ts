/**
 * What a question notification offers and what a click on it does — the desktop channel's decisions,
 * without GI, so both runtimes test them (`desktop-channel.ts` only speaks D-Bus).
 *
 * **A button answers through `answerQuestion`, never around it.** A quick reply is one of the words
 * `parseAnswer` reads (`quickReplies` in `@lotse/core` decides which a question takes), handed to the
 * same function as `lotse answer <id> <text>`; "Answer…" opens the dialog, whose text goes there too.
 *
 * **No `actions` capability, no buttons.** A notification server that cannot show actions gets the
 * plain notification of before, whose body still names `lotse answer`.
 */

import { _ } from '../i18n.ts';
import { quickReplies, type QuestionKind } from '@lotse/core';

import type { DesktopMode } from './settings.ts';

/** The key a click on the notification itself sends (the spec's `default`). Opens the dialog. */
export const DEFAULT_ACTION = 'default';
/** The "Answer…" button. */
export const DIALOG_ACTION = 'answer';
const REPLY_PREFIX = 'reply:';

/**
 * The desktop entry every notification names (`desktop-entry` hint), so the shell files them under one
 * app — its name, its icon, one group — instead of one source per process. The GUI's `APP_ID`; written
 * out rather than imported because `core/` does not reach into `frontends/` (a test keeps them equal).
 * It only groups where the entry is installed (`npm run packaging:install`).
 */
export const DESKTOP_ENTRY = 'eu.jumplink.Lotse';

export interface NotificationHints {
  readonly desktopEntry: string;
  /**
   * Shown as a banner but not kept in the notification list. Everything except a question: a report
   * needs no action, and a list full of them hides the one question that does.
   */
  readonly transient: boolean;
}

export function notificationHints(asks: QuestionKind | undefined): NotificationHints {
  return { desktopEntry: DESKTOP_ENTRY, transient: !asks };
}

export type QuickReply = 'yes' | 'no';

/**
 * The label of a quick reply, by the kind of question it answers. A permission yes allows one call
 * and says so — the same words as the run's resolution, "allowed once".
 */
export function quickReplyLabel(reply: QuickReply, kind: QuestionKind): string {
  if (kind === 'permission') return reply === 'yes' ? _('Allow once') : _('Decline');
  if (kind === 'person') return _('Done');
  return reply === 'yes' ? _('Yes') : _('No');
}

/**
 * The `actions` argument of `Notify`: key, label, key, label… Empty when the server shows no actions or
 * the message asks nothing. Without a dialog to open there is no "Answer…" and no default action: a
 * click would do nothing.
 */
export function notificationActions(
  asks: QuestionKind | undefined,
  capabilities: readonly string[],
  dialog: boolean,
): string[] {
  if (!asks || !capabilities.includes('actions')) return [];
  const actions = dialog ? [DEFAULT_ACTION, _('Answer…'), DIALOG_ACTION, _('Answer…')] : [];
  for (const reply of quickReplies(asks))
    actions.push(`${REPLY_PREFIX}${reply}`, quickReplyLabel(reply, asks));
  return actions;
}

export type ActionIntent =
  | { readonly kind: 'dialog' }
  | { readonly kind: 'answer'; readonly text: QuickReply };

/** What an `ActionInvoked` key means; `null` for a key lotse never sent. */
export function actionIntent(key: string): ActionIntent | null {
  if (key === DEFAULT_ACTION || key === DIALOG_ACTION) return { kind: 'dialog' };
  if (key === `${REPLY_PREFIX}yes`) return { kind: 'answer', text: 'yes' };
  if (key === `${REPLY_PREFIX}no`) return { kind: 'answer', text: 'no' };
  return null;
}

/**
 * Whether a message goes out as a notification or opens the dialog right away. Only a message that asks
 * opens it, only in `dialog` mode, and only when a dialog can be opened at all — otherwise the
 * notification is the fallback, never silence.
 */
export function deliveryFor(
  mode: DesktopMode,
  asks: QuestionKind | undefined,
  dialog: boolean,
): 'dialog' | 'notification' {
  return mode === 'dialog' && asks !== undefined && dialog ? 'dialog' : 'notification';
}

/**
 * Which notification asks which question. The server's ids are per server, so the map lives as long as
 * the `listen` that sent them; a closed notification is forgotten, and a click after that is ignored.
 */
export class NotificationRegistry {
  readonly #questions = new Map<number, string>();

  remember(notification: number, questionId: string): void {
    this.#questions.set(notification, questionId);
  }

  /** The question and what to do with it, or `null` for a notification or key that is not ours. */
  invoked(
    notification: number,
    key: string,
  ): { readonly questionId: string; readonly intent: ActionIntent } | null {
    const questionId = this.#questions.get(notification);
    const intent = actionIntent(key);
    if (questionId === undefined || !intent) return null;
    return { questionId, intent };
  }

  closed(notification: number): void {
    this.#questions.delete(notification);
  }

  get size(): number {
    return this.#questions.size;
  }
}
