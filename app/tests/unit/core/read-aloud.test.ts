/**
 * The read-aloud driver against a **fake** speech engine — which is the order ADR 0009 chose: "core
 * and widget do not [wait for a gjsify release]: they are built and merged against a fake first".
 *
 * Nothing here may make a sound: the fake records the texts it was told to speak and the times it was
 * cancelled, which is the whole of what the driver decides. A real engine in a test would be audible
 * on the machine running it.
 */

import { describe, expect, it } from '@gjsify/unit';

import { readAloud, readAloudOffered, type SpeechEngine, type SpeechUtteranceLike } from '@lotse/core';

/** `toEqual` compares with `==`, which is no use on arrays. */
function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

interface Fake extends SpeechEngine {
  /** Every text handed to `speak`, in order, including the ones a later `cancel` threw away. */
  readonly spoken: string[];
  readonly cancels: () => number;
}

function fakeEngine(onSpeak?: (text: string) => void): Fake {
  const spoken: string[] = [];
  let cancels = 0;
  let speaking = false;
  return {
    spoken,
    cancels: () => cancels,
    utterance: (text: string): SpeechUtteranceLike => ({ text }),
    synthesis: {
      speak(utterance: SpeechUtteranceLike): void {
        onSpeak?.(utterance.text);
        spoken.push(utterance.text);
        speaking = true;
      },
      cancel(): void {
        cancels++;
        speaking = false;
      },
      get speaking(): boolean {
        return speaking;
      },
    },
  };
}

const REPLY = 'Die Rechnung ist am 15. März 2026 fällig. Ich habe sie geprüft. Alles gut.';

export default async () => {
  await describe('readAloudOffered', async () => {
    await it('needs an engine: no speech option, no toggle', async () => {
      expect(readAloudOffered(undefined, 'any')).toBe(false);
      expect(readAloudOffered(null, null)).toBe(false);
    });

    await it('is refused by the voice policy "off"', async () => {
      expect(readAloudOffered(fakeEngine(), 'off')).toBe(false);
    });

    await it('offers for any, local-only, and no limit at all', async () => {
      for (const voice of ['any', 'local-only', null] as const) {
        expect(readAloudOffered(fakeEngine(), voice)).toBe(true);
      }
    });
  });

  await describe('ReadAloud', async () => {
    await it('says nothing until it is enabled', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      expect(aloud.enabled).toBe(false);
      aloud.feed(REPLY);
      aloud.end();
      same(engine.spoken, []);
    });

    await it('speaks each sentence in order, while the reply is still streaming', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.setEnabled(true);
      aloud.feed('Die Rechnung ist am 15. März 2026 fällig. Ich habe');
      // Spoken before the turn ended, and only the sentence that is complete.
      same(engine.spoken, ['Die Rechnung ist am 15. März 2026 fällig.']);
      aloud.feed(' sie geprüft. Alles gut');
      same(engine.spoken, ['Die Rechnung ist am 15. März 2026 fällig.', 'Ich habe sie geprüft.']);
      aloud.end();
      same(engine.spoken, [
        'Die Rechnung ist am 15. März 2026 fällig.',
        'Ich habe sie geprüft.',
        'Alles gut.',
      ]);
    });

    await it('speaks the same sentences however the stream is cut', async () => {
      for (const size of [1, 3, 11, 1000]) {
        const engine = fakeEngine();
        const aloud = readAloud({ engine });
        aloud.setEnabled(true);
        for (let i = 0; i < REPLY.length; i += size) aloud.feed(REPLY.slice(i, i + size));
        aloud.end();
        same(engine.spoken, [
          'Die Rechnung ist am 15. März 2026 fällig.',
          'Ich habe sie geprüft.',
          'Alles gut.',
        ]);
      }
    });

    await it('does not read code aloud', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.setEnabled(true);
      aloud.feed('So geht es:\n\n```sh\nrm -rf x\n```\n\nFertig.\n');
      aloud.end();
      same(engine.spoken, ['So geht es:', 'Fertig.']);
    });

    await it('stop() empties the queue and drops the half-built sentence', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.setEnabled(true);
      aloud.feed('Erster Satz. Der zweite ist noch nicht');
      same(engine.spoken, ['Erster Satz.']);
      aloud.stop();
      expect(engine.cancels()).toBe(1);
      aloud.end();
      // The unfinished sentence is gone, not spoken late.
      same(engine.spoken, ['Erster Satz.']);
      expect(aloud.enabled).toBe(true);
    });

    await it('starts the next reply clean after a stop', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.setEnabled(true);
      aloud.feed('Abgebrochen mitten im');
      aloud.stop();
      // Not prefixed by the fragment, and the chunker's own state is fresh.
      aloud.feed('Neuer Satz. Und weiter');
      same(engine.spoken, ['Neuer Satz.']);
    });

    await it('turning the toggle off stops what is playing', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.setEnabled(true);
      aloud.feed('Ein Satz. ');
      aloud.setEnabled(false);
      expect(aloud.enabled).toBe(false);
      expect(engine.cancels()).toBe(1);
      aloud.feed('Noch ein Satz. ');
      same(engine.spoken, ['Ein Satz.']);
    });

    await it('leaves a shared engine alone when it has spoken nothing', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      aloud.stop();
      aloud.setEnabled(true);
      aloud.stop();
      expect(engine.cancels()).toBe(0);
    });

    await it('reports the engine it is speaking through', async () => {
      const engine = fakeEngine();
      const aloud = readAloud({ engine });
      expect(aloud.speaking).toBe(false);
      aloud.setEnabled(true);
      aloud.feed('Ein Satz. ');
      expect(aloud.speaking).toBe(true);
      aloud.stop();
      expect(aloud.speaking).toBe(false);
    });

    await it('switches itself off and notices when the engine throws', async () => {
      const notices: string[] = [];
      const engine = fakeEngine((text) => {
        if (text.startsWith('Zweiter')) throw new Error('no voice installed');
      });
      const aloud = readAloud({ engine, onNotice: (message) => notices.push(message) });
      aloud.setEnabled(true);
      aloud.feed('Erster Satz. Zweiter Satz. Dritter Satz. ');
      expect(aloud.enabled).toBe(false);
      same(engine.spoken, ['Erster Satz.']);
      expect(notices.length).toBe(1);
      expect(notices[0]!.includes('no voice installed')).toBe(true);
    });
  });
};
