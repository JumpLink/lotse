/**
 * The preferences dialog: which agent lotse connects to, how `lotse serve` asks, and which chat requests
 * it takes.
 *
 * **Action rows with radio check buttons, not an `Adw.ComboRow`.** A combo row shows one line per item
 * and no subtitle, so the path and version that tell "my opencode" from "the bundled one" would be lost —
 * and the popover is the widget the devtools plane cannot operate (`hooks.ts`). A group of rows wraps its
 * subtitles at 360 px and every choice is visible at once. Titles and subtitles are plain text
 * (`useMarkup: false`): a path may contain `&`.
 *
 * What is listed is decided in `core/settings-view.ts`; this file renders it and passes a choice back.
 * **An unavailable row is selectable**: the choice may be for an install that is coming, and the note says
 * what runs meanwhile. A write that fails is shown here, and the rows are re-read so they show what the
 * file really holds. A settings file lotse must not overwrite locks the rows (`ChoicesView.readOnly`).
 *
 * **The dialog opens before the host has answered.** `load(null)` is the cheap view; where a host question
 * exists (a Flatpak) `detect()` runs it asynchronously, and the rows are drawn again from its result. A
 * dialog closed in the meantime ignores the late answer, and `ready()` is what a dev hook waits on.
 *
 * **More pages come from the caller** (`extraPages`): the widget's provider settings (#45) are the
 * conversation's, not this dialog's, so the window hands them in and this file only lays them out.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  requestSettings,
  type AgentChoice,
  type ChannelName,
  type MessengerSettings,
  type RequestSettings,
  type ResolveContext,
} from '@lotse/core';
import {
  formatEnvSpecs,
  formatServerSpecs,
  keepServerEnv,
  parseEnvSpecs,
  parseServerSpecs,
  withServerEnv,
  type DesktopMode,
} from '../../core/settings.ts';
import { choiceFromKey, type ChoicesView } from '../../core/settings-view.ts';

/** What the host detection found; the part of a `ResolveContext` the rows are built from. */
export type HostDetection = Pick<ResolveContext, 'detections' | 'bundledAvailable'>;

export interface PreferencesActions {
  /**
   * Read the settings file and build the rows, with no child process. `null` is before the host has
   * answered (host rows pending); after `detect()` it is called with the answer. Called on open and after
   * every choice.
   */
  readonly load: (detected: HostDetection | null) => ChoicesView;
  /** The host detection, or `null` when there is nothing to wait for. Must not reject. */
  readonly detect: (() => Promise<HostDetection>) | null;
  /**
   * Persist a choice (`null` = Automatic). Returns where an old file was moved, if one was. Throws when
   * the file cannot be written or must not be overwritten.
   */
  readonly save: (choice: AgentChoice | null) => { readonly backup: string | null };
  /** `channel.desktop.mode` as the settings file says now. */
  readonly loadMode: () => DesktopMode;
  /** Persist the mode; throws like `save`. */
  readonly saveMode: (mode: DesktopMode) => { readonly backup: string | null };
  /** `channel.active` and `channel.messenger` as the settings file says now. */
  readonly loadMessenger: () => MessengerForm;
  /** Persist both; throws like `save`. */
  readonly saveMessenger: (form: MessengerForm) => { readonly backup: string | null };
}

export interface MessengerForm {
  readonly active: readonly ChannelName[];
  readonly messenger: MessengerSettings;
}

/** What `select` did, so a caller never claims a write that did not happen. */
export type SelectOutcome = 'chose' | 'unchanged' | 'refused' | 'failed' | 'missing';

const SCOPE_LINE = 'A change applies the next time lotse starts. This window keeps its agent.';

const MODE_LINE = 'How lotse serve shows a question an agent asks. A change applies to the next question.';

const MODE_ROWS: readonly {
  readonly mode: DesktopMode;
  readonly title: string;
  readonly subtitle: string;
}[] = [
  {
    mode: 'notification',
    title: 'Notification',
    subtitle: 'Buttons answer in a window, or allow and decline at once.',
  },
  { mode: 'dialog', title: 'Answer window', subtitle: 'The window opens as soon as a question arrives.' },
];

const MESSENGER_LINE =
  'Also ask in a chat, through an MCP server such as curlew, and read the reply as the answer. The first answer wins. A change applies within a minute to a running lotse serve; runs under way finish as they were.';

type MessengerField = 'command' | 'args' | 'account' | 'peer' | 'sendTool' | 'waitTool';

const MESSENGER_FIELDS: readonly { readonly field: MessengerField; readonly title: string }[] = [
  { field: 'command', title: 'MCP server command' },
  { field: 'args', title: 'Arguments (separated by spaces)' },
  { field: 'account', title: 'Account' },
  { field: 'peer', title: 'Send to' },
  { field: 'sendTool', title: 'Send tool' },
  { field: 'waitTool', title: 'Wait-for-reply tool' },
];

const REQUESTS_LINE =
  'A message that answers no question starts an agent run, and the answer comes back in the chat. A change applies the next time lotse serve starts.';

type RequestField = 'prefix' | 'profile' | 'preamble' | 'cwd' | 'mcpServers' | 'mcpEnv';

const REQUEST_FIELDS: readonly { readonly field: RequestField; readonly title: string }[] = [
  { field: 'prefix', title: 'Prefix that always starts a request' },
  { field: 'profile', title: 'Profile (from tasks.json)' },
  { field: 'preamble', title: 'Preamble for a new session' },
  { field: 'cwd', title: 'Working directory (empty: home)' },
  { field: 'mcpServers', title: 'MCP servers (name=command args; …)' },
  { field: 'mcpEnv', title: 'MCP server environment (server:NAME=value; …)' },
];

export class PreferencesDialog {
  readonly #actions: PreferencesActions;
  readonly #extraPages: () => Adw.PreferencesPage[];
  #dialog: Adw.PreferencesDialog | null = null;
  #group: Adw.PreferencesGroup | null = null;
  #note: Gtk.Label | null = null;
  #rows: Adw.ActionRow[] = [];
  readonly #checks = new Map<string, Gtk.CheckButton>();
  #modes: Adw.PreferencesGroup | null = null;
  #messenger: Adw.PreferencesGroup | null = null;
  #requests: Adw.PreferencesGroup | null = null;
  readonly #modeChecks = new Map<DesktopMode, Gtk.CheckButton>();
  #rendering = false;
  #error: string | null = null;
  #backup: string | null = null;
  #detected: HostDetection | null = null;
  #readOnly = false;
  #saved = false;
  #ready: Promise<void> = Promise.resolve();

  /** `extraPages` is asked on every open: a page starts its own server when shown, so it is built fresh. */
  constructor(actions: PreferencesActions, extraPages: () => Adw.PreferencesPage[] = () => []) {
    this.#actions = actions;
    this.#extraPages = extraPages;
  }

  show(parent: Gtk.Widget): void {
    if (this.#dialog) return;
    const dialog = new Adw.PreferencesDialog({ title: 'Preferences' });
    const page = new Adw.PreferencesPage({
      name: 'agent',
      title: 'Agent',
      iconName: 'utilities-terminal-symbolic',
    });
    const noteGroup = new Adw.PreferencesGroup();
    // Plain text: the note carries paths and error messages, and a path may contain `&`.
    const note = new Gtk.Label({ wrap: true, xalign: 0, visible: false, useMarkup: false });
    noteGroup.add(note);
    const group = new Adw.PreferencesGroup({ title: 'Agent', description: SCOPE_LINE });
    page.add(noteGroup);
    page.add(group);
    page.add(this.#modeGroup());
    page.add(this.#messengerGroup());
    page.add(this.#requestsGroup());
    dialog.add(page);
    for (const extra of this.#extraPages()) dialog.add(extra);
    this.#dialog = dialog;
    this.#group = group;
    this.#note = note;
    this.#error = null;
    this.#backup = null;
    this.#detected = null;
    dialog.connect('closed', () => {
      if (this.#dialog === dialog) this.#dialog = null;
      this.#rows = [];
      this.#checks.clear();
      this.#modes = null;
      this.#messenger = null;
      this.#requests = null;
      this.#modeChecks.clear();
    });
    this.#render();
    dialog.present(parent);
    const { detect } = this.#actions;
    if (detect) {
      this.#ready = detect().then(
        (detected) => {
          // A dialog closed (or reopened) while the host answered ignores the late result.
          if (this.#dialog !== dialog) return;
          this.#detected = detected;
          this.#render();
        },
        () => undefined,
      );
    } else {
      this.#ready = Promise.resolve();
    }
  }

  /** Show a page by name (`agent`, or a page the caller added); `false` when there is none. */
  showPage(name: string): boolean {
    const dialog = this.#dialog;
    if (!dialog) return false;
    // An unknown name leaves the visible page as it was, so reading it back is the answer.
    dialog.visiblePageName = name;
    return dialog.visiblePageName === name;
  }

  /** Resolves once the rows are final: at once when nothing is detected asynchronously. */
  ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * Choose a row by key, the way a click on it does — `LOTSE_APP_PREFERENCES_AGENT` calls this. Only
   * `'chose'` means a write happened.
   */
  select(key: string): SelectOutcome {
    const check = this.#checks.get(key);
    if (!check) return 'missing';
    if (this.#readOnly) return 'refused';
    if (check.active) return 'unchanged';
    this.#saved = false;
    check.set_active(true);
    return this.#saved ? 'chose' : 'failed';
  }

  #render(): void {
    const group = this.#group;
    const note = this.#note;
    if (!group || !note) return;
    let view: ChoicesView;
    try {
      view = this.#actions.load(this.#detected);
    } catch (error) {
      view = {
        rows: [],
        note: `Could not read the settings: ${error instanceof Error ? error.message : String(error)}`,
        readOnly: true,
      };
    }
    this.#readOnly = view.readOnly;
    group.set_sensitive(!view.readOnly);
    this.#rendering = true;
    for (const row of this.#rows) group.remove(row);
    this.#rows = [];
    this.#checks.clear();
    let first: Gtk.CheckButton | null = null;
    for (const entry of view.rows) {
      const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: entry.selected });
      if (first) check.set_group(first);
      else first = check;
      const row = new Adw.ActionRow({
        title: entry.title,
        subtitle: entry.subtitle,
        useMarkup: false,
        activatableWidget: check,
      });
      row.add_prefix(check);
      if (!entry.available) row.add_css_class('dim-label');
      check.connect('toggled', () => {
        if (this.#rendering || !check.active) return;
        this.#choose(entry.key);
      });
      group.add(row);
      this.#rows.push(row);
      this.#checks.set(entry.key, check);
    }
    // One file holds both choices, so a file lotse must not overwrite locks both groups.
    this.#modes?.set_sensitive(!view.readOnly);
    this.#messenger?.set_sensitive(!view.readOnly);
    this.#requests?.set_sensitive(!view.readOnly);
    this.#modeChecks.get(this.#currentMode())?.set_active(true);
    this.#rendering = false;
    const moved = this.#backup === null ? null : `The earlier settings file was moved to ${this.#backup}.`;
    const lines = [this.#error, moved, view.note].filter((line): line is string => line !== null);
    note.set_label(lines.join('\n'));
    note.set_visible(lines.length > 0);
    note.set_css_classes(['caption', this.#error !== null ? 'error' : 'warning']);
  }

  #modeGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Questions', description: MODE_LINE });
    const current = this.#currentMode();
    let first: Gtk.CheckButton | null = null;
    for (const entry of MODE_ROWS) {
      const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: entry.mode === current });
      if (first) check.set_group(first);
      else first = check;
      const row = new Adw.ActionRow({
        title: entry.title,
        subtitle: entry.subtitle,
        useMarkup: false,
        activatableWidget: check,
      });
      row.add_prefix(check);
      check.connect('toggled', () => {
        if (this.#rendering || !check.active) return;
        this.#chooseMode(entry.mode);
      });
      group.add(row);
      this.#modeChecks.set(entry.mode, check);
    }
    this.#modes = group;
    return group;
  }

  #messengerGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Messenger', description: MESSENGER_LINE });
    const form = this.#currentMessenger();
    for (const name of ['desktop', 'messenger'] as const) {
      const row = new Adw.SwitchRow({
        title: name === 'desktop' ? 'Ask on the desktop' : 'Ask in the messenger',
        active: form.active.includes(name),
      });
      row.connect('notify::active', () => {
        if (this.#rendering) return;
        const now = this.#currentMessenger();
        const rest = now.active.filter((other) => other !== name);
        this.#saveMessenger({ ...now, active: row.active ? [...rest, name] : rest });
      });
      group.add(row);
    }
    for (const { field, title } of MESSENGER_FIELDS) {
      const text = field === 'args' ? form.messenger.args.join(' ') : form.messenger[field];
      const row = new Adw.EntryRow({ title, text, showApplyButton: true });
      row.connect('apply', () => {
        const now = this.#currentMessenger();
        const value = row.get_text().trim();
        const messenger = {
          ...now.messenger,
          [field]: field === 'args' ? value.split(/\s+/).filter((word) => word !== '') : value,
        };
        this.#saveMessenger({ ...now, messenger });
      });
      group.add(row);
    }
    this.#messenger = group;
    return group;
  }

  #requestsGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: 'Requests from the chat', description: REQUESTS_LINE });
    const current = requestSettings(this.#currentMessenger().messenger);
    const save = (change: Partial<RequestSettings>): void => {
      const now = this.#currentMessenger();
      const requests = { ...requestSettings(now.messenger), ...change };
      this.#saveMessenger({ ...now, messenger: { ...now.messenger, requests } });
    };
    const enabled = new Adw.SwitchRow({ title: 'Start a run for a chat message', active: current.enabled });
    enabled.connect('notify::active', () => {
      if (!this.#rendering) save({ enabled: enabled.active });
    });
    group.add(enabled);
    for (const { field, title } of REQUEST_FIELDS) {
      const text =
        field === 'mcpServers'
          ? formatServerSpecs(current.mcpServers)
          : field === 'mcpEnv'
            ? formatEnvSpecs(current.mcpServers)
            : current[field];
      const row = new Adw.EntryRow({ title, text, showApplyButton: true });
      row.connect('apply', () => {
        const value = row.get_text().trim();
        if (field === 'mcpServers') {
          const servers = parseServerSpecs(value);
          if ('problem' in servers) return this.#showError(`MCP servers: ${servers.problem}`);
          return save({
            mcpServers: keepServerEnv(
              servers,
              requestSettings(this.#currentMessenger().messenger).mcpServers,
            ),
          });
        }
        if (field === 'mcpEnv') {
          const byServer = parseEnvSpecs(value);
          if ('problem' in byServer) return this.#showError(`MCP server environment: ${byServer.problem}`);
          const servers = withServerEnv(
            requestSettings(this.#currentMessenger().messenger).mcpServers,
            byServer,
          );
          if ('problem' in servers) return this.#showError(`MCP server environment: ${servers.problem}`);
          return save({ mcpServers: servers });
        }
        if (field === 'prefix' && value === '') return this.#showError('The prefix must not be empty.');
        save({ [field]: value });
      });
      group.add(row);
    }
    const confirm = new Adw.SwitchRow({
      title: 'Ask before a write',
      subtitle: 'Off: a request may only read, and every permission request is declined.',
      active: current.rights === 'confirm',
    });
    confirm.connect('notify::active', () => {
      if (!this.#rendering) save({ rights: confirm.active ? 'confirm' : 'read' });
    });
    group.add(confirm);
    const minutes = Adw.SpinRow.new_with_range(0, 1440, 5);
    minutes.set_title('Follow-up window (minutes)');
    minutes.set_subtitle('A message this soon after an answer continues that session. 0: never.');
    minutes.set_value(current.followUpMinutes);
    minutes.connect('notify::value', () => {
      if (!this.#rendering) save({ followUpMinutes: Math.round(minutes.get_value()) });
    });
    group.add(minutes);
    const concurrent = Adw.SpinRow.new_with_range(1, 16, 1);
    concurrent.set_title('Runs at the same time');
    concurrent.set_value(current.maxConcurrent);
    concurrent.connect('notify::value', () => {
      if (!this.#rendering) save({ maxConcurrent: Math.round(concurrent.get_value()) });
    });
    group.add(concurrent);
    const person = Adw.SpinRow.new_with_range(1, 1440, 5);
    person.set_title('Wait for you (minutes)');
    person.set_subtitle('How long a task waits when only you can go on. Then it is deferred.');
    person.set_value(current.personNeededMinutes);
    person.connect('notify::value', () => {
      if (!this.#rendering) save({ personNeededMinutes: Math.round(person.get_value()) });
    });
    group.add(person);
    this.#requests = group;
    return group;
  }

  #showError(message: string): void {
    this.#error = message;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this.#dialog) this.#render();
      return GLib.SOURCE_REMOVE;
    });
  }

  #currentMessenger(): MessengerForm {
    return this.#actions.loadMessenger();
  }

  #saveMessenger(form: MessengerForm): void {
    if (this.#readOnly) return;
    try {
      const { backup } = this.#actions.saveMessenger(form);
      if (backup !== null) this.#backup = backup;
      this.#error = null;
    } catch (error) {
      this.#error = `Could not save your choice: ${error instanceof Error ? error.message : String(error)}`;
    }
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this.#dialog) this.#render();
      return GLib.SOURCE_REMOVE;
    });
  }

  #currentMode(): DesktopMode {
    try {
      return this.#actions.loadMode();
    } catch {
      return MODE_ROWS[0]!.mode;
    }
  }

  #chooseMode(mode: DesktopMode): void {
    if (this.#readOnly) return;
    try {
      const { backup } = this.#actions.saveMode(mode);
      if (backup !== null) this.#backup = backup;
      this.#error = null;
    } catch (error) {
      this.#error = `Could not save your choice: ${error instanceof Error ? error.message : String(error)}`;
    }
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this.#dialog) this.#render();
      return GLib.SOURCE_REMOVE;
    });
  }

  #choose(key: string): void {
    const choice = choiceFromKey(key);
    if (choice === undefined || this.#readOnly) return;
    try {
      const { backup } = this.#actions.save(choice);
      if (backup !== null) this.#backup = backup;
      this.#error = null;
      this.#saved = true;
    } catch (error) {
      this.#error = `Could not save your choice: ${error instanceof Error ? error.message : String(error)}`;
    }
    // After the handler returns: the widget that emitted `toggled` must not be removed from inside it.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this.#dialog) this.#render();
      return GLib.SOURCE_REMOVE;
    });
  }
}
