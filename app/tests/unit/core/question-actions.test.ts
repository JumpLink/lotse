/**
 * The desktop channel's decisions without D-Bus: which buttons a notification gets, what a click on
 * one means, and when a question opens the window instead.
 */

import { describe, expect, it } from '@gjsify/unit';

import { APP_ID } from '../../../src/frontends/gui/constants.ts';
import {
  actionIntent,
  DESKTOP_ENTRY,
  deliveryFor,
  notificationActions,
  notificationHints,
  NotificationRegistry,
  quickReplyLabel,
} from '../../../src/core/question-actions.ts';

const WITH_ACTIONS = ['body', 'actions'];

export default async () => {
  await describe('notificationActions', async () => {
    await it('a permission gets Answer…, Allow once and Decline', async () => {
      expect(notificationActions('permission', WITH_ACTIONS, true)).toStrictEqual([
        'default',
        'Answer…',
        'answer',
        'Answer…',
        'reply:yes',
        'Allow once',
        'reply:no',
        'Decline',
      ]);
    });

    await it('a reply question gets only Answer…', async () => {
      expect(notificationActions('reply', WITH_ACTIONS, true)).toStrictEqual([
        'default',
        'Answer…',
        'answer',
        'Answer…',
      ]);
    });

    await it('a server without the actions capability gets the plain notification', async () => {
      expect(notificationActions('permission', ['body'], true)).toStrictEqual([]);
      expect(notificationActions('reply', [], true)).toStrictEqual([]);
    });

    await it('a message that asks nothing gets no buttons', async () => {
      expect(notificationActions(undefined, WITH_ACTIONS, true)).toStrictEqual([]);
    });

    await it('without a dialog there is no Answer… and no default, but the quick replies stay', async () => {
      expect(notificationActions('permission', WITH_ACTIONS, false)).toStrictEqual([
        'reply:yes',
        'Allow once',
        'reply:no',
        'Decline',
      ]);
      expect(notificationActions('reply', WITH_ACTIONS, false)).toStrictEqual([]);
    });
  });

  await describe('quickReplyLabel', async () => {
    await it('names a permission answer by what it does', async () => {
      expect(quickReplyLabel('yes', 'permission')).toBe('Allow once');
      expect(quickReplyLabel('no', 'permission')).toBe('Decline');
      expect(quickReplyLabel('yes', 'reply')).toBe('Yes');
      expect(quickReplyLabel('no', 'reply')).toBe('No');
    });
  });

  await describe('actionIntent', async () => {
    await it('maps every key lotse sends', async () => {
      expect(actionIntent('default')).toStrictEqual({ kind: 'dialog' });
      expect(actionIntent('answer')).toStrictEqual({ kind: 'dialog' });
      expect(actionIntent('reply:yes')).toStrictEqual({ kind: 'answer', text: 'yes' });
      expect(actionIntent('reply:no')).toStrictEqual({ kind: 'answer', text: 'no' });
    });

    await it('ignores a key it never sent', async () => {
      expect(actionIntent('reply:maybe')).toBeNull();
      expect(actionIntent('')).toBeNull();
    });
  });

  await describe('NotificationRegistry', async () => {
    await it('maps a click to the question its notification asked', async () => {
      const registry = new NotificationRegistry();
      registry.remember(7, 'A1');
      registry.remember(8, 'A2');
      expect(registry.invoked(8, 'reply:yes')).toStrictEqual({
        questionId: 'A2',
        intent: { kind: 'answer', text: 'yes' },
      });
      expect(registry.invoked(7, 'default')).toStrictEqual({ questionId: 'A1', intent: { kind: 'dialog' } });
    });

    await it('ignores another program’s notification and an unknown key', async () => {
      const registry = new NotificationRegistry();
      registry.remember(7, 'A1');
      expect(registry.invoked(99, 'reply:yes')).toBeNull();
      expect(registry.invoked(7, 'something-else')).toBeNull();
    });

    await it('forgets a closed notification', async () => {
      const registry = new NotificationRegistry();
      registry.remember(7, 'A1');
      registry.closed(7);
      expect(registry.size).toBe(0);
      expect(registry.invoked(7, 'reply:yes')).toBeNull();
    });
  });

  await describe('notificationHints', async () => {
    await it('keeps a question in the list', async () => {
      expect(notificationHints('reply')).toStrictEqual({ desktopEntry: DESKTOP_ENTRY, transient: false });
      expect(notificationHints('permission').transient).toBe(false);
    });

    await it('keeps a report out of the list', async () => {
      expect(notificationHints(undefined)).toStrictEqual({ desktopEntry: DESKTOP_ENTRY, transient: true });
    });

    await it('names the entry the GUI registers', async () => {
      expect(DESKTOP_ENTRY).toBe(APP_ID);
    });
  });

  await describe('deliveryFor', async () => {
    await it('opens the window only for a question, in dialog mode, when it can', async () => {
      expect(deliveryFor('dialog', 'reply', true)).toBe('dialog');
      expect(deliveryFor('dialog', 'permission', true)).toBe('dialog');
    });

    await it('falls back to the notification otherwise', async () => {
      expect(deliveryFor('notification', 'reply', true)).toBe('notification');
      expect(deliveryFor('dialog', undefined, true)).toBe('notification');
      expect(deliveryFor('dialog', 'reply', false)).toBe('notification');
    });
  });
};
