/** One request from the chat as a run: `/ask` and a plain message, without a task of its own. */

import type { McpServer } from '@lotse/acp';

import { withPreamble } from '../profile/resolve.ts';
import { withAuthHint } from '../run.ts';
import { profileOf } from '../profile/resolve.ts';
import { PERSON_NEEDED_OFF, type Task } from './task.ts';
import { REQUEST_TASK, type RunDeps, type RunResult } from './deps.ts';
import { runSession } from './run.ts';
import { continueSession, serversFor } from './session.ts';

/** One request from the chat, as `runRequest` takes it. */
export interface RequestRun {
  /** A profile id of profiles.json: agent, model and user. */
  readonly profile: string;
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  readonly rights: 'read' | 'confirm';
  /** Put in front of `text` when the session is new. */
  readonly preamble: string;
  readonly text: string;
  /** The session to continue; `null`: a new one. */
  readonly sessionId: string | null;
}

/**
 * `new` and the two continuations as in `answerQuestion`; `fresh` when a session was to be continued
 * but the agent can neither load nor resume it, so a new one started.
 */
export type RequestMode = 'new' | 'loaded' | 'resumed' | 'fresh';

export interface RequestRunResult {
  readonly run: RunResult;
  readonly how: RequestMode;
}

/** The task an ad-hoc run is: no reply questions, its permission questions to every channel. */
export function requestTask(request: Omit<RequestRun, 'text' | 'sessionId' | 'preamble'>): Task {
  return {
    id: REQUEST_TASK,
    profile: request.profile,
    prompt: '',
    cwd: request.cwd,
    mcpServers: request.mcpServers,
    precheck: null,
    rights: request.rights,
    personNeeded: PERSON_NEEDED_OFF,
  };
}

/**
 * One request from the chat: a turn in a new session, or in `sessionId` continued by `session/load`,
 * else `session/resume`, else a new session. The agent's final message comes back as `run.reply` for
 * the caller to deliver; the run never turns it into a reply question. Throws when the profile is not
 * configured.
 */
export async function runRequest(request: RequestRun, deps: RunDeps): Promise<RequestRunResult> {
  const task = requestTask(request);
  profileOf(deps.profiles, task);
  let how: RequestMode = 'new';
  const run = await runSession(
    task,
    deps,
    deps.now(),
    async (client, extra, profile) => {
      const servers = serversFor(task, profile);
      // The request's own preamble replaces the profile's, like its servers do.
      const opening = withPreamble(request.preamble.trim() || profile.preamble, request.text);
      if (request.sessionId) {
        const continued = await continueSession(client, task.cwd, request.sessionId, servers, extra);
        if (continued) {
          how = continued.how;
          return { sessionId: request.sessionId, configOptions: continued.configOptions, text: request.text };
        }
        how = 'fresh';
      }
      const session = await withAuthHint('session/new', () =>
        client.newSession({ cwd: task.cwd, mcpServers: [...servers, ...extra] }),
      );
      return { sessionId: session.sessionId, configOptions: session.configOptions ?? null, text: opening };
    },
    { replyQuestions: false },
  );
  return { run, how };
}
