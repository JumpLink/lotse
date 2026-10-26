import { describe, expect, it } from '@gjsify/unit';

import { readFileSync } from 'node:fs';

import { runMain, type MainHost } from '../../../src/core/main.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function host(withLoop: boolean, code?: number) {
  const calls = { run: 0, exits: [] as (number | undefined)[], reported: [] as unknown[] };
  const h: MainHost = {
    loop: withLoop ? { run: () => void calls.run++ } : null,
    exit: (c) => void calls.exits.push(c),
    report: (e) => void calls.reported.push(e),
    exitCode: () => code,
  };
  return { h, calls };
}

export default async () => {
  await describe('runMain', async () => {
    await it('runs the loop while the command is still pending', async () => {
      const { h, calls } = host(true);
      runMain(new Promise(() => {}), h);
      expect(calls.run).toBe(1);
      expect(calls.exits.length).toBe(0);
    });

    await it('exits 0 on GJS once the command resolves', async () => {
      const { h, calls } = host(true);
      runMain(Promise.resolve(), h);
      await tick();
      expect(calls.exits).toStrictEqual([0]);
    });

    await it('keeps a preset exit code', async () => {
      const { h, calls } = host(true, 3);
      runMain(Promise.resolve(), h);
      await tick();
      expect(calls.exits).toStrictEqual([3]);
    });

    await it('leaves the natural end alone on Node', async () => {
      const { h, calls } = host(false);
      runMain(Promise.resolve(), h);
      await tick();
      expect(calls.run).toBe(0);
      expect(calls.exits.length).toBe(0);
    });

    await it('reports a failure and exits non-zero', async () => {
      const { h, calls } = host(true);
      const boom = new Error('boom');
      runMain(Promise.reject(boom), h);
      await tick();
      expect(calls.reported).toStrictEqual([boom]);
      expect(calls.exits).toStrictEqual([1]);
    });
  });

  await describe('entry point', async () => {
    await it('has no top-level await (it makes GJS spin a core while idle)', async () => {
      const src = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
      // The command's promise must be driven by `runMain`, never awaited by the module itself.
      expect(/^\s*await\s+parsed\b/m.test(src)).toBe(false);
      expect(src).toContain('runMain(parsed');
    });
  });
};
