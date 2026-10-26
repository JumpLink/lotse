/**
 * Applying an edited `channel.messenger.requests` to a running `listen` (docs/listen.md, "Requests from the
 * chat"). Looked at once per pass: a change becomes the `ChatRequests` that messages
 * arriving afterwards go to, while a request already running finishes inside the instance it started in.
 * A settings.json that cannot be read keeps the previous instance.
 */

import type { ChatRequests, RequestSettings } from '@lotse/core';
import { requestProblem } from '@lotse/core';

export type RequestsChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly line: string; readonly on: boolean }
  | { readonly kind: 'problem'; readonly line: string };

export interface RequestsHolderOptions {
  /** The settings as the file is now; `null` when it cannot be read (the previous ones stay). */
  readonly read: () => RequestSettings | null;
  /** The profile ids profiles.json has right now. */
  readonly profiles: () => readonly string[];
  readonly build: (settings: RequestSettings) => ChatRequests;
}

export interface RequestsHolder {
  /** The instance new messages go to; `undefined` while requests are off. */
  current(): ChatRequests | undefined;
  check(): RequestsChange;
}

export function createRequestsHolder(options: RequestsHolderOptions): RequestsHolder {
  let instance: ChatRequests | undefined;
  let seen: string | null = null;
  return {
    current: () => instance,
    check() {
      const settings = options.read();
      if (!settings) return { kind: 'unchanged' };
      const profiles = options.profiles();
      const key = JSON.stringify([settings, profiles]);
      if (key === seen) return { kind: 'unchanged' };
      const first = seen === null;
      seen = key;
      const problem = requestProblem(settings, profiles);
      if (problem) {
        instance = undefined;
        return { kind: 'problem', line: `chat requests not started: ${problem}` };
      }
      if (!settings.enabled) {
        instance = undefined;
        return first ? { kind: 'unchanged' } : { kind: 'changed', on: false, line: 'chat requests off' };
      }
      instance = options.build(settings);
      const what = `profile ${settings.profile}, rights ${settings.rights}, prefix ${settings.prefix}`;
      return {
        kind: 'changed',
        on: true,
        line: first
          ? `chat requests on: ${what}`
          : `chat requests reloaded: ${what} (a request in progress finishes as it was)`,
      };
    },
  };
}
