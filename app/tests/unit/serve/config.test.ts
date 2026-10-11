import { describe, expect, it } from '@gjsify/unit';

import {
  DEFAULT_QUESTION_LIMITS,
  ServeConfigError,
  SERVE_CONFIG_SCHEMA,
  configHash,
  freeModelNotes,
  isFreeModel,
  parseServeConfig,
  type SchemaNode,
} from '@lotse/core';

import example from '../../../../examples/tasks.example.json' with { type: 'json' };

const VALID = {
  version: 1,
  users: [{ id: 'me' }],
  profiles: [{ id: 'work', user: 'me', data: 'private', model: 'provider/paid-model' }],
  tasks: [
    { id: 'inbox', profile: 'work', schedule: { every: '1h' }, prompt: 'Look at the inbox.', cwd: '/tmp' },
  ],
};

function problems(value: unknown): readonly string[] {
  try {
    parseServeConfig(JSON.stringify(value));
  } catch (error) {
    if (error instanceof ServeConfigError) return error.problems;
    throw error;
  }
  return [];
}

export default async () => {
  await describe('parseServeConfig', async () => {
    await it('reads a minimal file and fills the defaults', async () => {
      const config = parseServeConfig(JSON.stringify(VALID));
      const task = config.tasks[0]!;
      expect(task.rights).toBe('confirm');
      expect(task.notify).toBe('questions');
      expect(task.questions).toStrictEqual(DEFAULT_QUESTION_LIMITS);
      expect(task.mcpServers.length).toBe(0);
      expect(config.users[0]!.addresses.length).toBe(0);
    });

    await it('reads answerMcpServers and rejects a malformed one', async () => {
      const task = { ...VALID.tasks[0], answerMcpServers: [{ name: 'writing' }] };
      const config = parseServeConfig(JSON.stringify({ ...VALID, tasks: [task] }));
      expect(config.tasks[0]!.answerMcpServers?.length).toBe(1);
      expect(parseServeConfig(JSON.stringify(VALID)).tasks[0]!.answerMcpServers).toBe(null);
      const bad = { ...VALID.tasks[0], answerMcpServers: ['nope'] };
      expect(() => parseServeConfig(JSON.stringify({ ...VALID, tasks: [bad] }))).toThrow();
    });

    await it('reads the shipped example', async () => {
      const config = parseServeConfig(JSON.stringify(example));
      expect(config.tasks.map((task) => task.id)).toStrictEqual([
        'morning-summary',
        'watch-something-public',
      ]);
      expect(config.tasks[0]!.mcpServers.length).toBe(1);
    });

    await it('reads question limits', async () => {
      const config = parseServeConfig(
        JSON.stringify({
          ...VALID,
          tasks: [{ ...VALID.tasks[0], questions: { expiresIn: '30m', maxOpen: 1, maxPerHour: 2 } }],
        }),
      );
      expect(config.tasks[0]!.questions).toStrictEqual({ expiresMs: 1_800_000, maxOpen: 1, maxPerHour: 2 });
    });

    await it('lists every problem at once', async () => {
      const found = problems({
        version: 2,
        extra: true,
        users: [{ id: 'me' }],
        profiles: [{ id: 'p', user: 'nobody', data: 'public' }],
        tasks: [{ id: 't', profile: 'missing', schedule: { every: '10s' }, cwd: 'relative' }],
      });
      expect(found.some((line) => line.includes('"version"'))).toBe(true);
      expect(found.some((line) => line.includes('unknown key "extra"'))).toBe(true);
      expect(found.some((line) => line.includes('user "nobody"'))).toBe(true);
      expect(found.some((line) => line.includes('profile "missing"'))).toBe(true);
      expect(found.some((line) => line.includes('schedule'))).toBe(true);
      expect(found.some((line) => line.includes('"prompt" and "promptFile"'))).toBe(true);
      expect(found.some((line) => line.includes('cwd'))).toBe(true);
    });

    await it('any profile may leave the model out or name a free one', async () => {
      const unnamed = { ...VALID, profiles: [{ id: 'work', user: 'me', data: 'private' }] };
      expect(problems(unnamed).length).toBe(0);
      expect(parseServeConfig(JSON.stringify(unnamed)).profiles[0]!.model).toBe(null);
      const free = {
        ...VALID,
        profiles: [{ id: 'work', user: 'me', data: 'private', model: 'zen/some-free' }],
      };
      expect(problems(free).length).toBe(0);
      const notes = freeModelNotes(parseServeConfig(JSON.stringify(free)));
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain('zen/some-free');
      expect(freeModelNotes(parseServeConfig(JSON.stringify(VALID))).length).toBe(0);
    });

    await it('reads a precheck, with or without its own profile', async () => {
      const task = { ...VALID.tasks[0], precheck: { prompt: 'Anything new?' } };
      const config = parseServeConfig(JSON.stringify({ ...VALID, tasks: [task] }));
      expect(config.tasks[0]!.precheck).toStrictEqual({
        profile: null,
        prompt: 'Anything new?',
        promptFile: null,
      });
      expect(parseServeConfig(JSON.stringify(VALID)).tasks[0]!.precheck).toBe(null);
      const named = {
        ...VALID,
        profiles: [...VALID.profiles, { id: 'cheap', user: 'me', data: 'private' }],
        tasks: [{ ...VALID.tasks[0], precheck: { profile: 'cheap', promptFile: 'check.md' } }],
      };
      expect(parseServeConfig(JSON.stringify(named)).tasks[0]!.precheck?.profile).toBe('cheap');
    });

    await it('a precheck needs one prompt, a known profile and no stray keys', async () => {
      const found = problems({
        ...VALID,
        tasks: [{ ...VALID.tasks[0], precheck: { profile: 'ghost', extra: 1 } }],
      });
      expect(found.some((line) => line.includes('precheck needs exactly one'))).toBe(true);
      expect(found.some((line) => line.includes('precheck names profile "ghost"'))).toBe(true);
      expect(found.some((line) => line.includes('unknown key "extra"'))).toBe(true);
    });

    await it('a profile must say whether its data is private', async () => {
      const silent = { ...VALID, profiles: [{ id: 'work', user: 'me', model: 'provider/paid-model' }] };
      expect(problems(silent).some((line) => line.includes('there is no default'))).toBe(true);
    });

    await it('released areas need the released rights, and the other way round', async () => {
      const without = { ...VALID, tasks: [{ ...VALID.tasks[0], rights: 'released' }] };
      expect(problems(without).some((line) => line.includes('releases nothing'))).toBe(true);
      const stray = { ...VALID, tasks: [{ ...VALID.tasks[0], released: [{ tool: 'read' }] }] };
      expect(problems(stray).some((line) => line.includes('its rights are "confirm"'))).toBe(true);
    });

    await it('refuses text that is not JSON', async () => {
      expect(() => parseServeConfig('{')).toThrow();
    });
  });

  await describe('SERVE_CONFIG_SCHEMA', async () => {
    await it('gives every property a title and a description', async () => {
      const missing: string[] = [];
      const walk = (node: SchemaNode, path: string): void => {
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          if (!child.$ref && (!child.title || !child.description)) missing.push(`${path}.${key}`);
          walk(child, `${path}.${key}`);
        }
        if (node.items) walk(node.items, `${path}[]`);
        for (const [index, option] of (node.oneOf ?? []).entries()) walk(option, `${path}|${index}`);
      };
      walk(SERVE_CONFIG_SCHEMA, '');
      for (const [name, def] of Object.entries(SERVE_CONFIG_SCHEMA.$defs)) {
        if (!def.title || !def.description) missing.push(`$defs.${name}`);
        walk(def, `$defs.${name}`);
      }
      expect(missing).toStrictEqual([]);
    });
  });

  await describe('isFreeModel', async () => {
    await it('catches the -free suffix', async () => {
      expect(isFreeModel('anything/model-free')).toBe(true);
      expect(isFreeModel('provider/paid-model')).toBe(false);
    });
  });

  await describe('configHash', async () => {
    await it('changes with any text and with where the texts split', async () => {
      expect(configHash(['a', 'b'])).toBe(configHash(['a', 'b']));
      expect(configHash(['a', 'b'])).not.toBe(configHash(['a', 'c']));
      expect(configHash(['ab', ''])).not.toBe(configHash(['a', 'b']));
    });
  });
};
