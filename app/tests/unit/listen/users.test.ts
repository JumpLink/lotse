import { describe, expect, it } from '@gjsify/unit';

import {
  USERS_SCHEMA,
  UsersError,
  deliveryOf,
  freeModelNotes,
  isFreeModel,
  parseProfiles,
  parseUsers,
  unreachableProfileNotes,
  userOf,
  userProblems,
  type SchemaNode,
} from '@lotse/core';

import profilesExample from '../../../../examples/profiles.example.json' with { type: 'json' };
import usersExample from '../../../../examples/users.example.json' with { type: 'json' };

const USERS = { version: 1, users: [{ id: 'me', addresses: ['a@example.org'] }] };

function problems(value: unknown): readonly string[] {
  try {
    parseUsers(typeof value === 'string' ? value : JSON.stringify(value));
  } catch (error) {
    if (error instanceof UsersError) return error.problems;
    throw error;
  }
  return [];
}

const profiles = (list: Record<string, unknown>[]) =>
  parseProfiles(JSON.stringify({ version: 1, profiles: list }));

export default async () => {
  await describe('parseUsers', async () => {
    await it('reads a file and fills the addresses', async () => {
      expect(parseUsers(JSON.stringify(USERS))[0]!.addresses).toStrictEqual(['a@example.org']);
      expect(parseUsers(JSON.stringify({ version: 1, users: [{ id: 'me' }] }))[0]!.addresses.length).toBe(0);
    });

    await it('reads the shipped examples', async () => {
      const users = parseUsers(JSON.stringify(usersExample));
      const found = parseProfiles(JSON.stringify(profilesExample));
      expect(users.length > 0).toBe(true);
      expect(userProblems(users, found)).toStrictEqual([]);
    });

    await it('lists every problem at once', async () => {
      const found = problems({
        version: 2,
        extra: true,
        users: [{ id: 'me' }, { id: 'me' }, { id: 'Bad Id' }],
      });
      expect(found.some((line) => line.includes('"version"'))).toBe(true);
      expect(found.some((line) => line.includes('unknown key "extra"'))).toBe(true);
      expect(found.length >= 4).toBe(true);
    });

    await it('refuses text that is not JSON', async () => {
      expect(problems('{').length).toBe(1);
    });
  });

  await describe('userOf', async () => {
    const users = parseUsers(JSON.stringify(USERS));

    await it('a profile names its user, or takes the only one', async () => {
      expect(userOf(users, { id: 'p', user: 'me' }).id).toBe('me');
      expect(userOf(users, { id: 'p', user: null }).id).toBe('me');
    });

    await it('an unknown user, or no user among several, is a problem', async () => {
      expect(userProblems(users, [{ id: 'p', user: 'nobody' }]).length).toBe(1);
      const two = parseUsers(JSON.stringify({ version: 1, users: [{ id: 'a' }, { id: 'b' }] }));
      expect(userProblems(two, [{ id: 'p', user: null }]).length).toBe(1);
    });
  });

  await describe('profile delivery', async () => {
    await it('defaults to every channel, in full', async () => {
      const found = profiles([{ id: 'p', data: 'public' }]);
      expect(deliveryOf(found, 'p')).toStrictEqual({ channels: null, messengerDetail: 'full' });
      expect(deliveryOf(found, 'unknown')).toStrictEqual({ channels: null, messengerDetail: 'full' });
    });

    await it('a profile narrows its channels and the detail', async () => {
      const found = profiles([{ id: 'p', data: 'public', channels: ['desktop'], messengerDetail: 'notice' }]);
      expect(deliveryOf(found, 'p')).toStrictEqual({ channels: ['desktop'], messengerDetail: 'notice' });
      expect(unreachableProfileNotes(found, ['messenger']).length).toBe(1);
      expect(unreachableProfileNotes(found, ['desktop'])).toStrictEqual([]);
    });

    await it('any profile may leave the model out or name a free one', async () => {
      const free = profiles([{ id: 'w', data: 'private', model: 'zen/some-free' }]);
      const notes = freeModelNotes(free);
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain('zen/some-free');
      expect(freeModelNotes(profiles([{ id: 'w', data: 'private' }])).length).toBe(0);
    });

    await it('isFreeModel catches the -free suffix', async () => {
      expect(isFreeModel('anything/model-free')).toBe(true);
      expect(isFreeModel('provider/paid-model')).toBe(false);
    });
  });

  await describe('USERS_SCHEMA', async () => {
    await it('gives every property a title and a description', async () => {
      const missing: string[] = [];
      const walk = (node: SchemaNode, path: string): void => {
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          if (!child.$ref && (!child.title || !child.description)) missing.push(`${path}.${key}`);
          walk(child, `${path}.${key}`);
        }
        if (node.items) walk(node.items, `${path}[]`);
      };
      walk(USERS_SCHEMA, '');
      for (const [name, def] of Object.entries(USERS_SCHEMA.$defs)) {
        const node = def as SchemaNode;
        if (!node.title || !node.description) missing.push(`$defs.${name}`);
        walk(node, `$defs.${name}`);
      }
      expect(missing).toStrictEqual([]);
    });
  });
};
