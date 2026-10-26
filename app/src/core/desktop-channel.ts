/**
 * The first `QuestionChannel`: a desktop notification over `org.freedesktop.Notifications`.
 *
 * Gio D-Bus rather than GNotification, because `listen` is not a `GApplication` and has no desktop
 * file to attach one to. Imported lazily by `listen` (`await import`), so nothing that merely lists
 * or answers questions loads GI, and a session without a notification daemon falls back to stderr
 * instead of failing the run that wanted to ask (`stderr-channel.ts`).
 *
 * **A question carries buttons where the server shows them** (`GetCapabilities` lists `actions`):
 * "Answer…" (and a click on the notification) opens the answer window, a quick reply answers at once.
 * Which buttons, and what a click means, is `question-actions.ts`; this file only sends and listens.
 * In `dialog` mode (`channel.desktop.mode`, read per question) the window opens instead.
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

import type { QuestionChannel, QuestionMessage, ServeUser } from '@lotse/core';

import {
  deliveryFor,
  notificationActions,
  notificationHints,
  NotificationRegistry,
} from './question-actions.ts';
import type { DesktopMode } from './settings.ts';
import { stderrChannel } from './stderr-channel.ts';

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';

export interface DesktopChannelOptions {
  readonly onProblem: (problem: string) => void;
  /** `channel.desktop.mode` as the settings file says now. */
  readonly mode: () => DesktopMode;
  /** Whether the answer window can open here (`dialogCommand`). Without it: no "Answer…", no dialog mode. */
  readonly dialog: boolean;
  /** A quick reply: answer the question with this text, as `lotse answer` would. */
  readonly onAnswer: (questionId: string, text: string) => void;
  /** Open the answer window for the question. */
  readonly onDialog: (questionId: string) => void;
}

function capabilitiesOf(bus: Gio.DBusConnection): string[] {
  try {
    const reply = bus.call_sync(
      NAME,
      PATH,
      NAME,
      'GetCapabilities',
      null,
      null,
      Gio.DBusCallFlags.NONE,
      5_000,
      null,
    );
    return (reply.deepUnpack() as [string[]])[0];
  } catch {
    return [];
  }
}

export function desktopChannel(options: DesktopChannelOptions): QuestionChannel {
  const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  const capabilities = capabilitiesOf(bus);
  const registry = new NotificationRegistry();
  bus.signal_subscribe(NAME, NAME, 'ActionInvoked', PATH, null, Gio.DBusSignalFlags.NONE, (...args) => {
    const [id, key] = (args[5] as GLib.Variant).deepUnpack() as [number, string];
    const hit = registry.invoked(id, key);
    if (!hit) return;
    if (hit.intent.kind === 'dialog') options.onDialog(hit.questionId);
    else options.onAnswer(hit.questionId, hit.intent.text);
  });
  bus.signal_subscribe(NAME, NAME, 'NotificationClosed', PATH, null, Gio.DBusSignalFlags.NONE, (...args) => {
    const [id] = (args[5] as GLib.Variant).deepUnpack() as [number, number];
    registry.closed(id);
  });

  return {
    name: 'desktop',
    send: (user: ServeUser, message: QuestionMessage) => {
      const { questionId, asks } = message;
      if (questionId && deliveryFor(options.mode(), asks, options.dialog) === 'dialog') {
        options.onDialog(questionId);
        return;
      }
      const actions = questionId ? notificationActions(asks, capabilities, options.dialog) : [];
      const hints = notificationHints(asks);
      try {
        const reply = bus.call_sync(
          NAME,
          PATH,
          NAME,
          'Notify',
          new GLib.Variant('(susssasa{sv}i)', [
            'Lotse',
            0,
            // Only used when the shell finds no app for the desktop entry; the symbolic names exist in Adwaita.
            questionId ? 'dialog-question-symbolic' : 'dialog-information-symbolic',
            message.title,
            message.body,
            actions,
            {
              'desktop-entry': new GLib.Variant('s', hints.desktopEntry),
              transient: new GLib.Variant('b', hints.transient),
            },
            -1,
          ]),
          null,
          Gio.DBusCallFlags.NONE,
          5_000,
          null,
        );
        if (questionId && actions.length > 0) {
          registry.remember((reply.deepUnpack() as [number])[0], questionId);
        }
      } catch (error) {
        options.onProblem(
          `desktop notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        stderrChannel().send(user, message);
      }
    },
  };
}
