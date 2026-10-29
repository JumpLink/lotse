/**
 * `LotseChat` — one conversation as a widget, with the app around it taken away.
 *
 * **What this is.** Everything a chat surface is: the transcript, the composer with its model and
 * mode controls, the tool and thought cards, the approval dialog, the failure notices, the login,
 * and the three empty states that are about a conversation. It owns an `AgentSession` and therefore
 * one agent subprocess, and it renders what that session reports. A host slots it into a container
 * and passes what only a host can know — which agent, which directory, which MCP servers, and what
 * its own permission policy adds.
 *
 * **What this is not.** A window, a session list, a header bar, a menu, a preferences dialog, a
 * notices banner. `docs/adr/0001-lotse-as-an-embeddable-widget.md` draws that line and lotse's own
 * `app/src/frontends/gui/window.ts` is the first consumer on the other side of it: it keeps the
 * sidebar and the shell, and it is now one of several possible hosts rather than the only place the
 * chat exists.
 *
 * **This file decides nothing.** Every question it answers — may Send be pressed, what does the
 * status line say, is this failure still owed a dialog, what does a response id mean — is answered
 * by `@lotse/core`, and the widget's job is to pass the answer to a child and hand the child's
 * events back. That is the same rule `window.ts` was written under, and it is what made this split
 * possible at all: a surface with no decisions in it can be moved.
 *
 * **One agent subprocess for this whole widget, and the widget never touches it.** `AgentSession`
 * owns the process and the turns; this file passes it a callback for lines and one for snapshots. It
 * is the reason a person can click through thirty sessions without spawning thirty agents.
 *
 * **The two idle pages are the host's.** `closed` ("nothing is open") and `no-agent` are `Adw.Bin`
 * slots, because their copy can only be written by something that knows what surrounds the chat —
 * see `chat.blp`.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
// `Gdk` and `Gtk` for real, and only for one thing: the Esc controller that silences reading aloud
// (`#escapeToStop`). Everything else this file names of the two — the stack, the caption, the host
// slots — is a type, and the widgets that *build* something are in their own files. The namespaces
// were type-only imports until the key controller needed `new Gtk.EventControllerKey` and
// `Gdk.KEY_Escape` at runtime; the typelib was loaded either way, because `composer.ts` and the rest
// import them for real.
import Gdk from '@girs/gdk-4.0';
import Gtk from '@girs/gtk-4.0';

import type { AgentSource, SessionRecord, TranscriptEntry } from '@lotse/session';

import {
  _,
  fmt,
  AgentSession,
  LoginController,
  agentStatus,
  displayCwd,
  failureAction,
  failureToShow,
  FREE_MODEL_WARNING,
  freeModelWarningDue,
  keepsDraft,
  loginUnavailableReason,
  onboardingView,
  openLoginSession,
  probeConnections,
  providerOffered,
  readAloud,
  readAloudOffered,
  staleDialog,
  type AgentAttachment,
  type AgentCommand,
  type AgentSnapshot,
  type ComposerInput,
  type ConnectionFacts,
  type EmptyStateView,
  type FailureNotice,
  type HostToolPolicy,
  type McpServer,
  type ProfileSession,
  type ModelPolicy,
  type NotAnsweredReason,
  type OnboardingInput,
  type PermissionQuestion,
  type ReadAloud,
  type RecordedResolution,
  type SpeechEngine,
} from '@lotse/core';

import { Composer } from './composer.ts';
import { installWidgetCss } from './css.ts';
import { ConfigRow } from './config-row.ts';
import { FailureDialog } from './failure-dialog.ts';
import { LoginDialog } from './login-dialog.ts';
import { createOnboardingPage, type OnboardingPage } from './onboarding-page.ts';
import { PermissionDialog } from './permission-dialog.ts';
import { createProviderSettingsPage } from './provider-settings.ts';
import type { ToolPresenter } from './tool-line.ts';
import { TranscriptView } from './transcript-view.ts';
import Template from './chat.blp';

/**
 * What a host's own gate may answer about a question the agent asked.
 *
 * **Two words, and neither of them allows anything.** `'ask'` puts the question on screen, where a
 * person answers it; `'decline'` answers it without asking. There is deliberately no third value
 * that selects an option: a host may add a rule that *narrows* what the agent gets — "never in this
 * directory", "not while unattended" — and may not hand out an approval nobody gave. That is
 * guardrail 2 of `AGENTS.md` one layer up, and `lotse listen`'s own gate
 * (`docs/adr/0002-assistant-in-continuous-operation.md`) is written to the same shape.
 */
export type HostGateAnswer = 'ask' | 'decline';

/**
 * What `LotseChat` needs from the host around it.
 *
 * **`appendTurns` and `createSession` are callbacks rather than a store passed whole**, because the
 * widget's uses of a store have nothing to do with each other: one writes a record once, the other
 * writes a line per streamed chunk, and a `SessionStore` would drag `all`/`update`/`remove` in beside
 * them. A host that reads the same file for a list of its own (lotse's window does) keeps its own
 * handle on it, and the widget never becomes a second opinion about where sessions live.
 */
export interface LotseChatOptions {
  /** Which agent to start on the first prompt, and the one a login is for. */
  readonly agent: AgentCommand;
  /** Which copy `agent` is — what a new conversation's record names. */
  readonly agentSource?: AgentSource;
  /**
   * Where a new chat runs, and the home it is abbreviated against. `null` when no directory could be
   * found at all: then `newChat()` does nothing and `hasNewChat` says so, so a host can disable its
   * own control rather than offering one that points at nothing.
   */
  readonly newChat: { readonly cwd: string; readonly home: string | null } | null;
  /** Write a new conversation's record. `SessionStore.create`. */
  readonly createSession?: (record: SessionRecord) => void;
  /** Persist streamed transcript lines. Called once per arriving batch, in order. */
  readonly appendTurns?: (sessionId: string, entries: TranscriptEntry[]) => void;
  /**
   * The agent a stored session names, on the copy that held it — `resolveRecorded`. Left out when the
   * host pins one agent for everything, so a fixture record naming another is still answered by it.
   */
  readonly resolveAgent?: (id: string, source: AgentSource | undefined) => Promise<RecordedResolution>;
  /**
   * The host's own MCP servers, forwarded to `session/new` unchanged.
   *
   * **Passed through, never read.** `@lotse/core` forwards them as opaque objects and never looks
   * past `type` (`AGENTS.md`: MCP is passed through, not known), so a host wires its own servers in
   * without a line of widget-specific code.
   */
  readonly mcpServers?: readonly McpServer[];
  /**
   * A resolved profile (`resolveProfile`). Its `mcpServers` seed the conversation's toggles; an explicit
   * `mcpServers` wins, so a host that passes only that keeps working unchanged.
   */
  readonly profile?: ProfileSession;
  /**
   * Nothing could be resolved: Send is off and the `no-agent` page is what `showNoAgent()` shows.
   * Absent: an agent exists.
   */
  readonly noAgent?: Extract<EmptyStateView, { kind: 'no-agent' }>;
  /**
   * Offer to connect a provider when the agent has none. Off by default: it starts a private login
   * server once to read the connection state, which a host opts into. See `onboarding.ts` in core —
   * the page is an offer, never a wall, and an unreadable state shows the ordinary chat.
   */
  readonly providerOnboarding?: boolean;
  /** The host's idle page, into the `closed` slot. Absent: that state renders nothing. */
  readonly closedPage?: Gtk.Widget;
  /** The host's nothing-found page, into the `no-agent` slot. Absent: that state renders nothing. */
  readonly noAgentPage?: Gtk.Widget;
  /**
   * The host's gate, asked before the person is.
   *
   * **Fail-closed on every path that is not an explicit `'ask'`** — a throw, a rejected promise and
   * any other value are all a decline, because a host whose policy code broke has not approved
   * anything. See `HostGateAnswer` for why there is no answer here that allows.
   */
  readonly gate?: (question: PermissionQuestion) => HostGateAnswer | Promise<HostGateAnswer>;
  /**
   * The host's rule about which models a prompt from this chat may reach.
   *
   * **The second host policy, and deliberately the same shape as `gate`**: a predicate the host
   * passes, fail-closed on anything that is not an explicit answer, with no value that could *select*
   * something on the person's behalf. A host carrying data the person has not agreed to hand around
   * — an app over a document store, a window over somebody's accounts — is the only party that knows
   * where its data may travel; `@lotse/core`'s `denyFreeHostedModels` is the ready-made one for "no
   * free hosted model", and a host that needs certainty passes an allowlist of its own.
   *
   * Absent means what it has always meant: every model the agent offers is on the row and may be
   * prompted, which is lotse's own window.
   *
   * What it does, in the three places it has to agree:
   *
   * - a denied model is **not on the dropdown**, and not reachable from the failure dialog's "Choose
   *   another model" either — that button opens the same row;
   * - Send is **blocked**, with the reason under the entry, while the model in use is denied. The
   *   model is never switched for the person: picking one is theirs;
   * - `@lotse/core`'s `AgentSession` refuses in front of the wire as well, so a prompt cannot reach a
   *   denied — or an unverifiable — model around this surface.
   */
  readonly modelPolicy?: ModelPolicy;
  /**
   * The host's rules about **tool calls**: the tools it confirms itself, and whether an "always allow"
   * is the agent's to remember or lives only as long as the session it was given in.
   *
   * **`hostConfirmed` is the one host hook that is not only a narrowing**, and it is still not an
   * approval lotse gives: a tool listed here never goes to lotse's dialog and is never covered by an
   * always-allow — `confirmTool` is asked instead, and the most that can come back is the agent's own
   * one-time option. A legal submission behind a PIN, a payment, a signature: lotse's dialog cannot
   * ask for any of that, so it does not pretend to.
   *
   * **`alwaysAllow: 'session'`** keeps an always-allow in memory here instead of handing it to the
   * agent, so it ends with the conversation and is written nowhere. Where the agent offers nothing
   * narrower than an always, the button is withdrawn rather than shown as a promise lotse cannot keep.
   *
   * Absent, and every field absent, is lotse's own window: every question to the person, every always
   * the agent's to remember.
   */
  readonly hostTools?: HostToolPolicy;
  /**
   * The host's own confirmation for a tool it marked in `hostTools.hostConfirmed`.
   *
   * Shown by the host, in the host's own dialog, with whatever it needs to ask for. `true` is worth
   * **one** call; everything else — `false`, a throw, a rejected promise, no callback at all — is a
   * decline, which is the same fail-closed rule as `gate` and `modelPolicy`.
   */
  readonly confirmTool?: (question: PermissionQuestion) => boolean | Promise<boolean>;
  /**
   * Whether the provider settings (`providerSettingsPage`) let the person add and remove custom providers
   * — an OpenAI-compatible server of their own, local or not. Off by default: a custom provider is a new
   * place a prompt can go, which a host carrying data opts into. `modelPolicy` still applies to what such
   * a provider offers.
   */
  readonly allowCustomProviders?: boolean;
  /**
   * How the host wants its own tool calls drawn.
   *
   * Asked for every tool line that carries a structured record, with the call folded across its lines
   * so far (`ToolCallView`: title, status, ACP kind, input, and the MCP tools it reached). Return a
   * title — and optionally a subtitle and an icon — for a call the host recognises, `null` for one it
   * does not. The status capsule stays the agent's either way.
   *
   * **Fail-closed toward lotse's own line, never toward hiding**: a presenter that throws or returns
   * something without a usable title is treated as having returned `null`, with one `lotse:` warning
   * on stderr, the way `gate` and `modelPolicy` treat a broken host hook as no answer. Absent: every
   * tool line is drawn as lotse draws it.
   */
  readonly toolPresenter?: ToolPresenter;
  /**
   * The host's speech engine, which is what lets the chat read the agent's answers aloud.
   *
   * **A structural type shaped like the W3C `speechSynthesis`, and the widget imports no engine at
   * all.** A browser passes `window.speechSynthesis`, a GNOME app passes `@gjsify/speech-synthesis`,
   * and a test passes a fake that records the texts it was told to say — which is the only reason
   * this feature has unit tests at all (`core/read-aloud.ts`, ADR 0009 point 12). The utterance
   * factory is the second half because `SpeechSynthesisUtterance` is a class and a class cannot be
   * called without `new`:
   *
   * ```ts
   * speech: { synthesis: speechSynthesis, utterance: (text) => new SpeechSynthesisUtterance(text) }
   * ```
   *
   * **Absent means no toggle**, not a toggle that does nothing — the same for a `profile` whose
   * `voice` policy is `off`. `readAloudOffered` in core is the whole gate.
   *
   * **`local-only` is the host's promise, not a check made here.** Whether a given engine speaks on
   * this machine or ships the text to a cloud service cannot be read off a `speechSynthesis`-shaped
   * object, so a host carrying data the person has not agreed to hand around is the party that has
   * to pass a local engine — the same division as `modelPolicy`, where the host knows where its data
   * may travel and lotse enforces what it can see.
   */
  readonly speech?: SpeechEngine;
  /**
   * A new conversation has its session and its record — the host's chance to list it.
   *
   * **Called before the widget updates its own view**, so a host that adds the row and names the
   * conversation does so in the order a person reads: the list first, then the pane.
   */
  readonly onConversation?: (record: SessionRecord, current: boolean) => void;
  /** A line from the agent that is not a transcript entry. The widget also logs it — see `#onNotice`. */
  readonly onNotice?: (message: string) => void;
  /** The clock, injected so a screenshot run is the only place a real one is used. */
  readonly now?: () => string;
}

export class LotseChat extends Adw.Bin {
  // The GType name is also the template's `template $LotseChat` — the two must agree, and
  // `chat.blp` is where the tree is.
  static readonly GTypeName = 'LotseChat';

  /** The five states of a conversation. `chat.blp` names them; this is the only field that switches. */
  declare readonly _stack: Gtk.Stack;
  /** The host's "nothing is open" page, or an empty bin when the host has no such state. */
  declare readonly _closedHost: Adw.Bin;
  /** The host's "no agent found" page. Filled by the host, shown by `showNoAgent()`. */
  declare readonly _noAgentHost: Adw.Bin;
  declare readonly _transcriptHost: Adw.Bin;
  declare readonly _composerHost: Adw.Bin;
  /** One dim line under the composer naming the directory a new chat will run in. Hidden otherwise. */
  declare readonly _cwdCaption: Gtk.Label;
  /** The free-model warning above the composer. Shown by `#renderFreeModelNotice` only. */
  declare readonly _freeModelNotice: Gtk.Box;
  declare readonly _freeModelLabel: Gtk.Label;
  declare readonly _freeModelDismiss: Gtk.Button;

  /** One transcript view for the whole widget, refilled per session. See the constructor. */
  readonly #transcript: TranscriptView;
  readonly #composer: Composer;
  /**
   * Reading the agent's answers aloud, or `null` when the host offered no engine (or forbade one).
   *
   * **The decisions are core's, as ever.** What counts as a sentence, when one is complete enough to
   * speak, what is dropped as code: all `read-aloud.ts`. This file contributes the four moments —
   * text arrived, the turn ended, the person stopped it, the toggle moved — and nothing else.
   */
  readonly #readAloud: ReadAloud | null;
  /**
   * The agent's own configuration, on the composer card's bottom line.
   *
   * **Its own field and its own object even though its widget sits inside the composer's card,
   * because the two have different clocks.** The composer re-renders on every turn state move; this
   * re-renders when the agent answers about its options.
   */
  readonly #config: ConfigRow;
  /**
   * The approval dialog. One per widget, because one question is ever shown at a time —
   * `@lotse/core`'s `permission.ts` queues the rest, and `PermissionDialog.show` replaces rather
   * than stacks.
   */
  readonly #permissions: PermissionDialog;
  /** The modal a failure earns. Only ever raised from `#onSnapshot`; `failure.ts` decides what it says. */
  readonly #failures: FailureDialog;
  readonly #login = new LoginDialog();
  #providerOnboarding: boolean;
  #connection: ConnectionFacts = { kind: 'unknown' };
  #onboardingDismissed = false;
  /** True from construction until the probe answers, so the page waits instead of flashing "New chat". */
  #probing = false;
  /** A dev hook's stand-in for the probe and for `hasLogin`; see `stageOnboarding`. */
  #onboardingStaged = false;
  #onboardingPage: OnboardingPage | null = null;
  /** The probe in flight, and the way to end it early: `shutdown()` must not leave its server behind. */
  #probe: Promise<void> | null = null;
  readonly #probeAbort = new AbortController();
  /** The agent the widget starts, which is also the one a login is for. */
  readonly #loginAgent: AgentCommand;
  /**
   * The failure this widget has already put a dialog up for, held by identity.
   *
   * `#onSnapshot` runs on every state move and `attachment` stays `failed` until the next attach, so
   * a guard on "is a dialog up right now" is not a guard at all — dismissing one clears it and the
   * next emit opens it again. The decision is `failureToShow`; this is where the answer is kept.
   */
  #shownFailure: AgentAttachment | null = null;
  /**
   * The free model whose warning the person closed in this conversation. Forgotten by `open()` and
   * `newChat()`, so the next conversation warns again — `freeModelWarningDue` has the reason.
   */
  #freeModelDismissed: string | null = null;
  /** The turn machinery. One per widget, one agent subprocess behind it. */
  readonly #agent: AgentSession;
  /** The session on screen, or `null` while none is. */
  #openRecord: SessionRecord | null = null;
  readonly #newChat: LotseChatOptions['newChat'];
  /** Lines from the agent (not the person's own) drawn so far; a host's mid-turn hook waits for one. */
  #streamed = 0;
  /**
   * The spawn-time closer, once the agent has one.
   *
   * Held so `shutdown()` is not the only thing that knows a process exists: during the handshake
   * there is one and no turn, and a host closing in that moment would otherwise leave it running.
   */
  #agentClose: (() => void) | null = null;
  /** Lines from the agent that are not transcript entries. See `#onNotice`. */
  readonly #notices: string[] = [];
  /** Why no prompt can be sent at all (no agent found), or `undefined`. Feeds the composer. */
  readonly #unavailable: string | undefined;
  readonly #gate: LotseChatOptions['gate'];
  readonly #hostConversation: LotseChatOptions['onConversation'];
  readonly #hostNotice: LotseChatOptions['onNotice'];
  readonly #modelPolicy: ModelPolicy | undefined;
  readonly #confirmTool: LotseChatOptions['confirmTool'];
  readonly #allowCustomProviders: boolean;

  constructor(options: LotseChatOptions) {
    super();
    installWidgetCss();

    this.#unavailable = options.noAgent?.sendReason;
    this.#newChat = options.newChat;
    this.#gate = options.gate;
    this.#hostConversation = options.onConversation;
    this.#hostNotice = options.onNotice;
    this.#loginAgent = options.agent;
    this.#providerOnboarding = options.providerOnboarding === true;
    this.#modelPolicy = options.modelPolicy;
    this.#confirmTool = options.confirmTool;
    this.#allowCustomProviders = options.allowCustomProviders === true;
    // `this` rather than a window, which is why `PermissionDialog` and `FailureDialog` take a
    // `Gtk.Widget`: a widget a host embeds does not know what window it will end up in, and
    // `Adw.Dialog.present` walks up to the root by itself.
    this.#permissions = new PermissionDialog(this);
    this.#failures = new FailureDialog();
    // **One transcript view for the whole widget, refilled — not a stack child per session.** Thirty
    // sessions would otherwise mean thirty scrollers and a composer whose entry and scroll position
    // are rebuilt on every click. One view, `setEntries` on each open, is also the reason a session
    // switch cannot leak a row from the previous transcript — the rebuild is total, not a diff.
    this.#transcript = new TranscriptView(
      options.toolPresenter ? { toolPresenter: options.toolPresenter } : {},
    );
    // **Named now rather than at `open()`.** A first prompt creates its session inside the
    // controller, so that path never calls `open()` — and a caption only `open()` filled would leave
    // the *first* answer of a new chat with a bare timestamp and no speaker. `open()` still overrides
    // this with the record's own agent: a stored session may have run on the other copy.
    this.#transcript.setAgentName(options.agent.id);
    // **Before the controller, and that order is deliberate.** `onConfig` is a closure over this
    // field, so a controller that emitted a config view from its own constructor would reach a
    // `#config` that does not exist yet.
    this.#config = new ConfigRow({
      // One path out of the row and into the protocol. The widget does not check the value, does not
      // look the control up, and does not decide whether this is a change — the controller does all
      // of that (`setConfigOption`), and a widget-level check would be a second opinion with no tests.
      onSelect: (controlId, value) => {
        void this.#agent.setConfigOption(controlId, value);
      },
      onSwitch: (controlId, on) => {
        void this.#agent.setConfigSwitch(controlId, on);
      },
      onMcpToggle: (name, on) => this.#agent.setMcpServer(name, on),
    });
    this.#agent = new AgentSession({
      command: options.agent,
      ...(options.appendTurns ? { append: options.appendTurns } : {}),
      ...(options.createSession ? { create: options.createSession } : {}),
      ...(options.agentSource ? { source: options.agentSource } : {}),
      ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
      // Forwarded as the host gave them. `@lotse/core` passes them to `session/new` and never reads
      // past `type`, so a host wires its own servers in without a line of widget-specific code.
      ...(options.mcpServers || options.profile
        ? { mcpServers: options.mcpServers ?? options.profile?.mcpServers ?? [] }
        : {}),
      // **The host's model rule, to the one place that sends a prompt.** The widget keeps no copy: the
      // controller filters the row, computes the composer's block and refuses in front of the wire, so
      // the policy is asked once per question rather than once per surface.
      ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
      // **The host's tool rules, to the same one place.** The widget keeps no copy of these either:
      // a tool the host confirms must be recognised in front of the wire, not in front of a dialog.
      ...(options.hostTools ? { hostTools: options.hostTools } : {}),
      ...(options.now ? { now: options.now } : {}),
      events: {
        onSnapshot: (snapshot) => this.#onSnapshot(snapshot),
        onEntries: (entries) => this.#onEntries(entries),
        onConversation: (record, current) => this.#onConversation(record, current),
        onNotice: (message) => this.#onNotice(message),
        // Kept so a host's close path can end a process that exists while the handshake is still
        // running and no turn has been awaited. `shutdown()` already ends it; this is the same
        // closer, held so that path is not the only thing that knows a process exists.
        onCloser: (close) => {
          this.#agentClose = close;
        },
        // **The dialog, through the controller's gate, with the host's own gate in front of it.**
        // `#ask` is the whole of what this widget contributes to an approval: it shows the question
        // and resolves with the id that was pressed. It decides nothing about that id — a dismissal
        // arrives as an id the agent never offered, and what it means is `permission.ts`'s to say.
        onPermission: (question) => this.#ask(question),
        // **The host's own dialog, for a tool the host confirms.** The widget draws nothing here and
        // decides nothing: it forwards the question and the answer, and `host-tools.ts` says what a
        // `true` is worth. Absent `confirmTool` never reaches this line — the controller reads the
        // callback as absent and declines, which is where that rule belongs.
        ...(options.confirmTool ? { onHostConfirm: (question) => this.#confirm(question) } : {}),
        // **The row, through the controller's decided view.** `config-row.ts` has already decided
        // which controls may exist, what is selected, and what a refusal says.
        // **And the composer with it, because the model is one of its inputs now.** The row and the
        // snapshot run on different clocks on purpose (`onConfig`), and a model change arrives on
        // this one only: opencode pushes a `config_option_update`, no turn state moves, so
        // `onSnapshot` never fires. Without this line the composer's `modelBlock` is whatever the
        // last state move computed — Send still refusing a model the person has already replaced, or
        // worse, still offering to send to one they just picked. Read from `snapshot` again rather
        // than threaded through: the controller is the only honest source for it.
        onMcpToggles: (view) => this.#config.setMcpToggles(view),
        onConfig: (view) => {
          this.#config.setView(view);
          this.#composer.setInput(composerInput(this.#agent.snapshot, this.#unavailable));
          this.#renderFreeModelNotice();
        },
      },
    });
    // **Before the composer, because the composer's toggle exists only if this does.** The gate is
    // core's one function: an engine from the host, and a `voice` policy that does not say `off`.
    this.#readAloud = readAloudOffered(options.speech, options.profile?.voice ?? null)
      ? readAloud({ engine: options.speech, onNotice: (message) => this.#onNotice(message) })
      : null;
    this.#composer = new Composer({
      // **From the controller's own `snapshot`, not from a hand-written initial value.** A literal
      // `idle / none / null` here would be a second source of truth for the composer's inputs that
      // has to be kept in step with the controller's defaults by hand. Reading the snapshot cannot
      // be stale, because it is the thing itself.
      input: composerInput(this.#agent.snapshot, this.#unavailable),
      // **The config row's widget, into the composer's own card.** `Adw.ToolbarView` has exactly one
      // bottom bar and that one belongs to the composer. The *row* is still this file's (`#config`,
      // its own clock); only its widget travels.
      config: this.#config.widget,
      onSend: (text) => this.#onSend(text),
      // **Stop takes the dialog down with it, and names the reason before it does.** This widget
      // contributes only the ordering — `agent.stop()` settles the question itself.
      // `turn-cancelled` rather than the vaguer `dismissed`: the person did not walk away from this
      // question, they ended the turn it belonged to.
      onStop: () => {
        this.#agent.dismissPermission('turn-cancelled');
        this.#permissions.close();
        this.#agent.stop();
        // Silence with it: the answer being read is the answer the person just ended.
        this.#readAloud?.stop();
      },
      // **Only when there is something to toggle.** `Composer` reads an absent callback as "do not
      // build the control", which is why the gate is checked once, above, rather than in two files.
      ...(this.#readAloud ? { onReadAloud: (on: boolean) => this.#readAloud?.setEnabled(on) } : {}),
    });
    // Esc silences it. On `this` rather than on the composer, so it works wherever the focus is in
    // the conversation — see `#escapeToStop`.
    if (this.#readAloud) this.add_controller(this.#escapeToStop());
    // The two TypeScript-built widgets into the template's hosts, and the host's two pages into its
    // slots. Each `Adw.Bin` is a placeholder with exactly one child, so this is a substitution
    // rather than a nesting — the tree that renders is the tree `chat.blp` draws.
    this._transcriptHost.child = this.#transcript.widget;
    this._composerHost.child = this.#composer.widget;
    this._freeModelLabel.label = _(FREE_MODEL_WARNING);
    this._freeModelDismiss.connect('clicked', () => {
      this.#freeModelDismissed = this.#agent.snapshot.freeModel;
      this.#renderFreeModelNotice();
    });
    this.#renderFreeModelNotice();
    if (options.closedPage) this._closedHost.child = options.closedPage;
    if (options.noAgentPage) this._noAgentHost.child = options.noAgentPage;
    if (this.#providerOnboarding && !this.#unavailable) {
      this.#probing = true;
      this.#probe = probeConnections(options.agent, { signal: this.#probeAbort.signal }).then((facts) => {
        this.#probing = false;
        if (this.#probeAbort.signal.aborted) return;
        this.#connection = facts;
        this.#refreshOnboarding();
      });
    }
  }

  // ─── what a host opens, closes and asks about ───────────────────────────────────────────────

  /**
   * Show a session.
   *
   * **The record is the host's, read as the host wants it read.** lotse's window re-reads its store
   * first, because its own list was loaded at startup and a session that streamed since is longer on
   * disk; a host with a live store hands over what it already has. Either way this takes the record
   * as given and never looks a session up — the widget has no opinion about where sessions live.
   *
   * **`record.turns` is handed over unchanged.** `TranscriptView.setEntries` takes exactly what the
   * store holds and projects it through `@lotse/core`; a surface that filtered first would be
   * re-deriving history the agent's own `session/load` is the authority on (`AGENTS.md` § Privacy:
   * the transcript is a record of what happened, not a re-derivation of it).
   *
   * **Opening a session spawns nothing.** This calls `AgentSession.bind`, which records the session
   * and emits a snapshot; the process starts on the first prompt. That is what lets this stay a pure
   * view operation — no await, no failure path, no process to leak when a person clicks through a list.
   */
  open(record: SessionRecord): void {
    // A login dialog is about the agent as it was; leaving for another session closes it.
    this.#login.close();
    // And the voice stops with it: an answer read on over the conversation that replaced it is the
    // same lie the stale failure dialog below is closed for, with no way to see where it came from.
    this.#readAloud?.stop();
    this.#openRecord = record;
    this._cwdCaption.visible = false;
    this.#freeModelDismissed = null;
    // **A session switch takes the failure dialog down, and keeps `#shownFailure`.** The dialog is
    // about the widget, not about the session — but a person who opened another conversation while a
    // modal sentence about the last one was up is now looking at a *different* conversation, and a
    // modal that no longer describes what is on screen points at nothing. `bind` then emits, and
    // `failureToShow` answers `null` for the failure already shown, so closing it here does not buy
    // it back on the next state move.
    this.#failures.close();
    // The recorded agent travels with the session, so the first prompt reattaches it on the copy
    // that holds its history (`resolveRecorded`) rather than on the widget's single agent.
    this.#agent.bind({
      id: record.id,
      cwd: record.cwd,
      agent: record.agentSource ? { id: record.agent, source: record.agentSource } : { id: record.agent },
    });
    // `bind` stopped a turn that belongs to another chat; its question, if any, is already settled.
    this.#permissions.close();
    this.#transcript.setAgentName(record.agent);
    this.#transcript.setEntries(record.turns);
    // Named, not indexed: `'empty'`/`'open'` read at the assignment and a `Gtk.Stack` is a map, so
    // an index would be a second naming scheme for the same states. `'empty'` is its own state and
    // not the host's idle page reused — see `chat.blp`.
    this._stack.visibleChildName = record.turns.length === 0 ? 'empty' : 'open';
  }

  /**
   * The empty composer: no session is open and the first prompt makes one. **Starts nothing** — the
   * agent and `session/new` wait for the prompt, so a chat nobody types in owns no process.
   *
   * The draft is left alone: a person who was writing something and reached for New chat has not
   * asked to lose it. Does nothing when no directory could be found at all — `hasNewChat` is what a
   * host asks before offering the control.
   */
  newChat(): void {
    const chat = this.#newChat;
    if (!chat) return;
    this.#failures.close();
    this.#readAloud?.stop();
    this.#openRecord = null;
    this.#freeModelDismissed = null;
    // The agent stops a running turn itself (`startConversation`), settling any open question
    // `cancelled`; the dialog widget goes down after it, like Stop's.
    this.#agent.startConversation(chat.cwd);
    this.#permissions.close();
    this.#transcript.setEntries([]);
    this._stack.visibleChildName = this.#unavailable ? 'no-agent' : this.#newPage();
    this._cwdCaption.label = fmt(_('Working in {path}'), { path: displayCwd(chat.cwd, chat.home) });
    this._cwdCaption.visible = !this.#unavailable;
  }

  /** Whether a new chat has a directory to run in. A host with `false` disables its own control. */
  get hasNewChat(): boolean {
    return this.#newChat !== null;
  }

  /**
   * Show the host's nothing-found page.
   *
   * A call rather than something the constructor does on its own, because the host fills that page's
   * labels first — the widget decides *when* the state is shown and the host decides what it says.
   */
  showNoAgent(): void {
    this._stack.visibleChildName = 'no-agent';
  }

  // ─── the turn ───────────────────────────────────────────────────────────────────────────────

  /**
   * Send: record the prompt, clear the entry, start the turn.
   *
   * **The prompt is written down before the turn starts, and by this file rather than by the
   * controller.** The controller's `prompt()` appends it too — through the same `append` the stream
   * uses, so a crash cannot lose the message — and the widget draws it, because the widget that will
   * show it is the one that has to decide it is shown. The draft is cleared here for the same reason
   * `keepsDraft` exists in core: sending is a person clearing their own message, which is not the
   * same event as a state change arriving.
   */
  #onSend(text: string): void {
    if (text.trim() === '' || this.#unavailable) return;
    this.#composer.clearDraft();
    // **A new prompt silences the last answer.** A person who has started typing the next thing has
    // stopped listening to the previous one, and an answer still being read over a question already
    // sent is the surface talking past them.
    this.#readAloud?.stop();
    void this.#agent.prompt(text);
  }

  /**
   * A new snapshot: hand it to the composer, and act on a state that changed the draft's fate.
   *
   * **A `gone` snapshot also takes the dialog down**, and it is the only place that does. The agent
   * dying mid-question is a state the controller settles (`#reportFailure` cancels the desk with
   * `agent-gone`, so the answer is `cancelled` rather than a hang), but the *widget* is this file's,
   * and a modal left up over an agent that has exited is a question about work that can no longer
   * happen. Reading it off the snapshot rather than off a separate callback is what keeps this from
   * having two sources of truth about whether the agent is alive.
   */
  #onSnapshot(snapshot: AgentSnapshot): void {
    this.#composer.setInput(composerInput(snapshot, this.#unavailable));
    // `keepsDraft` is the decision and it lives in core; the widget only carries it out. An agent
    // that exited can never receive what is in the entry, and leaving it there collects words that
    // go nowhere — so `gone` is the one state that discards it.
    if (!keepsDraft(snapshot.state)) this.#composer.clearDraft();
    if (snapshot.attachment.status === 'gone') this.#permissions.close();
    this.#endOrStopReading(snapshot.state);
    this.#showFailure(snapshot);
    this.#renderFreeModelNotice();
  }

  /**
   * What the turn state means for a voice: an ended turn has a tail to speak, an ended *agent* does
   * not.
   *
   * `idle` is the reply being over, and the chunker holds whatever had no sentence end of its own —
   * flushing it is the difference between the last sentence being read and being swallowed.
   * `stopped` and `gone` are the two endings nobody listened through to the end, so the queue goes
   * rather than plays on over a conversation that has moved. `thinking` and `waiting-for-you` are
   * the middle of a turn and change nothing — in particular a question does not interrupt the
   * sentence that led to it.
   */
  #endOrStopReading(state: AgentSnapshot['state']): void {
    switch (state) {
      case 'idle':
        this.#readAloud?.end();
        return;
      case 'stopped':
      case 'gone':
        this.#readAloud?.stop();
        return;
      case 'thinking':
      case 'waiting-for-you':
        return;
    }
  }

  /**
   * Show or hide the free-model warning. Called on both clocks — a state move and a config answer —
   * because a model change arrives on the config one only (see `onConfig`).
   */
  #renderFreeModelNotice(): void {
    this._freeModelNotice.visible =
      !this.#unavailable && freeModelWarningDue(this.#agent.snapshot.freeModel, this.#freeModelDismissed);
  }

  /**
   * Put up the dialog a failure has earned — **once per failure, and never a stale one.**
   *
   * Three decisions, all of them made in `@lotse/core`'s `failure.ts`:
   *
   * - `failureToShow(attachment, shown)` — is this failure still owed a dialog? It is `null` for a
   *   failure already shown (identity, not "is one open": a dismissal closes the dialog and the
   *   *next* snapshot would otherwise re-open it) and `null` for a `start` failure, which earns no
   *   modal at all.
   * - `staleDialog(shown, attachment)` — is a dialog that is up now about something the widget has
   *   moved on from? A dialog is modal, so one left up over an attached agent or another session
   *   both lies and blocks the surface around it.
   * - `failureAction(notice, …)` — may the dialog carry its button? The `'model'` notice offers
   *   "Choose another model", and only if the agent reported a model option at all; `auth` offers
   *   "Log in…", and only where a login could work.
   *
   * **`#shownFailure` is only forgotten when a dialog is genuinely closed as stale.** Clearing it on
   * every session switch would put the *same* auth dialog straight back up, because the attachment is
   * still the same object.
   */
  #showFailure(snapshot: AgentSnapshot): void {
    const attachment = snapshot.attachment;
    if (staleDialog(this.#shownFailure, attachment)) this.#failures.close();
    const notice: FailureNotice | null = failureToShow(attachment, this.#shownFailure);
    if (notice === null) return;
    this.#shownFailure = attachment;
    const action = failureAction(notice, {
      modelChoice: this.#config.hasModelControl(),
      login: this.hasLogin,
    });
    this.#failures.show(notice, this, {
      ...(action === 'choose-model' ? { onChooseModel: () => this.openModelDropdown() } : {}),
      ...(action === 'login' ? { onLogin: () => this.openLogin() } : {}),
    });
  }

  /**
   * Lines that just arrived. Drawn as they come, with no batching and no timer.
   *
   * **Appended, never re-projected from the store.** Re-reading the file per chunk would mean a JSON
   * parse and a full rebuild of a thirty-session file for every token, and it would draw the *stored*
   * transcript rather than the one being streamed.
   */
  #onEntries(entries: TranscriptEntry[]): void {
    this.#transcript.appendEntries(entries);
    // **Only `'agent'`, and that is a decision about what reading aloud *is*.** A thought card, a
    // tool line and a system notice are all things to look at — ADR 0009 point 11 — and a voice that
    // narrated them would read a tool's arguments out over the answer they were for. Each chunk is
    // its own entry and entries are appended rather than mutated (`core/transcript.ts`), so the
    // texts of a batch, in order, are exactly the deltas as they arrived.
    for (const entry of entries) if (entry.kind === 'agent') this.#readAloud?.feed(entry.text);
    // Neither the person's own lines nor the host's: `streamed` counts what the *agent* said.
    this.#streamed += entries.filter((entry) => entry.kind !== 'user' && entry.kind !== 'host').length;
    // A session that was showing `'empty'` has just said something. Left as it is, the pane keeps
    // the "Nothing here yet" status page *underneath* the new bubble, and the sentence contradicts
    // what is on top of it. The same for a new chat, whose first line is drawn before its session
    // exists.
    const visible = this._stack.visibleChildName;
    if (visible === 'empty' || visible === 'new' || visible === 'onboarding' || visible === 'checking')
      this._stack.visibleChildName = 'open';
  }

  /**
   * A new conversation has its session and its record.
   *
   * **The host is told first.** A host that lists conversations adds the row and names the pane, and
   * it does so in the order a person reads: the list first, then the view. This does not go through
   * `open()`, which would replace the transcript on screen with the (empty) stored copy.
   */
  #onConversation(record: SessionRecord, current: boolean): void {
    this.#hostConversation?.(record, current);
    if (!current) return;
    this.#openRecord = record;
    this._cwdCaption.visible = false;
    this._stack.visibleChildName = 'open';
  }

  /**
   * A line from the agent that is not a transcript entry.
   *
   * **Collected, logged, and handed on.** An auth advertisement, a `SIGTERM` from a killed tool, a
   * cancellation that could not be sent: all real, all things a person wants to know, none of them
   * belonging in the conversation. The widget has nowhere to put them — a notice area is the host's
   * — so they go to stderr with the host's own callback beside them, which is honest: they are
   * reported, and nothing claims they are on screen.
   */
  #onNotice(message: string): void {
    this.#notices.push(message);
    console.log(`lotse: ${message}`);
    this.#hostNotice?.(message);
  }

  /**
   * One question, through the host's gate and then the dialog.
   *
   * **The gate may only narrow.** `'ask'` is the one answer that lets the question reach a person;
   * everything else — `'decline'`, a throw, a rejected promise, a value from a host that returned
   * something else entirely — resolves `null`, which `@lotse/core` reads as the dismissal and
   * answers `cancelled`. A host whose policy code broke has not approved anything (guardrail 2).
   */
  async #ask(question: PermissionQuestion): Promise<string | null> {
    const gate = this.#gate;
    if (gate !== undefined) {
      let answer: HostGateAnswer | null = null;
      try {
        answer = await gate(question);
      } catch {
        answer = null;
      }
      if (answer !== 'ask') return null;
    }
    return this.#permissions.show(question);
  }

  /**
   * One question, to the host's own dialog — for a tool the host confirms itself.
   *
   * **lotse's `gate` is not consulted and lotse's dialog is not shown.** Both would be lotse putting
   * itself between the host and a decision the host said was its own; the host's dialog is the gate
   * for this call. A `true` is the only answer that approves, and it approves one call.
   */
  async #confirm(question: PermissionQuestion): Promise<boolean> {
    const confirm = this.#confirmTool;
    if (confirm === undefined) return false;
    return (await confirm(question)) === true;
  }

  // ─── provider onboarding ─────────────────────────────────────────────────────────────────────

  /** The page a new chat shows: the onboarding offer where `onboardingView` says so, else "New chat". */
  #newPage(): 'new' | 'onboarding' | 'checking' {
    if (this.#probing) return 'checking';
    const input: OnboardingInput = {
      enabled: this.#providerOnboarding,
      noAgent: this.#unavailable !== undefined,
      loginAvailable: this.#onboardingStaged || this.hasLogin,
      connection: this.#connection,
      dismissed: this.#onboardingDismissed,
    };
    // **Built through the same factory an embedding host calls**, so the `null` that means "show the
    // ordinary chat instead" is `onboardingView`'s answer in both places rather than two readings of
    // the same five facts. Once the page exists it is kept and only the answer is re-read.
    if (this.#onboardingPage === null) {
      const page = createOnboardingPage(input, {
        onConnect: () => this.openLogin(),
        onContinue: () => {
          this.#onboardingDismissed = true;
          this.#refreshOnboarding();
        },
      });
      if (page === null) return 'new';
      this.#onboardingPage = page;
      this._stack.add_named(page.widget, 'onboarding');
      return 'onboarding';
    }
    return onboardingView(input) === null ? 'new' : 'onboarding';
  }

  /** Re-decide the page — only if the person is on one of the two it chooses between. */
  #refreshOnboarding(): void {
    const visible = this._stack.visibleChildName;
    if (visible === 'new' || visible === 'onboarding' || visible === 'checking')
      this._stack.visibleChildName = this.#newPage();
  }

  /**
   * For a host's dev hook: show the onboarding page as if the probe had found no provider and a login
   * could run, so it can be photographed against the stand-in agent. Never used outside a fixture.
   */
  stageOnboarding(): void {
    this.#onboardingStaged = true;
    this.#probing = false;
    this.#providerOnboarding = true;
    this.#connection = { kind: 'none', browser: 10, key: 228 };
    this.#refreshOnboarding();
  }

  // ─── the login ──────────────────────────────────────────────────────────────────────────────

  /** Whether a login could work at all. A host with `false` leaves its own entry insensitive. */
  get hasLogin(): boolean {
    return loginUnavailableReason(this.#loginAgent) === null;
  }

  /**
   * Open the login dialog. The controller starts a private server and stops it when the dialog goes
   * away; after a login the agent is restarted, because it reads its credentials once at start and
   * the process that hit the login trap would keep saying "log in".
   */
  openLogin(): void {
    this.#openLogin();
  }

  /** `done` runs after a successful login — the settings page reads its list again then. */
  #openLogin(done?: () => void): void {
    const agent = this.#loginAgent;
    const policy = this.#modelPolicy;
    const controller = new LoginController({
      openSession: () => openLoginSession(agent),
      unavailableReason: () => loginUnavailableReason(agent),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      // A provider the host's policy rules out (`allowsProvider`) is not offered for a login at all.
      ...(policy ? { offers: (provider) => providerOffered(policy, provider.id) } : {}),
      // The login is stored either way, so the settings page reads it even when the restart waits.
      ...(done ? { onStored: () => done() } : {}),
      onConnected: async () => {
        // A turn in flight is left alone, so say so instead of claiming a restart that did not happen.
        if (!(await this.#agent.restartAgent()))
          throw new Error('a turn is still running — send again once it ends');
        this.#connection = { kind: 'connected' };
        this.#refreshOnboarding();
      },
    });
    this.#login.show(this, controller);
  }

  // ─── the provider settings ──────────────────────────────────────────────────────────────────

  /**
   * A new provider settings page (#45) for a host's own `Adw.PreferencesDialog`: the connected providers,
   * the custom ones (when `allowCustomProviders`) and what each means for the person's data.
   *
   * The page starts its private server when it is shown and stops it when it is hidden, so a host may
   * build it with its dialog. A change the agent has to pick up restarts it, as a login does.
   */
  providerSettingsPage(): Adw.PreferencesPage {
    const policy = this.#modelPolicy;
    // **Through the same factory a host calls.** `createProviderSettingsPage` owns the controller's
    // wiring, so lotse's page and an embedding host's page cannot read the provider file differently.
    return createProviderSettingsPage({
      agent: this.#loginAgent,
      ...(policy ? { modelPolicy: policy } : {}),
      allowCustomProviders: this.#allowCustomProviders,
      connect: (done) => this.#openLogin(done),
      onChanged: async () => {
        if (!(await this.#agent.restartAgent()))
          throw new Error('a turn is still running — it uses the change from the next start');
      },
    }).page;
  }

  /** The same page in a dialog of its own, for a host without a preferences dialog to put it in. */
  openProviderSettings(): void {
    const dialog = new Adw.PreferencesDialog({ title: _('Providers') });
    dialog.add(this.providerSettingsPage());
    dialog.present(this);
  }

  /**
   * Open the model dropdown, for the failure dialog's "Choose another model".
   *
   * **Through the row's own method and nothing else** — no `set_selected`, no request, no value. A
   * dialog that picked a model on the person's behalf would be lotse deciding configuration for the
   * agent, which is the "always allow" mistake in different clothes; what this does is put the list
   * in front of them.
   *
   * **One line in the log either way, and that is deliberate.** The pointer cannot press that button
   * (`scripts/probes/alert-dialog-close.mjs`), so a screenshot run has to be able to say afterwards
   * whether it reached the dropdown or whether there was no model option to open — and "no log line"
   * would not distinguish "worked" from "never ran".
   */
  openModelDropdown(): boolean {
    const opened = this.#config.openModelDropdown();
    console.log(`lotse: the model dropdown is ${opened ? 'open' : 'not on the row — nothing to open'}`);
    return opened;
  }

  // ─── what a host's own controls and dev hooks reach ──────────────────────────────────────────

  /**
   * Send a prompt as the composer would, draft cleared first.
   *
   * For a host control that is not the entry — lotse's `LOTSE_APP_THINKING`, a `lotse listen` task.
   * The guard `#onSend` applies is the *entry's* (an empty line is not a prompt); a caller that has
   * a sentence in hand has already passed it.
   */
  prompt(text: string): void {
    this.#composer.clearDraft();
    this.#readAloud?.stop();
    void this.#agent.prompt(text);
  }

  /**
   * Record a line of the host's own into the conversation on screen, and draw it.
   *
   * For something the host did that belongs in the transcript beside the agent's lines — an order
   * placed from a tool call, a draft saved. Persisted through `appendTurns` before it is drawn, so it
   * comes back on resume in the order it happened; `type` and `data` are stored for the host and
   * never read by lotse, `icon` is a themed icon name drawn before `text`.
   *
   * **Rejects when no session exists yet** — nothing open, or a new chat whose first prompt has not
   * been answered — because there is no record to file the line in, and a line drawn but never
   * stored would silently vanish on the next resume. Also rejects when the host passed no
   * `appendTurns` (nothing would store it), for an empty `type` or `text`, for `data` that is not
   * JSON or is over the size cap, or when the host's `appendTurns` throws. A promise so a host can await the write and catch either.
   */
  appendHostItem(item: { type: string; text: string; data?: unknown; icon?: string }): Promise<void> {
    try {
      this.#agent.appendHostEntry(item);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  /** Empty the entry. */
  clearDraft(): void {
    this.#composer.clearDraft();
  }

  /**
   * Whether the chat offers reading aloud at all: a host gave an engine and the `voice` policy allows
   * it. A host with its own menu item asks this before drawing one.
   */
  get readAloudOffered(): boolean {
    return this.#readAloud !== null;
  }

  /** Whether it is on right now. `false` when it is not offered. */
  get readAloudOn(): boolean {
    return this.#readAloud?.enabled ?? false;
  }

  /**
   * Turn reading aloud on or off from the host's side — a restored preference, a control of its own.
   * Moves the composer's toggle with it, so the two can never disagree. Does nothing when the feature
   * is not offered: a host cannot switch on an engine it did not pass.
   */
  setReadAloud(on: boolean): void {
    if (!this.#readAloud) return;
    this.#readAloud.setEnabled(on);
    this.#composer.setReadAloud(on);
  }

  /**
   * Esc silences the voice.
   *
   * **On `LotseChat` itself and in the CAPTURE phase**, because the key has to work wherever the
   * focus is in the conversation — in the entry, on a tool card, on the Send disc — and a controller
   * on the composer would only answer for one of them. Capture is what gets it before a child, which
   * at the bubble phase would already have been the entry.
   *
   * **`EVENT_PROPAGATE`, never `EVENT_STOP`.** Esc is the toolkit's own key for closing a dialog, and
   * this widget raises three of them (approval, failure, login). Swallowing it would make a modal
   * un-dismissable by keyboard whenever a voice happened to be on — a trap that no screenshot shows.
   * So this is a *side effect* on the way past, not a handler.
   *
   * Guarded on `enabled` rather than on "is something playing": `ReadAloud.stop` is the one that
   * knows whether there is a queue, and `speaking` is false for an utterance that is merely pending.
   */
  #escapeToStop(): Gtk.EventControllerKey {
    const controller = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
    controller.connect('key-pressed', (_controller, keyval) => {
      if (keyval === Gdk.KEY_Escape && this.#readAloud?.enabled) this.#readAloud.stop();
      return Gdk.EVENT_PROPAGATE;
    });
    return controller;
  }

  /** Press Stop, through the composer's own handler — so the ordering the widget contributes holds. */
  stop(): void {
    this.#composer.stop();
  }

  /** Name an ending nobody chose, before the dialog goes down. See `AgentSession.dismissPermission`. */
  dismissPermission(reason: NotAnsweredReason): void {
    this.#agent.dismissPermission(reason);
  }

  /** Take the permission dialog down. Call `dismissPermission` first, so the reason is on the record. */
  closePermission(): void {
    this.#permissions.close();
  }

  /** Take the failure dialog down. */
  closeFailure(): void {
    this.#failures.close();
  }

  /** Take the login dialog down. */
  closeLogin(): void {
    this.#login.close();
  }

  /**
   * Press the failure dialog's "Choose another model", for a host's own hook. `false` when the dialog
   * is not up or carries no such response — a state a screenshot has to be recognisable in.
   */
  chooseModelInDialog(): boolean {
    return this.#failures.chooseModel();
  }

  /** Whether a failure has had its dialog put up. The one thing that says "a modal is on screen". */
  get failureShown(): boolean {
    return this.#shownFailure !== null;
  }

  /** Whether the agent reported a model option at all. */
  hasModelControl(): boolean {
    return this.#config.hasModelControl();
  }

  /** Put a fixture question through the real gate. `AgentSession.stagePermissionRequest`. */
  stagePermissionRequest(): Promise<Awaited<ReturnType<AgentSession['stagePermissionRequest']>>> {
    return this.#agent.stagePermissionRequest();
  }

  /** Set a config option through the real path, starting the agent if there is none. */
  stageConfigOption(controlId: string, value: string, prompt?: string): Promise<void> {
    return this.#agent.stageConfigOption(controlId, value, prompt);
  }

  /** Whether the gate has been asked anything at all. */
  get permissionAsked(): boolean {
    return this.#agent.permissionAsked;
  }

  get turnRunning(): boolean {
    return this.#agent.turnRunning;
  }

  get agentRunning(): boolean {
    return this.#agent.agentRunning;
  }

  get snapshot(): AgentSnapshot {
    return this.#agent.snapshot;
  }

  /** Lines from the agent drawn so far — not the person's own. A mid-turn hook waits for one. */
  get streamed(): number {
    return this.#streamed;
  }

  /** A session is open, or a new chat is waiting for its first prompt — either way a prompt has somewhere to go. */
  get hasChat(): boolean {
    return this.#openRecord !== null || this.#agent.snapshot.startsConversation;
  }

  /** The session on screen, or `null` while none is. */
  get openSessionId(): string | null {
    return this.#openRecord?.id ?? null;
  }

  /** Why no prompt can be sent at all, or `undefined`. `LotseChatOptions.noAgent`'s own sentence. */
  get sendReason(): string | undefined {
    return this.#unavailable;
  }

  /**
   * End the agent: cancel the turn, wait, terminate.
   *
   * **The order is not interchangeable.** Cancelling first gives the agent the chance to answer
   * `cancelled` and flush; terminating first would SIGTERM it out of the turn it is in the middle of,
   * which is the one ordering that loses work. The spawn-time closer runs afterwards as the backstop
   * for a process that existed while nothing had awaited a turn — `AcpClient.close` and
   * `StdioChannel.terminate` are both idempotent, so a second call costs nothing.
   */
  async shutdown(): Promise<void> {
    // First, and not awaited: a voice outlives the widget that started it — the engine is the
    // host's — so a chat torn down mid-sentence would otherwise keep talking with nothing on screen.
    this.#readAloud?.stop();
    this.#probeAbort.abort();
    await this.#probe;
    await this.#agent.shutdown();
    this.#agentClose?.();
  }
}

/**
 * The composer's render inputs from a snapshot.
 *
 * **A function rather than an object literal at the call site**, because it is the *only* place that
 * knows `AgentSnapshot` and `ComposerInput` are two views of one thing: `agentStatus` turns the
 * attachment into the two fields the composer needs, and `composerView` turns those into a button.
 * Assembled inline, the join between the two core modules would be a second implementation of it.
 */
function composerInput(snapshot: AgentSnapshot, unavailable?: string): ComposerInput {
  return {
    ...(unavailable ? { unavailable } : {}),
    state: snapshot.state,
    agent: agentStatus(snapshot.attachment),
    sessionId: snapshot.sessionId,
    startsConversation: snapshot.startsConversation,
    // `null` for every host that set no `modelPolicy`, so this changes nothing for lotse's own window.
    modelBlock: snapshot.modelBlock,
  };
}

GObject.registerClass(
  {
    GTypeName: LotseChat.GTypeName,
    Template,
    // **The six ids `chat.blp` declares, written out.** The generated `chat.d.blp.ts` sidecar names
    // them too, but nothing in this repo imports a `.blp` by name: `tsc` would need
    // `allowArbitraryExtensions` to resolve a sidecar at all, and without it the ambient
    // `declare module '*.blp'` answers first with a default-only module (TS2614). So this is the
    // shape `PermissionBody` already uses in `permission-dialog.ts` and the one `window.ts` uses for
    // the shell — one convention for every template here, with the `declare readonly _x` fields
    // above as the typed half.
    InternalChildren: [
      'stack',
      'closedHost',
      'noAgentHost',
      'transcriptHost',
      'composerHost',
      'cwdCaption',
      'freeModelNotice',
      'freeModelLabel',
      'freeModelDismiss',
    ],
  },
  LotseChat,
);
