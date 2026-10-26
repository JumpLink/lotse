import { describe, expect, it } from '@gjsify/unit';

import {
  REQUEST_DEFAULTS,
  localTime,
  parseRunArgs,
  setLibraryTranslator,
  type LibraryTranslator,
  type RequestSettings,
} from '@lotse/core';

import { STRINGS, msg } from '../../../../packages/core/src/messenger/strings.ts';
import { setAppTranslator } from '../../../src/i18n.ts';
import { createRequestsHolder } from '../../../src/frontends/cli/chat-requests.ts';
import { statusText, type StatusReport } from '../../../src/frontends/cli/task-commands.ts';
import type { RunRecord } from '../../../src/core/run-state.ts';

/** Marks every string it translates, so a sentence that bypasses gettext shows. */
const MARKED: LibraryTranslator = Object.assign((msgid: string) => `«${msgid}»`, {
  plural: (singular: string, plural: string, n: number) => `«${n === 1 ? singular : plural}»`,
  context: (_context: string, msgid: string) => `«${msgid}»`,
});

async function marked<T>(body: () => Promise<T> | T): Promise<T> {
  setLibraryTranslator(MARKED);
  setAppTranslator(MARKED);
  try {
    return await body();
  } finally {
    setLibraryTranslator(null);
    setAppTranslator(null);
  }
}

const run = (endedAt: string, outcome: RunRecord['outcome'] = 'done'): RunRecord => ({
  startedAt: endedAt,
  endedAt,
  outcome,
  sessionId: null,
  stopReason: null,
  questionId: null,
  reason: null,
});

const report = (recent: Record<string, RunRecord>): StatusReport => ({ running: [], recent, questions: [] });

export default async () => {
  await describe('chat replies go through gettext', async () => {
    await it('the /run usage error is translated', async () => {
      const message = await marked(() => {
        try {
          parseRunArgs('');
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      });
      expect(message).toBe('«say which task to run, like: /run <task> name=value»');
    });

    await it('the messenger sentences are translated and keep their placeholders', async () => {
      const text = await marked(() => msg(STRINGS.gotIt, { id: '#A3' }));
      expect(text).toBe('«Got it, #A3.»');
    });

    await it('the request reload lines are translated', async () => {
      const settings: RequestSettings = { ...REQUEST_DEFAULTS, enabled: true, profile: 'p' };
      const holder = createRequestsHolder({
        read: () => settings,
        profiles: () => ['p'],
        build: (built) => ({ prefix: built.prefix, submit: () => {}, idle: async () => {} }),
      });
      const change = await marked(() => holder.check());
      expect(change.kind).toBe('changed');
      expect('line' in change ? change.line : '').toContain('«chat requests on: ');
    });

    await it('/status words the run states', async () => {
      const text = await marked(() =>
        statusText(report({ a: run('2026-10-15T16:10:00.000Z', 'asked') }), { locale: 'en-GB' }),
      );
      expect(text).toContain('«waiting for you»');
      expect(text).not.toContain('asked');
    });
  });

  await describe('/status times and list', async () => {
    await it('shows a run on the local clock, not as ISO', async () => {
      expect(localTime('2026-10-15T16:10:00.000Z', 'de-DE')).toMatch(/^\d{1,2}\.\d{1,2}\.,? \d{2}:\d{2}$/);
      expect(localTime('not a time')).toBe('not a time');
      const text = statusText(report({ a: run('2026-10-15T16:10:00.000Z') }), { locale: 'de-DE' });
      expect(text).not.toContain('2026-10-15T');
      expect(text).not.toContain('done at 2026');
    });

    await it('lists only the latest ten runs and leaves out tasks that are gone', async () => {
      const recent: Record<string, RunRecord> = {};
      for (let n = 1; n <= 12; n++)
        recent[`t${n}`] = run(`2026-10-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`);
      const lines = statusText(report(recent)).split('\n');
      expect(lines.length).toBe(11);
      expect(lines[1]).toContain('t12:');
      expect(lines.join('\n')).not.toContain('t2:');

      const known = new Set(['t12', 't3']);
      const kept = statusText(report(recent), { known }).split('\n');
      expect(kept.length).toBe(3);
      expect(kept.join('\n')).not.toContain('t11');
    });
  });
};
