/**
 * A profile turned into what a host needs to start a session (ADR 0007 §2).
 *
 * `resolveProfile` is the one place that answers "which agent, model, options, tools and preamble does
 * this profile mean". The listen runner and the messenger requests use it today; the widget and
 * `runJob` hosts take the same result (`jobOptionsOf` for the latter). Finding the launcher stays the
 * host's — core knows no launcher table — so it is passed in.
 */

import type { McpServer } from '@lotse/acp';

import type { AgentCommand } from '../agents/stdio.ts';
import type { RightsLevel, ServeProfile } from '../serve/config.ts';
import type { ConfigOptionValue, Profile } from './profile.ts';

export interface ProfileResolvers {
  /** The agent for a launcher id, or the default one for `null`. Throws when it cannot be found. */
  readonly agent: (launcher: string | null) => AgentCommand;
}

/** Everything a session needs from its profile. */
export interface ProfileSession {
  readonly profile: string;
  readonly command: AgentCommand;
  readonly model: string | null;
  readonly configOptions: Readonly<Record<string, ConfigOptionValue>>;
  readonly mcpServers: readonly McpServer[];
  /** Trimmed; `null` when there is none. */
  readonly preamble: string | null;
  readonly rights: RightsLevel | null;
  readonly data: 'private' | 'public';
}

export function resolveProfile(profile: Profile, resolvers: ProfileResolvers): ProfileSession {
  return {
    profile: profile.id,
    command: resolvers.agent(profile.agent),
    model: profile.model,
    configOptions: profile.configOptions,
    mcpServers: profile.mcpServers,
    preamble: profile.preamble?.trim() || null,
    rights: profile.rights,
    data: profile.data,
  };
}

const RIGHTS_ORDER: readonly RightsLevel[] = ['read', 'confirm', 'released'];

/** The lower of the rights asked for and the profile's limit. No limit: what was asked for. */
export function narrowRights(requested: RightsLevel, limit: RightsLevel | null): RightsLevel {
  if (limit === null) return requested;
  return RIGHTS_ORDER.indexOf(limit) < RIGHTS_ORDER.indexOf(requested) ? limit : requested;
}

const NO_OPTIONS = {} as const;

/**
 * The profile a listen profile stands for: the shared one it was bound to, with the agent, model and
 * data it ended up with (the precheck overrides the model, so those must win over `base`). A listen
 * profile with no shared one is the legacy case: agent, model and data only.
 */
export function profileFromServe(listen: ServeProfile): Profile {
  return {
    configOptions: NO_OPTIONS,
    mcpServers: [],
    preamble: null,
    rights: null,
    ...listen.base,
    id: listen.id,
    agent: listen.agent,
    model: listen.model,
    data: listen.data,
  };
}

/** `text` with the preamble in front of it, or `text` when there is no preamble. */
export function withPreamble(preamble: string | null, text: string): string {
  const lead = preamble?.trim();
  return lead ? `${lead}\n\n${text}` : text;
}

/**
 * The part of `runJob`'s options a resolved profile decides: the agent, the model and the MCP servers.
 * Spread it into `runJob`'s options; the job's own policy (gate, model policy, timeout) stays the
 * host's. The preamble is not in it — a job's prompt is the host's text, so `withPreamble` it there.
 */
export function jobOptionsOf(session: ProfileSession): {
  readonly command: AgentCommand;
  readonly mcpServers: readonly McpServer[];
  readonly model?: string;
} {
  return {
    command: session.command,
    mcpServers: session.mcpServers,
    ...(session.model ? { model: session.model } : {}),
  };
}
