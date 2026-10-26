/**
 * `@lotse/core` — lotse without a surface.
 *
 * Layer 2, between the protocol (`@lotse/acp`) and whatever is rendering: which agent to start
 * and how to start it, the session a prompt turn runs in, the view models a chat is drawn from,
 * and the provider login. The CLI, the Adwaita window and an embedded widget are three consumers
 * of the same code, which is the whole reason this package exists — see
 * [ADR 0001](../../../docs/adr/0001-lotse-as-an-embeddable-widget.md).
 *
 * **Nothing here knows a toolkit.** No `gi://`, no yargs, no widget: the pieces that need a
 * decision take it as an argument. Paths arrive as a `LotsePaths`, the agent choice as an
 * `AgentChoice`, the permission answer as a `ClientGate`. That is what lets a host put lotse's
 * conversation in its own data directory, and what keeps every file in here testable on Node as
 * well as on GJS.
 *
 * **One door, and it is this file.** The package exports `.` only, so what a consumer may reach is
 * a decision made here rather than a side effect of the directory layout. An export added below is
 * a promise to the widget and to any host; an internal helper stays internal.
 */

// ── Translation ─────────────────────────────────────────────────────────────────────────────────
// The library's own gettext domain and the four call sites every string in here goes through. The
// translator is registered by `@lotse/widget` (or by lotse's app), because core must stay importable
// on Node where GJS's `gettext` module does not exist — ADR 0005.
export {
  LOTSE_TEXT_DOMAIN,
  _,
  _n,
  _p,
  N_,
  fmt,
  libraryTranslator,
  hasLibraryTranslator,
  setLibraryTranslator,
  type LibraryTranslator,
} from './i18n.ts';

// ── Where lotse keeps things ────────────────────────────────────────────────────────────────────
// The shape, and the layout a host gets. The app's own XDG/`LOTSE_*` resolver stays in the app,
// and `envKnob` is how both sides read a knob under its new name and its old one.
export { envKnob } from './env.ts';
export { lotsePathsUnder, type LotsePaths } from './paths.ts';

// ── Which agent, and where its private HOME goes ─────────────────────────────────────────────────
export { describeChoice, type AgentChoice, type AgentChoiceSource } from './agents/choice.ts';
export {
  BUNDLED_AGENTS,
  BUNDLED_CATALOG,
  BUNDLED_PREFIX,
  bundledProgram,
  parseBundledCatalog,
  type BundledAgent,
  type BundledArch,
  type BundledCatalog,
  type BundledDist,
} from './agents/catalog.ts';
export { flatpakAgentModule, type FlatpakAgentModule } from './agents/flatpak-module.ts';
export {
  detectAgents,
  parseVersionOutput,
  resolveAgent,
  type AgentDetection,
  type AgentFacts,
  type AgentSource,
  type Resolution,
} from './agents/detect.ts';
export {
  chooseAgent,
  STAND_IN_AGENT_ID,
  standInCommand,
  standInScriptPath,
  STAND_IN_SCRIPT,
  type DevAgentChoice,
} from './agents/dev-agent.ts';
export {
  AgentInstallError,
  distFor,
  effectiveCatalog,
  installAgent,
  installedEntry,
  installedPath,
  installRoot,
  isInstalled,
  type InstallFailure,
  type InstallOptions,
} from './agents/install.ts';
export { isolationDirs, isolationEnv, prepareIsolation, type IsolationDirs } from './agents/isolation.ts';
export { DEFAULT_AGENT, findLauncher, launcherIds, LAUNCHERS, requireLauncher } from './agents/launcher.ts';
export { OPENCODE_COMMAND, OPENCODE_LOGIN } from './agents/opencode.ts';
export {
  gatherAgentFacts,
  gatherAgentFactsAsync,
  gatherCwdFacts,
  gatherResolveContext,
  gatherResolveContextAsync,
} from './agents/probe.ts';
export {
  bundledCommand,
  describeResolved,
  NO_AGENT_MESSAGE,
  resolveDefault,
  resolveDefaultWithNote,
  resolveRecorded,
  sameCommand,
  type DefaultResolution,
  type RecordedResolution,
  type ResolveContext,
  type ResolvedAgent,
  type ResolvedSource,
} from './agents/resolve.ts';
export {
  currentSandboxFacts,
  FLATPAK_SPAWN,
  hostCwdArgv,
  hostProbeArgv,
  isSandboxed,
  toHostCommand,
  type SandboxFacts,
} from './agents/sandbox.ts';
export {
  needsWindowsShell,
  parseHostProbeOutput,
  probeAccepts,
  resolveSpawnCommand,
  StdioChannel,
  stdioTransport,
  which,
  whichAsync,
  type AgentCommand,
  type StdioChannelOptions,
} from './agents/stdio.ts';
export { displayCwd, resolveCwd, type CwdFacts } from './cwd.ts';

// ── Starting an agent, and one prompt turn ───────────────────────────────────────────────────────
export {
  openAgent,
  runTurn,
  withAuthHint,
  type AgentHandle,
  type OpenAgentOptions,
  type TurnOptions,
} from './run.ts';
export type { McpServer } from '@lotse/acp';

// ── Headless jobs: input in, a typed value out (ADR 0004) ───────────────────────────────────────
export {
  JOB_TIMEOUT_MS,
  JobError,
  jobPrompt,
  runJob,
  type JobErrorKind,
  type JobLogEntry,
  type JobOptions,
  type JobResult,
} from './job.ts';
export {
  AgentSession,
  type AgentSessionEvents,
  type AgentSessionOptions,
  type AgentSnapshot,
  type BoundSession,
} from './agent-session.ts';
export {
  decideInterrupt,
  installInterruptHandler,
  type InterruptAction,
  type InterruptHandle,
  type InterruptHooks,
  type InterruptState,
} from './interrupt.ts';
export {
  conversationRecord,
  titleFromPrompt,
  unsavedMessage,
  type ConversationInput,
} from './conversation.ts';

// ── The login an agent asks for, and the login lotse can arrange ────────────────────────────────
export {
  arrangeAuth,
  authPlan,
  describeAuthMethod,
  describeAuthMethods,
  loginCommandFor,
  type AuthArrangement,
  type AuthHooks,
  type AuthPlan,
} from './auth.ts';
export {
  SERVER_KILL_GRACE_MS,
  SERVER_START_TIMEOUT_MS,
  serverCommand,
  startServer,
  whyNoLoginServer,
  type OpencodeServer,
} from './agents/server.ts';
export {
  createLoginApi,
  LoginApiError,
  type HttpResponse,
  type OpencodeLogin,
  type Send,
} from './login/api.ts';
export {
  answersFor,
  EXPIRY_GRACE_MS,
  MAX_POLL_FAILURES,
  POLL_MS,
  runLogin,
  type LoginApi,
  type LoginHooks,
  type LoginMode,
  type LoginPrompt,
  type LoginResult,
  type OAuthAttempt,
  type OAuthStatus,
} from './login/flow.ts';
export {
  LoginController,
  type LoginControllerDeps,
  type LoginSession,
  type LoginState,
} from './login/controller.ts';
export {
  KEY_METHOD_ID,
  LOGIN_POLICY,
  parseIntegrations,
  parseLoginPolicy,
  type LoginField,
  type LoginFieldCondition,
  type LoginFieldOption,
  type LoginMethod,
  type LoginPolicy,
  type LoginProvider,
} from './login/providers.ts';
export {
  loginUnavailableReason,
  openLoginSession,
  openSettingsSession,
  probeConnections,
} from './login/session.ts';
export {
  connectionFacts,
  onboardingView,
  type ConnectionFacts,
  type OnboardingInput,
  type OnboardingPath,
  type OnboardingView,
} from './onboarding.ts';

// ── Custom providers: lotse's own opencode config file, read back over the login server ──────────
export {
  CUSTOM_PRESETS,
  LOCAL_MODEL_HINT,
  MIN_CONTEXT_TOKENS,
  checkEndpoint,
  contextWarning,
  hostReach,
  reachPrivacyNote,
  type CustomPreset,
  type EndpointCheck,
  type EndpointReach,
} from './custom/endpoint.ts';
export {
  LOCK_STALE_MS,
  OPENAI_COMPATIBLE_PACKAGE,
  ProvidersFileBusyError,
  customProvidersEnv,
  customProvidersFile,
  customProvidersFileOf,
  documentProviderIds,
  parseProvidersDocument,
  providerEntry,
  providerIdProblem,
  readProvidersDocument,
  updateProvidersDocument,
  withProvider,
  withoutProvider,
  writeProvidersDocument,
  type CustomModel,
  type CustomProvider,
  type ProvidersDocument,
} from './custom/file.ts';
export {
  MODELS_TIMEOUT_MS,
  RELOAD_TIMEOUT_MS,
  createProviderApi,
  parseConfiguredProviders,
  parseIdList,
  parseModelList,
  probeModels,
  type ConfiguredProvider,
  type FetchLike,
  type ProviderApi,
  type WaitHooks,
} from './custom/api.ts';
export {
  RESERVED_PROVIDER_IDS,
  parseModelSpecs,
  planCustomProvider,
  planWithListedModels,
  type CustomProviderFacts,
  type CustomProviderInput,
  type CustomProviderPlan,
  type ListedPlan,
  type ModelLister,
} from './custom/plan.ts';
export {
  FREE_MODELS_DENIED_NOTE,
  FREE_MODELS_PRIVACY_NOTE,
  HOST_READ_ONLY_REASON,
  NOT_LOTSE_COPY_REASON,
  PROVIDER_PRIVACY_NOTE,
  ProviderSettingsController,
  type AddOutcome,
  type ConnectedRow,
  type CustomRow,
  type ProviderSettingsDeps,
  type ProviderSettingsState,
  type ProviderSettingsView,
  type SettingsFiles,
  type SettingsSession,
} from './custom/settings.ts';

// ── What a turn is doing, and what went wrong ────────────────────────────────────────────────────
export {
  agentExitedEntry,
  agentName,
  agentStatus,
  isEchoOf,
  isOnScreen,
  leavesRunningTurn,
  permissionDecisionEntry,
  transition,
  type AgentAttachment,
  type AgentStatus,
  type CancelledBy,
  type TurnEvent,
} from './turn.ts';
export {
  AUTH_COMMAND,
  AuthRequiredError,
  failureAction,
  failureKind,
  failureNotice,
  failureToShow,
  isQuotaExhausted,
  staleDialog,
  type FailureAction,
  type FailureActionContext,
  type FailureContext,
  type FailureKind,
  type FailureNotice,
} from './failure.ts';

// ── Answering the agent's permission request ─────────────────────────────────────────────────────
export {
  agentNames,
  answerFor,
  decideFromView,
  escapeMnemonic,
  initialFocusResponseId,
  isKnownOptionKind,
  optionLabel,
  orderOptions,
  PermissionDesk,
  permissionView,
  usableOptions,
  type NotAnsweredReason,
  type PermissionDecision,
  type PermissionQuestion,
  type PermissionView,
} from './permission.ts';
export { chunkToText, describe, terminalGate, type Terminal, type TerminalGateOptions } from './policy.ts';
// The host's two rules about a tool call: one it confirms itself, and an always-allow that lives one
// session. Absent `hostTools` is lotse's own behaviour unchanged.
export {
  HOST_CONFIRM_NO_ONCE_NOTE,
  SessionGrants,
  hostConfirmDecision,
  hostConfirmed,
  hostToolProblems,
  matchesTool,
  narrowestAllow,
  narrowestReject,
  scopedOptions,
  sessionAnswer,
  toolGate,
  toolRefOf,
  type AlwaysAllowScope,
  type HostToolMatch,
  type HostToolPolicy,
  type ToolGate,
  type ToolRef,
} from './host-tools.ts';

// ── The view models a chat is drawn from ─────────────────────────────────────────────────────────
export {
  composerView,
  keepsDraft,
  offersStop,
  type ComposerAction,
  type ComposerInput,
  type ComposerView,
  type TurnState,
} from './composer-state.ts';
export {
  configValue,
  currentLabel,
  findControl,
  MODEL_CATEGORY,
  projectConfigOptions,
  type ConfigControl,
  type ConfigSelectControl,
  type ConfigSwitchControl,
  type ConfigValue,
} from './config.ts';
export {
  applyConfigUpdate,
  configAfterSet,
  configRequest,
  configSwitchRequest,
  configRowInput,
  configSelection,
  emptyConfigRow,
  isConfigChange,
  isSwitchChange,
  modelControl,
  parseConfigOptionSpec,
  REFUSED,
  type ConfigRowControl,
  type ConfigRowSwitch,
  type ConfigRowInput,
  type ConfigRowView,
  type ConfigSelection,
} from './config-row.ts';
export {
  NO_MCP_TOGGLES,
  activeMcpServers,
  mcpServerNames,
  mcpTogglesView,
  resumePending,
  toggleMcpServer,
  type McpToggle,
  type McpTogglesView,
} from './mcp-toggles.ts';
export {
  FREE_MODEL_WARNING,
  FREE_MODELS_WITHOUT_SUFFIX,
  freeModelFirst,
  freeModelWarningDue,
  isFreeModel,
} from './free-models.ts';
// What a host will let a prompt reach. Absent `modelPolicy` is lotse's own behaviour unchanged.
export {
  allowedModelValues,
  allowOnlyProviders,
  denyFreeHostedModels,
  freeModelInUse,
  MODEL_DENIED_REASON,
  MODEL_UNKNOWN_REASON,
  modelAllowed,
  modelBlock,
  ModelDeniedError,
  providerOffered,
  type ModelBlock,
  type ModelDecision,
  type ModelPolicy,
} from './model-policy.ts';
export { fitsInputCap, mcpCallsOf, toTranscript } from './transcript.ts';
export type { HostRecord, McpCall, ToolCallRecord } from '@lotse/session';
export {
  toTranscriptItems,
  type AgentItem,
  type DisclosureItem,
  type HostItem,
  type SystemItem,
  type ThoughtItem,
  type ToolCallView,
  type ToolItem,
  type TranscriptItem,
  type UserItem,
} from './transcript-items.ts';
export { describeUsage, formatCost, formatUsageNumber } from './usage.ts';
export {
  followLanded,
  FOLLOW_MAX_ATTEMPTS,
  followTarget,
  isAtBottom,
  resolveFollow,
  shouldRetryFollow,
  type AdjustmentSignal,
  type FollowInput,
  type FollowUpdate,
} from './scroll.ts';

// ── What the window says when there is no agent, or a notice is owed ─────────────────────────────
export {
  DOCS_URL,
  emptyStateView,
  INSTALL_COMMAND,
  NO_AGENT_REMEDY,
  noticeView,
  type EmptyStateView,
  type NoticeView,
} from './empty-state.ts';
export { noticeDue, NOTICE_IDS, type NoticeId } from './notices.ts';

// ── `lotse listen`: tasks, questions to a person, the channel seam (ADR 0003) ─────────────
export {
  DEFAULT_PERSON_TIMEOUT_MIN,
  PERSON_KINDS,
  REDACTED,
  holdPerson,
  isHeld,
  offerCode,
  parsePersonReply,
  peekCode,
  personRefusal,
  personText,
  releasePerson,
  type PersonHandler,
  type PersonHost,
  type PersonKind,
  type PersonNeededInput,
  type PersonOutcome,
  type PersonReply,
} from './questions/person.ts';
export { PERSON_TOOL, createPersonHost } from './questions/person-server.ts';
export { parseDuration } from './questions/duration.ts';
export {
  DEFAULT_QUESTION_LIMITS,
  PERSON_NEEDED_OFF,
  type PersonNeededConfig,
  type QuestionLimits,
  type ReleasedArea,
  type RightsLevel,
  type Precheck,
  type Task,
} from './task/task.ts';
export { UsersError, parseUsers, userOf, userProblems, type User } from './users/users.ts';
export { USERS_SCHEMA } from './users/schema.ts';
export {
  deliveryOf,
  deliveryOfTask,
  freeModelNotes,
  unreachableProfileNotes,
  type Delivery,
  type MessengerDetail,
} from './profile/delivery.ts';
export {
  createdSince,
  findQuestions,
  formatQuestionId,
  isOpen,
  isQuestionText,
  nextQuestionId,
  normalizeQuestionId,
  openQuestions,
  parseAnswer,
  parseQuestions,
  pruneQuestions,
  quickReplies,
  type AnswerKind,
  type ParsedAnswer,
  type Question,
  type QuestionAction,
  type QuestionKind,
  type QuestionStatus,
} from './questions/question.ts';
export {
  callDigest,
  describeCall,
  taskGate,
  stripAlways,
  type AskOutcome,
  type GateDecision,
  type TaskGateOptions,
  type GateToken,
} from './task/gate.ts';
export type { QuestionChannel, QuestionMessage } from './questions/channel.ts';
export {
  CHANNEL_NAMES,
  MESSENGER_DEFAULTS,
  REQUEST_DEFAULTS,
  messengerCommand,
  messengerProblem,
  requestProblem,
  requestSettings,
  type ChannelName,
  type MessengerSettings,
  type RequestEnvVariable,
  type RequestMcpServer,
  type RequestSettings,
} from './messenger/settings.ts';
export {
  MAX_PARTS,
  PART_CHARS,
  chatRequests,
  matchPrefix,
  recoverPending,
  splitForChat,
  type ChatRequests,
  type PendingRequest,
  type PendingStore,
  type ChatRequestsOptions,
} from './messenger/requests.ts';
export { McpToolError, connectMcp, type McpToolInfo, type McpTools } from './messenger/mcp-client.ts';
export { McpLink } from './messenger/link.ts';
export {
  DEFAULT_CAPABILITIES_TOOL,
  FALLBACK_WAIT_S,
  negotiateContract,
  parseCapabilities,
  waitSeconds,
  type MessengerContract,
  type ProtocolCapabilities,
} from './messenger/contract.ts';
export {
  longPollSource,
  parseWaitResult,
  type IncomingMessage,
  type MessagePage,
  type MessageSource,
  type NextOptions,
} from './messenger/source.ts';
export {
  RETRY_DELAYS_MS,
  combineChannels,
  messengerChannel,
  messengerText,
  noticeOf,
  localDeadline,
  localTime,
  routeChannels,
  sendToPeer,
  sendToPeerWithIds,
  type ChannelFailure,
  type ChannelRoute,
  type MessengerChannel,
  type MessengerChannelOptions,
} from './messenger/channel.ts';
export { openIds, parseReply, type ReplyIntent } from './messenger/reply.ts';
export { findRef, memoryRefs, recordRefs, REF_LIMIT, type RefStore, type SentRef } from './messenger/refs.ts';
export {
  abortableSleep,
  chatSays,
  messageKey,
  runReceiveLoop,
  type Cursor,
  type CursorStore,
  type ChatCommands,
  type ReceiveOptions,
} from './messenger/receive.ts';
export { isId } from './parse.ts';
export { schemaKeys, type SchemaNode } from './schema.ts';
export { ProfileOptionError, applyConfigOptions } from './profile/apply.ts';
export { migrateLegacy, type LegacyMigration } from './profile/legacy.ts';
export { ProfilesError, parseProfiles, type ConfigOptionValue, type Profile } from './profile/profile.ts';
export {
  jobOptionsOf,
  narrowRights,
  profileOf,
  resolveProfile,
  withPreamble,
  type ProfileResolvers,
  type ProfileSession,
} from './profile/resolve.ts';
export { PROFILES_SCHEMA } from './profile/schema.ts';
export { isVoicePolicy, narrowVoice, type VoicePolicy } from './voice-policy.ts';
export { speakableText, type SpeakableOptions } from './speakable.ts';
export { sentenceChunker, type SentenceChunker, type SentenceChunkerOptions } from './sentence-chunker.ts';
export { answerQuestion, type AnswerMode, type AnswerResult } from './questions/answer.ts';
export { cancelOrphanedPermissions } from './questions/ask.ts';
export {
  ModelUnavailableError,
  REQUEST_TASK,
  type PrecheckVerdict,
  type QuestionBook,
  type RunDeps,
  type RunLogEntry,
  type RunOutcome,
  type RunResult,
} from './task/deps.ts';
export { parseVerdict, precheckText } from './task/precheck.ts';
export { LOCKED, runTask, type TaskRun } from './task/run.ts';
export { runRequest, type RequestMode, type RequestRun, type RequestRunResult } from './task/request.ts';
export {
  TASK_METADATA,
  TaskFileError,
  TaskUsageError,
  narrowServers,
  parseParamPairs,
  parseRunArgs,
  parseSkillTask,
  renderTask,
  taskOf,
  splitWords,
  type SkillTask,
  type TaskParam,
} from './task/skill.ts';
