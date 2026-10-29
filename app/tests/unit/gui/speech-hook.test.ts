/**
 * `frontends/gui/speech-hook.ts` — what `LOTSE_APP_SPEECH` stands in for.
 *
 * **The off case is the one that matters**, for `model-policy-hook.test.ts`'s reason: every ordinary
 * run takes it, and `undefined` is what makes `LotseChat` offer no Conversation toggle at all. An
 * engine that merely exists and says nothing would show the toggle in a window with no speech.
 *
 * The second case pins the promise the file's name makes: the stand-in records and prints, and there
 * is no path from it to a real engine. A test run must never talk out loud.
 *
 * Both runtimes, no display: the widget import is a type-only one, so nothing drags `Gtk` in.
 */
import { describe, expect, it } from '@gjsify/unit';

import { SilentSynthesis, speechFromHook } from '../../../src/frontends/gui/speech-hook.ts';

export default async function run(): Promise<void> {
  await describe('the speech hook as an engine', async () => {
    await it('is no engine at all when the flag is off', async () => {
      expect(speechFromHook(false)).toBe(undefined);
    });

    await it('builds a silent engine that records what it was asked to say', async () => {
      const engine = speechFromHook(true);
      expect(engine).not.toBe(undefined);
      const synthesis = engine?.synthesis as SilentSynthesis;
      expect(synthesis instanceof SilentSynthesis).toBe(true);

      synthesis.speak(engine!.utterance('Erster Satz.'));
      synthesis.speak(engine!.utterance('Zweiter Satz.'));
      // `toEqual` compares with `==`, which is no use on arrays — `read-aloud.test.ts` does the same.
      expect(JSON.stringify(synthesis.spoken)).toBe(JSON.stringify(['Erster Satz.', 'Zweiter Satz.']));
      expect(synthesis.speaking).toBe(true);

      synthesis.cancel();
      expect(synthesis.speaking).toBe(false);
    });
  });
}
