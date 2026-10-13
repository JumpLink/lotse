/**
 * The provider settings page (#45): draws `ProviderSettingsController`'s state and passes clicks back.
 *
 * **Nothing here decides anything**, the same split as `login-dialog.ts`: which provider is listed, what
 * a host's `modelPolicy` hides, whether a URL is accepted, what a privacy note says — all of it is
 * `core/custom/settings.ts`, tested without a display. This file turns one `ProviderSettingsState` into
 * groups and a click into a controller call.
 *
 * **The page owns its controller's lifetime by being on screen.** `map` makes a controller (and with it
 * a private server), `unmap` closes it, so a preferences dialog that is never opened starts nothing and
 * one that is closed leaves no process behind. Connecting a provider is not drawn here: "Connect…" hands
 * over to the host's login (`LotseChat.openLogin`), which is the one login dialog, and the page reloads
 * once it reports back.
 *
 * Every string from a provider or a config file (a name, an id, a URL, a path, an error) is plain text
 * (`useMarkup: false`). The key typed into the add form stays in its `Adw.PasswordEntryRow` until the one
 * `addCustom` call that hands it over, and the form is destroyed after a save.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
  _,
  _n,
  fmt,
  CUSTOM_PRESETS,
  parseModelSpecs,
  type AddOutcome,
  type CustomProviderInput,
  type ProviderSettingsController,
  type ProviderSettingsState,
  type ProviderSettingsView,
} from '@lotse/core';

const FORM_WIDTH_PX = 460;

export interface ProviderSettingsHooks {
  /** A new controller — one per time the page is shown. */
  createController(): ProviderSettingsController;
  /** Open the login dialog; `done` after a successful login, so the page reads the list again. */
  connect(done: () => void): void;
}

function plainLabel(text: string, cssClasses: string[] = []): Gtk.Label {
  return new Gtk.Label({
    label: text,
    wrap: true,
    xalign: 0,
    useMarkup: false,
    selectable: false,
    cssClasses,
  });
}

function rowButton(label: string, onClick: () => void, cssClasses: string[] = ['flat']): Gtk.Button {
  const widget = new Gtk.Button({ label, valign: Gtk.Align.CENTER, cssClasses });
  widget.connect('clicked', onClick);
  return widget;
}

/** "Really?" for a step that throws something away. `true` only on the destructive answer. */
function confirm(parent: Gtk.Widget, heading: string, body: string, yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = new Adw.AlertDialog({ heading, body, bodyUseMarkup: false });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('yes', yes);
    dialog.set_response_appearance('yes', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => resolve(response === 'yes'));
    dialog.present(parent);
  });
}

export class ProviderSettingsPage {
  readonly page: Adw.PreferencesPage;
  readonly #hooks: ProviderSettingsHooks;
  #controller: ProviderSettingsController | null = null;
  #unsubscribe: (() => void) | null = null;
  #groups: Adw.PreferencesGroup[] = [];

  constructor(hooks: ProviderSettingsHooks) {
    this.#hooks = hooks;
    this.page = new Adw.PreferencesPage({
      name: 'providers',
      title: 'Providers',
      iconName: 'network-server-symbolic',
    });
    this.page.connect('map', () => this.#start());
    this.page.connect('unmap', () => this.#stop());
  }

  /** The step on screen — a dev hook waits on it. */
  get step(): ProviderSettingsState['step'] {
    return this.#controller?.state.step ?? 'closed';
  }

  #start(): void {
    if (this.#controller) return;
    const controller = this.#hooks.createController();
    this.#controller = controller;
    this.#unsubscribe = controller.subscribe((state) => this.#render(state));
    this.#render(controller.state);
    void controller.open();
  }

  #stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const closing = this.#controller;
    this.#controller = null;
    // `close` lets a change in flight finish before it stops the server.
    void closing?.close();
  }

  #group(options: Partial<Adw.PreferencesGroup.ConstructorProps> = {}): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup(options);
    this.page.add(group);
    this.#groups.push(group);
    return group;
  }

  #render(state: ProviderSettingsState): void {
    for (const group of this.#groups) this.page.remove(group);
    this.#groups = [];
    const controller = this.#controller;
    if (!controller) return;
    switch (state.step) {
      case 'starting': {
        const group = this.#group();
        const box = new Gtk.Box({ spacing: 12 });
        box.append(new Gtk.Spinner({ spinning: true }));
        box.append(plainLabel(_('Reading the providers…')));
        group.add(box);
        return;
      }
      case 'unavailable':
        this.#group({ title: _('Providers') }).add(plainLabel(state.reason));
        return;
      case 'failed': {
        const group = this.#group({ title: _('Providers') });
        group.add(plainLabel(state.message, ['error']));
        group.set_header_suffix(rowButton(_('Try again'), () => void controller.reload()));
        return;
      }
      case 'ready':
        this.#renderReady(controller, state.view);
        return;
      case 'closed':
        return;
    }
  }

  #renderReady(controller: ProviderSettingsController, view: ProviderSettingsView): void {
    const idle = view.busy === null;
    if (view.message) this.#group().add(plainLabel(view.message, ['caption']));

    const connected = this.#group({
      title: _('Connected providers'),
      description: view.connectedReadOnlyReason ?? _('The logins and keys the agent holds.'),
    });
    const connect = rowButton(_('Connect…'), () => this.#hooks.connect(() => void controller.reload()));
    connect.set_sensitive(idle);
    connected.set_header_suffix(connect);
    if (view.connected.length === 0)
      connected.add(new Adw.ActionRow({ title: _('No provider connected yet') }));
    for (const provider of view.connected) {
      const notes = [
        fmt(_n('{n} model', '{n} models', provider.models), { n: provider.models }),
        ...(provider.offered ? [] : [_('not used by this app')]),
      ];
      const row = new Adw.ActionRow({ title: provider.name, subtitle: notes.join(' · '), useMarkup: false });
      connected.add(row);
      if (!provider.removable) continue;
      const logout = rowButton(view.busy === provider.id ? _('Logging out…') : _('Log out'), () => {
        void confirm(
          this.page,
          fmt(_('Log out of {provider}?'), { provider: provider.name }),
          _('The agent forgets the login or key. You can connect again at any time.'),
          _('Log out'),
        ).then((yes) => (yes ? controller.disconnect(provider.id) : undefined));
      });
      logout.set_sensitive(idle);
      row.add_suffix(logout);
    }

    if (view.custom) {
      const custom = this.#group({
        title: _('Custom providers'),
        description:
          view.custom.readOnlyReason ??
          _('An OpenAI-compatible server of your own — Ollama, LM Studio, llama.cpp, vLLM or a gateway.'),
      });
      if (view.custom.editable) {
        const add = rowButton(_('Add…'), () => this.#openAddForm(controller));
        add.set_sensitive(idle);
        custom.set_header_suffix(add);
      }
      if (view.custom.providers.length === 0) custom.add(new Adw.ActionRow({ title: _('None added') }));
      for (const provider of view.custom.providers) {
        const lines = [
          [provider.baseUrl ?? _('no URL'), provider.keyStored ? _('key stored') : null]
            .filter(Boolean)
            .join(' · '),
          provider.models.join(', ') || _('no models listed'),
          ...(provider.offered ? [] : [_('not used by this app')]),
          ...(provider.removable ? [] : [fmt(_('written in {source}'), { source: provider.source })]),
          ...(provider.privacyNote ? [provider.privacyNote] : []),
        ];
        const row = new Adw.ActionRow({
          title: provider.name,
          subtitle: lines.join('\n'),
          useMarkup: false,
          subtitleLines: 0,
        });
        if (provider.removable) {
          const remove = rowButton(view.busy === provider.id ? _('Removing…') : _('Remove'), () => {
            void confirm(
              this.page,
              fmt(_('Remove {provider}?'), { provider: provider.name }),
              _('Its entry and any key stored for it are deleted.'),
              _('Remove'),
            ).then((yes) => (yes ? controller.removeCustom(provider.id) : undefined));
          });
          remove.set_sensitive(idle);
          row.add_suffix(remove);
        }
        custom.add(row);
      }
    }

    const privacy = this.#group({ title: 'Privacy' });
    for (const note of view.privacy) privacy.add(plainLabel(note, ['dim-label']));
  }

  /** The add form: a preset, the fields it does not fill, the models and an optional key. */
  #openAddForm(controller: ProviderSettingsController): void {
    const dialog = new Adw.Dialog({ title: _('Add a custom provider'), contentWidth: FORM_WIDTH_PX });
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      marginTop: 18,
      marginBottom: 24,
      marginStart: 18,
      marginEnd: 18,
    });
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(content);
    dialog.set_child(toolbar);

    const presets = [...CUSTOM_PRESETS, null];
    const form = new Adw.PreferencesGroup();
    const preset = new Adw.ComboRow({
      title: _('Server'),
      model: Gtk.StringList.new(presets.map((entry) => entry?.name ?? _('Other'))),
    });
    const id = new Adw.EntryRow({ title: _('Id (lowercase, e.g. local-ollama)') });
    const name = new Adw.EntryRow({ title: _('Name') });
    const url = new Adw.EntryRow({ title: _('Base URL (…/v1)') });
    const models = new Adw.EntryRow({ title: _('Models (empty: ask the server; model=context to set one)') });
    const key = new Adw.PasswordEntryRow({ title: _('API key (optional)') });
    for (const row of [preset, id, name, url, models, key]) form.add(row);
    // A preset fills the fields it knows; the person may still change every one of them.
    const fill = (): void => {
      const chosen = presets[preset.get_selected()] ?? null;
      id.set_text(chosen?.id ?? '');
      name.set_text(chosen?.name ?? '');
      url.set_text(chosen?.baseUrl ?? '');
    };
    preset.connect('notify::selected', fill);
    fill();
    content.append(form);

    const problem = plainLabel('', ['error']);
    problem.set_visible(false);
    content.append(problem);
    const save = new Gtk.Button({
      label: _('Add'),
      cssClasses: ['suggested-action', 'pill'],
      halign: Gtk.Align.CENTER,
    });
    content.append(save);
    const say = (text: string): void => {
      problem.set_label(text);
      problem.set_visible(true);
    };

    const submit = async (confirmedLan: boolean): Promise<void> => {
      const specs = parseModelSpecs(
        models
          .get_text()
          .split(/[\s,]+/)
          .filter((entry) => entry !== ''),
      );
      if (typeof specs === 'string') return say(specs);
      const chosen = presets[preset.get_selected()] ?? null;
      const text = (row: Adw.EntryRow): string | undefined => row.get_text().trim() || undefined;
      const input: CustomProviderInput = {
        ...(chosen ? { preset: chosen.id } : {}),
        ...(text(id) ? { id: text(id) } : {}),
        ...(text(name) ? { name: text(name) } : {}),
        ...(text(url) ? { baseUrl: text(url) } : {}),
        models: specs,
        confirmedLan,
      };
      save.set_sensitive(false);
      let outcome: AddOutcome;
      try {
        outcome = await controller.addCustom(input, key.get_text() || undefined);
      } finally {
        save.set_sensitive(true);
      }
      switch (outcome.kind) {
        case 'refused':
          return say(outcome.reason);
        case 'confirm': {
          const body = [outcome.question, outcome.privacyNote].filter(Boolean).join('\n\n');
          if (await confirm(dialog, _('Plain http on your network?'), body, _('Use it'))) await submit(true);
          return;
        }
        case 'added':
          this.#showAdded(dialog, content, outcome.notes);
          return;
      }
    };
    save.connect('clicked', () => void submit(false));
    dialog.present(this.page);
  }

  /** The form replaced by what the person should know now: the privacy note, warnings, the size hint. */
  #showAdded(dialog: Adw.Dialog, content: Gtk.Box, notes: readonly string[]): void {
    let child = content.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      content.remove(child);
      child = next;
    }
    // Whether the agent could be restarted is the line under the group (`view.message`), not claimed here.
    content.append(plainLabel(_('Saved.'), ['title-3']));
    for (const note of notes) content.append(plainLabel(note));
    const done = new Gtk.Button({
      label: _('Done'),
      cssClasses: ['suggested-action', 'pill'],
      halign: Gtk.Align.CENTER,
    });
    done.connect('clicked', () => dialog.close());
    content.append(done);
  }
}
