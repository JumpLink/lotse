/**
 * What a legacy tasks.json becomes: users.json, profiles.json and one SKILL.md per task (ADR 0007).
 *
 * tasks.json once held users, profiles and tasks in one file. Each of those has a file of its own
 * now, and nothing reads tasks.json any more. This derives the new files from an old one. It is
 * pure: the app reads the prompt files, decides which targets are missing, writes them, tells the
 * person — and never touches tasks.json. An entry that would not validate is left out, not guessed at.
 */

import type { McpServer } from '@lotse/acp';

import { isId, isRecord } from '../parse.ts';
import { PERSON_NEEDED_OFF, type PersonNeededConfig } from '../task/task.ts';
import { TASK_METADATA } from '../task/skill.ts';
import { ProfilesError, parseProfiles } from './profile.ts';
import { UsersError, parseUsers } from '../users/users.ts';

export interface LegacyMigration {
  /** The text of a users.json, or `null` when tasks.json has no usable user. */
  readonly users: string | null;
  /** The text of a profiles.json, or `null` when tasks.json has no usable profile. */
  readonly profiles: string | null;
  readonly skills: readonly { readonly id: string; readonly text: string }[];
}

interface LegacyTask {
  readonly id: string;
  readonly profile: string;
  readonly cwd: string;
  readonly rights: 'read' | 'confirm';
  readonly mcpServers: readonly McpServer[];
  readonly personNeeded: PersonNeededConfig;
  readonly prompt: string;
  readonly precheck: string | null;
}

/**
 * Derive the new files from the text of a tasks.json. `readPrompt` gives the text of a prompt file
 * named relative to it, or `null` when there is none. Not JSON: nothing to carry over.
 */
export function migrateLegacy(
  tasksText: string,
  readPrompt: (file: string) => string | null,
): LegacyMigration {
  let raw: unknown;
  try {
    raw = JSON.parse(tasksText);
  } catch {
    return { users: null, profiles: null, skills: [] };
  }
  if (!isRecord(raw)) return { users: null, profiles: null, skills: [] };
  return {
    users: usersFrom(entries(raw['users'])),
    profiles: profilesFrom(entries(raw['profiles'])),
    skills: entries(raw['tasks']).flatMap((entry) => {
      const task = taskFrom(entry, readPrompt);
      return task ? [{ id: task.id, text: skillFromLegacy(task) }] : [];
    }),
  };
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** `values` as the text of a file `key` holds, when the parser accepts it; `null` otherwise. */
function fileOf(
  key: string,
  values: Record<string, unknown>[],
  check: (text: string) => unknown,
  error: new (...args: never[]) => Error,
): string | null {
  const unique = values.filter(
    (value, index) => values.findIndex((other) => other['id'] === value['id']) === index,
  );
  if (unique.length === 0) return null;
  const text = `${JSON.stringify({ version: 1, [key]: unique }, null, 2)}\n`;
  try {
    check(text);
  } catch (caught) {
    if (caught instanceof error) return null;
    throw caught;
  }
  return text;
}

function usersFrom(users: Record<string, unknown>[]): string | null {
  const usable = users.flatMap(({ id, addresses }) =>
    typeof id === 'string' ? [{ id, ...(Array.isArray(addresses) ? { addresses } : {}) }] : [],
  );
  return fileOf('users', usable, parseUsers, UsersError);
}

/** Only what a profile of tasks.json has always had moves, so the migrated profile behaves as before. */
function profilesFrom(profiles: Record<string, unknown>[]): string | null {
  const usable = profiles.flatMap((entry) => {
    const { id, agent, model, data, user, channels, messengerDetail } = entry;
    if (typeof id !== 'string' || (data !== 'private' && data !== 'public')) return [];
    return [
      {
        id,
        ...(nonEmpty(agent) ? { agent } : {}),
        ...(nonEmpty(model) ? { model } : {}),
        data,
        ...(nonEmpty(user) ? { user } : {}),
        ...(Array.isArray(channels) ? { channels } : {}),
        ...(messengerDetail === 'full' || messengerDetail === 'notice' ? { messengerDetail } : {}),
      },
    ];
  });
  return fileOf('profiles', usable, parseProfiles, ProfilesError);
}

function taskFrom(
  entry: Record<string, unknown>,
  readPrompt: (file: string) => string | null,
): LegacyTask | null {
  const { id, profile, cwd, rights, mcpServers, personNeeded, precheck } = entry;
  if (typeof id !== 'string' || !isId(id) || typeof profile !== 'string') return null;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const prompt = promptOf(entry, readPrompt);
  if (prompt === null) return null;
  const check = isRecord(precheck) ? promptOf(precheck, readPrompt) : null;
  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  const need =
    isRecord(personNeeded) && personNeeded['enabled'] === true ? personNeeded['timeoutMin'] : undefined;
  return {
    id,
    profile,
    cwd,
    // A task right of `released` has no SKILL.md form: it falls to `confirm`, which asks.
    rights: rights === 'read' ? 'read' : 'confirm',
    mcpServers: servers.filter(
      (server): server is McpServer => isRecord(server) && typeof server['name'] === 'string',
    ),
    personNeeded:
      isRecord(personNeeded) && personNeeded['enabled'] === true
        ? { enabled: true, timeoutMin: typeof need === 'number' ? need : null }
        : PERSON_NEEDED_OFF,
    prompt,
    precheck: check,
  };
}

/** The inline `prompt` or the text of `promptFile`; `null` when neither gives any text. */
function promptOf(
  record: Record<string, unknown>,
  readPrompt: (file: string) => string | null,
): string | null {
  const text = nonEmpty(record['prompt'])
    ? record['prompt']
    : nonEmpty(record['promptFile'])
      ? readPrompt(record['promptFile'])
      : null;
  return text !== null && text.trim() !== '' ? text : null;
}

function skillFromLegacy(task: LegacyTask): string {
  const q = (value: string) => JSON.stringify(value);
  const metadata = [
    `  ${TASK_METADATA.profile}: ${q(task.profile)}`,
    `  ${TASK_METADATA.rights}: ${q(task.rights)}`,
    `  ${TASK_METADATA.cwd}: ${q(task.cwd)}`,
    ...(task.personNeeded.enabled
      ? [`  ${TASK_METADATA.personNeeded}: ${q(String(task.personNeeded.timeoutMin ?? 'true'))}`]
      : []),
    ...(task.precheck
      ? [`  ${TASK_METADATA.precheck}: ${q(task.precheck.replace(/\s+/g, ' ').trim())}`]
      : []),
  ];
  return [
    '---',
    `name: ${task.id}`,
    `description: ${q(`Migrated from tasks.json (task ${task.id})`)}`,
    ...(task.mcpServers.length > 0 ? [`allowed-tools: ${task.mcpServers.map((s) => s.name).join(' ')}`] : []),
    'metadata:',
    ...metadata,
    '---',
    '',
    task.prompt.trim(),
    '',
  ].join('\n');
}
