// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import jsonrpc from './unit/acp/jsonrpc.test.ts';
import client from './unit/acp/client.test.ts';
import permissionQueue from './unit/acp/permission-queue.test.ts';
import gate from './unit/acp/gate.test.ts';
import opencodeShape from './unit/acp/opencode-shape.test.ts';
import configOptions from './unit/acp/config-options.test.ts';
import transport from './unit/acp/transport.test.ts';

import sessionModel from './unit/session/model.test.ts';
import sessionStore from './unit/session/store.test.ts';

import auth from './unit/core/auth.test.ts';
import config from './unit/core/config.test.ts';
import configRow from './unit/core/config-row.test.ts';
import mcpToggles from './unit/core/mcp-toggles.test.ts';
import failure from './unit/core/failure.test.ts';
import freeModels from './unit/core/free-models.test.ts';
import modelPolicy from './unit/core/model-policy.test.ts';
import job from './unit/core/job.test.ts';
import usage from './unit/core/usage.test.ts';
import policy from './unit/core/policy.test.ts';
import interrupt from './unit/core/interrupt.test.ts';
import transcript from './unit/core/transcript.test.ts';
import composerState from './unit/core/composer-state.test.ts';
import agents from './unit/core/agents.test.ts';
import sandbox from './unit/core/sandbox.test.ts';
import catalog from './unit/core/catalog.test.ts';
import flatpakModule from './unit/core/flatpak-module.test.ts';
import detect from './unit/core/detect.test.ts';
import install from './unit/core/install.test.ts';
import isolation from './unit/core/isolation.test.ts';
import resolve from './unit/core/resolve.test.ts';
import devAgent from './unit/core/dev-agent.test.ts';
import paths from './unit/core/paths.test.ts';
import migrate from './unit/core/migrate.test.ts';
import main from './unit/core/main.test.ts';
import settings from './unit/core/settings.test.ts';
import settingsView from './unit/core/settings-view.test.ts';
import scroll from './unit/core/scroll.test.ts';
import sessionGroups from './unit/core/session-groups.test.ts';
import transcriptItems from './unit/core/transcript-items.test.ts';
import turn from './unit/core/turn.test.ts';
import permission from './unit/core/permission.test.ts';
import hostTools from './unit/core/host-tools.test.ts';
import agentSession from './unit/core/agent-session.test.ts';
import cwd from './unit/core/cwd.test.ts';
import conversation from './unit/core/conversation.test.ts';
import notices from './unit/core/notices.test.ts';
import emptyState from './unit/core/empty-state.test.ts';
import onboarding from './unit/core/onboarding.test.ts';
import loginProviders from './unit/core/login-providers.test.ts';
import loginFlow from './unit/core/login-flow.test.ts';
import loginController from './unit/core/login-controller.test.ts';
import loginApi from './unit/core/login-api.test.ts';
import customProviders from './unit/core/custom-providers.test.ts';
import providerSettings from './unit/core/provider-settings.test.ts';
import server from './unit/core/server.test.ts';
import questionActions from './unit/core/question-actions.test.ts';
import answerDialog from './unit/core/answer-dialog.test.ts';
import answerView from './unit/core/answer-view.test.ts';

import users from './unit/listen/users.test.ts';
import listenQuestions from './unit/listen/questions.test.ts';
import taskGate from './unit/listen/gate.test.ts';
import runState from './unit/listen/run-state.test.ts';
import listenRunner from './unit/listen/runner.test.ts';
import listenPerson from './unit/listen/person.test.ts';
import listenMessenger from './unit/listen/messenger.test.ts';
import listenContract from './unit/listen/contract.test.ts';
import listenRequests from './unit/listen/requests.test.ts';
import listenChatText from './unit/listen/chat-text.test.ts';
import task from './unit/task/task.test.ts';
import profile from './unit/profile/profile.test.ts';
import profileMigrate from './unit/profile/migrate.test.ts';

import hookValue from './unit/gui/hook-value.test.ts';
import modelPolicyHook from './unit/gui/model-policy-hook.test.ts';
import toolLine from './unit/gui/tool-line.test.ts';

import speakable from './unit/core/speakable.test.ts';
import readAloud from './unit/core/read-aloud.test.ts';

import i18n from './unit/i18n.test.ts';
import smoke from './unit/smoke.test.ts';

run({
  jsonrpc,
  client,
  permissionQueue,
  gate,
  opencodeShape,
  configOptions,
  transport,
  sessionModel,
  sessionStore,
  auth,
  config,
  configRow,
  failure,
  freeModels,
  modelPolicy,
  job,
  usage,
  policy,
  interrupt,
  transcript,
  composerState,
  agents,
  sandbox,
  catalog,
  flatpakModule,
  detect,
  install,
  isolation,
  resolve,
  devAgent,
  paths,
  migrate,
  main,
  settings,
  settingsView,
  scroll,
  sessionGroups,
  transcriptItems,
  turn,
  permission,
  hostTools,
  agentSession,
  mcpToggles,
  cwd,
  conversation,
  notices,
  emptyState,
  onboarding,
  loginProviders,
  loginFlow,
  loginController,
  loginApi,
  customProviders,
  providerSettings,
  server,
  questionActions,
  answerDialog,
  answerView,
  users,
  listenQuestions,
  taskGate,
  runState,
  listenRunner,
  listenPerson,
  listenMessenger,
  listenContract,
  listenRequests,
  listenChatText,
  task,
  profile,
  profileMigrate,
  hookValue,
  modelPolicyHook,
  toolLine,
  speakable,
  readAloud,
  i18n,
  smoke,
});
