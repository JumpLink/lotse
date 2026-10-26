/**
 * The profile — lotse's own idea of "who a session runs as" (ADR 0007) — and the file it lives in.
 *
 * A profile used to exist only inside `lotse serve`'s tasks.json. It is a concept of its own: serve's
 * runner, a messenger request, the widget and a headless job all start a session, and each needs the
 * same answer to "which agent, which model, which tools, how much may it do". That answer is
 * `profiles.json`, read here once and handed to every host as text — like the task file, core does
 * not read files.
 *
 * What stays in tasks.json is the serve side of a profile of the same id: its user and its channels.
 */

import type { McpServer } from '@lotse/acp';

import { duplicates, id, isRecord, list, object, optionalString } from '../parse.ts';
import type { RightsLevel } from '../serve/config.ts';
import { schemaKeys } from '../serve/schema.ts';
import { PROFILES_SCHEMA } from './schema.ts';

/** A configuration option's value: a select's value id, or a switch's on/off. */
export type ConfigOptionValue = string | boolean;

export interface Profile {
  readonly id: string;
  /** A launcher id (`opencode`). `null`: the same resolution `lotse start` uses. */
  readonly agent: string | null;
  /** A value of the agent's `model` config option. `null`: the agent's own default. */
  readonly model: string | null;
  /** Other session options by id, set after the model. Empty: the agent's defaults. */
  readonly configOptions: Readonly<Record<string, ConfigOptionValue>>;
  /** Passed to `session/new` as is — MCP is passed through, not known. */
  readonly mcpServers: readonly McpServer[];
  /** Put in front of the first message of a new session. `null`: nothing. */
  readonly preamble: string | null;
  /** The most a session may do, whatever the task or request asks for. `null`: no limit. */
  readonly rights: RightsLevel | null;
  /** A label for the person. It never blocks a run (ADR 0002, amendment of 2026-10-11). */
  readonly data: 'private' | 'public';
}

/** Every problem in the file at once, so one edit fixes all of them. */
export class ProfilesError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`the profiles file has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'ProfilesError';
    this.problems = problems;
  }
}

const KEYS = {
  top: schemaKeys(PROFILES_SCHEMA),
  profile: schemaKeys(PROFILES_SCHEMA.$defs.profile),
};

/** Parse and validate `profiles.json`. Throws `ProfilesError` listing every problem. */
export function parseProfiles(text: string): Profile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProfilesError([`not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!isRecord(raw)) throw new ProfilesError(['the top level must be an object']);
  const problems: string[] = [];
  if (raw['version'] !== 1) problems.push('"version" must be 1');
  for (const key of Object.keys(raw)) {
    if (!KEYS.top.includes(key)) problems.push(`unknown key "${key}"`);
  }
  const profiles = list(raw['profiles'], 'profiles', problems).map((value, index) =>
    parseProfile(value, `profiles[${index}]`, problems),
  );
  duplicates(profiles, 'profile', problems);
  if (problems.length > 0) throw new ProfilesError(problems);
  return profiles;
}

function parseProfile(value: unknown, where: string, problems: string[]): Profile {
  const record = object(value, where, problems, KEYS.profile);
  const profileId = id(record['id'], where, problems);
  const label = profileId ? `profile "${profileId}"` : where;

  const data = record['data'];
  if (data !== 'private' && data !== 'public') {
    problems.push(`${label}.data must be "private" or "public" — say which, there is no default`);
  }

  const rights = record['rights'];
  if (rights !== undefined && rights !== 'read' && rights !== 'confirm' && rights !== 'released') {
    problems.push(`${label}.rights must be "read", "confirm" or "released"`);
  }

  const servers = record['mcpServers'] === undefined ? [] : record['mcpServers'];
  const serversValid =
    Array.isArray(servers) &&
    servers.every((server) => isRecord(server) && typeof server['name'] === 'string');
  if (!serversValid) problems.push(`${label}.mcpServers must be a list of MCP servers, each with a "name"`);

  return {
    id: profileId,
    agent: optionalString(record['agent'], `${label}.agent`, problems),
    model: optionalString(record['model'], `${label}.model`, problems),
    configOptions: parseConfigOptions(record['configOptions'], label, problems),
    mcpServers: serversValid ? (servers as McpServer[]) : [],
    preamble: optionalString(record['preamble'], `${label}.preamble`, problems),
    rights: rights === 'read' || rights === 'confirm' || rights === 'released' ? rights : null,
    data: data === 'public' ? 'public' : 'private',
  };
}

function parseConfigOptions(
  value: unknown,
  label: string,
  problems: string[],
): Record<string, ConfigOptionValue> {
  if (value === undefined) return {};
  const where = `${label}.configOptions`;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object of option ids and their values`);
    return {};
  }
  const options: Record<string, ConfigOptionValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean' || (typeof entry === 'string' && entry.trim() !== '')) {
      options[key] = entry;
    } else {
      problems.push(`${where}.${key} must be a non-empty string, or true or false`);
    }
  }
  return options;
}
