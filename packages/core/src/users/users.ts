/**
 * The people `lotse listen` works for, and the file they live in: `users.json`.
 *
 * Core does not read files: the host passes the text in, like the profiles file. A profile names its
 * user; a profile that names none belongs to the only user there is.
 */

import { duplicates, id, isRecord, list, object } from '../parse.ts';
import { schemaKeys } from '../schema.ts';
import { USERS_SCHEMA } from './schema.ts';

/** A person `listen` works for. `addresses` are channel addresses; the desktop channel needs none. */
export interface User {
  readonly id: string;
  readonly addresses: readonly string[];
}

/** Every problem in the file at once, so one edit fixes all of them. */
export class UsersError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`the users file has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.name = 'UsersError';
    this.problems = problems;
  }
}

const KEYS = {
  top: schemaKeys(USERS_SCHEMA),
  user: schemaKeys(USERS_SCHEMA.$defs.user),
};

/** Parse and validate `users.json`. Throws `UsersError` listing every problem. */
export function parseUsers(text: string): User[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UsersError([`not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!isRecord(raw)) throw new UsersError(['the top level must be an object']);
  const record = raw;
  const problems: string[] = [];
  if (record['version'] !== 1) problems.push('"version" must be 1');
  for (const key of Object.keys(record)) {
    if (!KEYS.top.includes(key)) problems.push(`unknown key "${key}"`);
  }
  const users = list(record['users'], 'users', problems).map((value, index) =>
    parseUser(value, `users[${index}]`, problems),
  );
  duplicates(users, 'user', problems);
  if (problems.length > 0) throw new UsersError(problems);
  return users;
}

function parseUser(value: unknown, where: string, problems: string[]): User {
  const record = object(value, where, problems, KEYS.user);
  const addresses = record['addresses'] === undefined ? [] : record['addresses'];
  const valid = Array.isArray(addresses) && addresses.every((address) => typeof address === 'string');
  if (!valid) problems.push(`${where}.addresses must be a list of strings`);
  return { id: id(record['id'], where, problems), addresses: valid ? (addresses as string[]) : [] };
}

/**
 * The user a profile belongs to: the one it names, else the only user there is. Throws when it names
 * one that is not defined, or names none and there is not exactly one.
 */
export function userOf(
  users: readonly User[],
  profile: { readonly id: string; readonly user: string | null },
): User {
  if (profile.user === null) {
    const [only] = users;
    if (users.length === 1 && only) return only;
    throw new Error(`profile "${profile.id}" names no user, and there is not exactly one user to default to`);
  }
  const user = users.find((candidate) => candidate.id === profile.user);
  if (!user) throw new Error(`profile "${profile.id}" has no user "${profile.user}"`);
  return user;
}

/** One problem per profile whose user is not there — for the loader to report before the first run. */
export function userProblems(
  users: readonly User[],
  profiles: readonly { readonly id: string; readonly user: string | null }[],
): string[] {
  return profiles.flatMap((profile) => {
    try {
      userOf(users, profile);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}
