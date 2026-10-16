/**
 * The inline provider onboarding page: an `Adw.StatusPage` that draws one `OnboardingView`.
 *
 * **Nothing here decides.** Whether the page shows at all, and what it says, is `onboardingView` in
 * `@lotse/core`, tested without a display; this file turns that view into widgets and a click into one
 * of two callbacks. The login itself is the existing dialog (`login-dialog.ts`) — this page only leads to
 * it. Every string goes into a label with `useMarkup: false`.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { onboardingView, type OnboardingInput, type OnboardingView } from '@lotse/core';

import { CSS } from './css.ts';

export interface OnboardingHandlers {
  /** "Connect a provider…": open the login dialog. */
  readonly onConnect: () => void;
  /** "Use free hosted models": carry on to the ordinary chat page. */
  readonly onContinue: () => void;
}

/**
 * The onboarding page for a host that shows it itself — or `null` when there is nothing to show.
 *
 * **`null` is the answer a host must not invent.** Whether the offer appears at all is
 * `onboardingView`'s decision, and it says no in four different ways (the host did not ask for it, no
 * agent was found, no login could run, the person already has a provider or already dismissed it). A
 * host that drew the page from its own reading of those facts would be the "offer, never a wall" rule
 * reimplemented, and it would be reimplemented differently.
 */
export function createOnboardingPage(
  input: OnboardingInput,
  handlers: OnboardingHandlers,
): OnboardingPage | null {
  const view = onboardingView(input);
  if (view === null) return null;
  return new OnboardingPage(view, handlers);
}

function label(text: string, cssClasses: string[] = []): Gtk.Label {
  return new Gtk.Label({
    label: text,
    wrap: true,
    useMarkup: false,
    justify: Gtk.Justification.CENTER,
    maxWidthChars: 56,
    cssClasses,
  });
}

export class OnboardingPage {
  readonly widget: Adw.StatusPage;

  constructor(view: OnboardingView, handlers: OnboardingHandlers) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER });
    box.append(label(view.body));

    if (view.paths.length > 0) {
      const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
      for (const path of view.paths) {
        list.append(new Adw.ActionRow({ title: path.label, subtitle: path.detail, useMarkup: false }));
      }
      box.append(list);
    }

    const connect = new Gtk.Button({
      label: view.connect,
      cssClasses: ['suggested-action', 'pill'],
      halign: Gtk.Align.CENTER,
    });
    connect.connect('clicked', handlers.onConnect);
    box.append(connect);

    const free = new Gtk.Button({ label: view.free, cssClasses: ['pill'], halign: Gtk.Align.CENTER });
    free.connect('clicked', handlers.onContinue);
    box.append(free);
    box.append(label(view.freeNote, ['dim-label', 'caption']));

    this.widget = new Adw.StatusPage({
      iconName: 'dialog-password-symbolic',
      title: view.title,
      vexpand: true,
      cssClasses: ['compact', CSS.calm],
      child: box,
    });
  }
}
