import { describe, expect, it } from '@gjsify/unit';

import {
  OPENCODE_COMMAND,
  PROFILES_SCHEMA,
  ProfilesError,
  jobOptionsOf,
  narrowRights,
  parseProfiles,
  parseServeConfig,
  profileFromServe,
  profilesFromTasks,
  resolveProfile,
  withPreamble,
  type SchemaNode,
} from '@lotse/core';

const AGENT = OPENCODE_COMMAND;

const FILE = {
  version: 1,
  profiles: [
    {
      id: 'work',
      agent: 'opencode',
      model: 'provider/model',
      configOptions: { thought_level: 'high', plan: true },
      mcpServers: [{ name: 'notes', command: 'notes-mcp', args: [], env: [] }],
      preamble: '  Answer briefly.  ',
      rights: 'confirm',
      data: 'private',
    },
    { id: 'plain', data: 'public' },
  ],
};

function problems(value: unknown): readonly string[] {
  try {
    parseProfiles(typeof value === 'string' ? value : JSON.stringify(value));
  } catch (error) {
    if (error instanceof ProfilesError) return error.problems;
    throw error;
  }
  return [];
}

export default async () => {
  await describe('parseProfiles', async () => {
    await it('reads every field and fills the defaults', async () => {
      const [work, plain] = parseProfiles(JSON.stringify(FILE));
      expect(work!.model).toBe('provider/model');
      expect(work!.configOptions['plan']).toBe(true);
      expect(work!.mcpServers.length).toBe(1);
      expect(work!.rights).toBe('confirm');
      expect(plain!.agent).toBeNull();
      expect(plain!.model).toBeNull();
      expect(plain!.preamble).toBeNull();
      expect(plain!.rights).toBeNull();
      expect(plain!.mcpServers.length).toBe(0);
      expect(Object.keys(plain!.configOptions).length).toBe(0);
    });

    await it('lists every problem at once', async () => {
      const found = problems({
        version: 2,
        extra: 1,
        profiles: [
          { id: 'a' },
          { id: 'b', data: 'public', rights: 'all', configOptions: { x: '' }, mcpServers: [{}] },
          { id: 'b', data: 'public' },
        ],
      });
      expect(found.length >= 6).toBe(true);
      expect(found.some((line) => line.includes('"version"'))).toBe(true);
      expect(found.some((line) => line.includes('unknown key "extra"'))).toBe(true);
      expect(found.some((line) => line.includes('there is no default'))).toBe(true);
      expect(found.some((line) => line.includes('is defined twice'))).toBe(true);
    });

    await it('refuses an unknown key in a profile and text that is not JSON', async () => {
      expect(problems({ version: 1, profiles: [{ id: 'a', data: 'public', colour: 'red' }] }).length).toBe(1);
      expect(problems('{').length).toBe(1);
    });
  });

  await describe('PROFILES_SCHEMA', async () => {
    await it('gives every property a title and a description', async () => {
      const missing: string[] = [];
      const walk = (node: SchemaNode, path: string): void => {
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          if (!child.$ref && (!child.title || !child.description)) missing.push(`${path}.${key}`);
          walk(child, `${path}.${key}`);
        }
        if (node.items) walk(node.items, `${path}[]`);
      };
      walk(PROFILES_SCHEMA, '');
      for (const [name, def] of Object.entries(PROFILES_SCHEMA.$defs)) {
        if (!def.title || !def.description) missing.push(`$defs.${name}`);
        walk(def, `$defs.${name}`);
      }
      expect(missing).toStrictEqual([]);
    });
  });

  await describe('profilesFromTasks', async () => {
    const tasks = {
      version: 1,
      users: [{ id: 'me' }],
      profiles: [
        { id: 'work', user: 'me', agent: 'opencode', model: 'provider/model', data: 'private', channels: [] },
        { id: 'work', user: 'me', data: 'public' },
        { id: 'broken', user: 'me' },
        { id: 'open', user: 'me', data: 'public' },
      ],
      tasks: [],
    };

    await it('carries over agent, model and data of the valid, first entries only', async () => {
      const text = profilesFromTasks(JSON.stringify(tasks))!;
      const profiles = parseProfiles(text);
      expect(profiles.map((profile) => profile.id)).toStrictEqual(['work', 'open']);
      expect(profiles[0]!.agent).toBe('opencode');
      expect(profiles[0]!.model).toBe('provider/model');
      expect(profiles[0]!.data).toBe('private');
      expect(text.includes('"user"')).toBe(false);
    });

    await it('returns null when there is nothing to carry over', async () => {
      expect(profilesFromTasks('{')).toBeNull();
      expect(profilesFromTasks('{"version":1}')).toBeNull();
      expect(profilesFromTasks(JSON.stringify({ profiles: [{ id: 'x' }] }))).toBeNull();
    });
  });

  await describe('resolveProfile', async () => {
    const [work, plain] = parseProfiles(JSON.stringify(FILE));

    await it('hands the launcher id to the host and trims the preamble', async () => {
      const asked: (string | null)[] = [];
      const session = resolveProfile(work!, {
        agent: (launcher) => {
          asked.push(launcher);
          return AGENT;
        },
      });
      expect(asked).toStrictEqual(['opencode']);
      expect(session.command).toBe(AGENT);
      expect(session.preamble).toBe('Answer briefly.');
      expect(session.rights).toBe('confirm');
      expect(session.profile).toBe('work');
    });

    await it('asks for the default agent when the profile names none', async () => {
      const asked: (string | null)[] = [];
      resolveProfile(plain!, {
        agent: (launcher) => {
          asked.push(launcher);
          return AGENT;
        },
      });
      expect(asked).toStrictEqual([null]);
    });

    await it('turns into runJob options without the preamble', async () => {
      const options = jobOptionsOf(resolveProfile(work!, { agent: () => AGENT }));
      expect(options.model).toBe('provider/model');
      expect(options.mcpServers.length).toBe(1);
      expect('model' in jobOptionsOf(resolveProfile(plain!, { agent: () => AGENT }))).toBe(false);
    });

    await it('puts the preamble in front of a prompt', async () => {
      expect(withPreamble('Be brief.', 'Hello')).toBe('Be brief.\n\nHello');
      expect(withPreamble(null, 'Hello')).toBe('Hello');
      expect(withPreamble('  ', 'Hello')).toBe('Hello');
    });
  });

  await describe('narrowRights', async () => {
    await it('takes the lower of the two', async () => {
      expect(narrowRights('released', 'confirm')).toBe('confirm');
      expect(narrowRights('read', 'released')).toBe('read');
      expect(narrowRights('confirm', null)).toBe('confirm');
    });
  });

  await describe('parseServeConfig with shared profiles', async () => {
    const tasks = {
      version: 1,
      users: [{ id: 'me' }],
      profiles: [
        { id: 'work', user: 'me', model: 'ignored/model' },
        { id: 'legacy', user: 'me', data: 'private' },
      ],
      tasks: [{ id: 'inbox', profile: 'work', prompt: 'Look.', cwd: '/tmp' }],
    };

    await it('lets the shared profile win and makes data optional', async () => {
      const config = parseServeConfig(JSON.stringify(tasks), {
        profiles: parseProfiles(JSON.stringify(FILE)),
      });
      const work = config.profiles.find((profile) => profile.id === 'work')!;
      expect(work.model).toBe('provider/model');
      expect(work.agent).toBe('opencode');
      expect(work.base?.id).toBe('work');
      expect(profileFromServe(work).mcpServers.length).toBe(1);
      expect(config.profiles.find((profile) => profile.id === 'legacy')!.base).toBeUndefined();
    });

    await it('still demands data without a shared profile', async () => {
      expect(() => parseServeConfig(JSON.stringify(tasks))).toThrow();
    });
  });
};
