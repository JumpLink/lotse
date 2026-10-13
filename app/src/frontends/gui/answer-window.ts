/**
 * The answer window: one question, a place to type, Send and Later (`core/answer-dialog.ts`).
 *
 * **It answers nothing itself.** Send writes `answerFrame(text)` to stdout and quits; the caller (`lotse
 * answer`, or `serve` after a click) hands the text to `answerQuestion`. Later — the button, Esc, closing
 * the window — quits without a frame. What is shown is `core/answer-view.ts`.
 *
 * **Its own application instance** (`NON_UNIQUE`): two questions open two windows, and an open main
 * window is not asked to show a question. GApplication never sees `--answer`, which it would refuse.
 *
 * The focus starts on the question, never on a button: a permission question's suggested button allows
 * a tool call, and an Enter meant for another window must not press it.
 */

import { _ } from '../../i18n.ts';
import Adw from '@girs/adw-1';
import Gdk from '@girs/gdk-4.0';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';
import { AdwaitaApp, runApplication } from '@gjsify/adwaita-app';

import { findQuestions, normalizeQuestionId, type Question } from '@lotse/core';

import { answerFrame } from '../../core/answer-dialog.ts';
import { answerView, type AnswerView } from '../../core/answer-view.ts';
import { servePaths } from '../../core/paths.ts';
import { questionBook } from '../../core/serve-state.ts';
import { APP_ID } from './constants.ts';

function readQuestion(idText: string): Question | null {
  const id = normalizeQuestionId(idText);
  if (!id) return null;
  const book = questionBook(
    servePaths().stateDir,
    () => new Date(),
    (problem) => console.error(`lotse: ${problem}`),
  );
  // Several users sharing an id is refused by `answerQuestion`; the window does not guess either.
  const found = findQuestions(book.read(), id);
  return found.length === 1 ? found[0]! : null;
}

function closedPage(view: AnswerView, close: () => void): Gtk.Widget {
  const button = new Gtk.Button({ label: _('Close'), halign: Gtk.Align.CENTER, cssClasses: ['pill'] });
  button.connect('clicked', close);
  return new Adw.StatusPage({
    iconName: 'dialog-question-symbolic',
    title: _('Nothing to answer'),
    description: view.closed ?? '',
    child: button,
  });
}

function createWindow(app: Adw.Application, view: AnswerView, send: (text: string) => void): Gtk.Window {
  const window = new Adw.ApplicationWindow({ application: app, defaultWidth: 520, defaultHeight: 440 });
  // Quit, not just close: anything holding the application (the devtools plane) must not keep a
  // caller waiting on a window nobody sees.
  const later = () => app.quit();
  window.connect('close-request', () => {
    app.quit();
    return false;
  });
  const header = new Adw.HeaderBar({
    titleWidget: new Adw.WindowTitle({ title: view.title, subtitle: view.subtitle }),
  });
  const toolbar = new Adw.ToolbarView();
  toolbar.add_top_bar(header);
  window.set_content(toolbar);

  if (view.closed !== null) {
    toolbar.set_content(closedPage(view, later));
    return window;
  }

  const laterButton = new Gtk.Button({ label: _('Later') });
  laterButton.connect('clicked', later);
  header.pack_start(laterButton);

  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 12,
    marginTop: 12,
    marginBottom: 18,
    marginStart: 18,
    marginEnd: 18,
  });
  box.append(new Gtk.Label({ label: view.expiry, xalign: 0, cssClasses: ['caption', 'dim-label'] }));

  const question = new Gtk.Label({
    label: view.text,
    wrap: true,
    // A long path breaks too.
    wrapMode: Pango.WrapMode.WORD_CHAR,
    xalign: 0,
    yalign: 0,
    selectable: true,
    useMarkup: false,
    marginTop: 12,
    marginBottom: 12,
    marginStart: 12,
    marginEnd: 12,
  });
  const card = new Gtk.ScrolledWindow({
    child: question,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    vexpand: true,
    minContentHeight: 120,
    cssClasses: ['card'],
  });
  box.append(card);

  let submit: (() => void) | null = null;
  if (view.entry) {
    const entry = new Gtk.TextView({
      wrapMode: Gtk.WrapMode.WORD_CHAR,
      acceptsTab: false,
      topMargin: 8,
      bottomMargin: 8,
      leftMargin: 8,
      rightMargin: 8,
    });
    const field = new Gtk.ScrolledWindow({
      child: entry,
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      vexpand: true,
      minContentHeight: 96,
      cssClasses: ['card'],
    });
    box.append(new Gtk.Label({ label: _('Your answer'), xalign: 0, cssClasses: ['heading'] }));
    box.append(field);
    const sendButton = new Gtk.Button({
      label: _('Send'),
      sensitive: false,
      cssClasses: ['suggested-action'],
    });
    const typed = () => {
      const buffer = entry.get_buffer();
      return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
    };
    entry.get_buffer().connect('changed', () => sendButton.set_sensitive(typed() !== ''));
    submit = () => {
      const text = typed();
      if (text !== '') send(text);
    };
    sendButton.connect('clicked', submit);
    header.pack_end(sendButton);
    box.append(
      new Gtk.Label({
        label: _('Ctrl+Enter sends, Esc answers later.'),
        xalign: 0,
        cssClasses: ['caption', 'dim-label'],
      }),
    );
  }

  if (view.quickReplies.length > 0) {
    const replies = new Gtk.Box({ spacing: 12, halign: Gtk.Align.END });
    for (const reply of view.quickReplies) {
      const button = new Gtk.Button({
        label: reply.label,
        cssClasses: reply.suggested ? ['suggested-action'] : [],
      });
      button.connect('clicked', () => send(reply.text));
      replies.append(button);
    }
    box.append(replies);
  }
  toolbar.set_content(box);

  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_controller, keyval, _code, state) => {
    if (keyval === Gdk.KEY_Escape) {
      later();
      return true;
    }
    const enter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
    if (enter && (state & Gdk.ModifierType.CONTROL_MASK) !== 0 && submit) {
      submit();
      return true;
    }
    return false;
  });
  window.add_controller(keys);
  window.set_focus(question);
  return window;
}

/** Open the window for question `id` and resolve with the exit status once it is closed. */
export function runAnswerWindow(id: string): Promise<number> {
  const view = answerView(readQuestion(id), id, new Date());
  const app = new AdwaitaApp({
    applicationId: APP_ID,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
    quitAction: false,
    createWindow: (application) =>
      createWindow(application, view, (text) => {
        process.stdout.write(answerFrame(text));
        application.quit();
      }),
  });
  return runApplication(app, ['lotse-app']);
}
