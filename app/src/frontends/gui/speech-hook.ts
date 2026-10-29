/**
 * What `LOTSE_APP_SPEECH` stands in for — a `speechSynthesis`-shaped object that **never makes a
 * sound**.
 *
 * `LotseChat` takes an optional `speech` engine from its host (`packages/widget/src/chat.ts`), and
 * lotse's own window passes none: the app ships no speech engine, so the Conversation toggle is not
 * offered there. Without a stand-in, the toggle and the sentences it would speak are the only part
 * of the composer that is written, tested on both runtimes, and never once seen — the same reason
 * `model-policy-hook.ts` exists next door.
 *
 * **Silent on purpose, and the only engine any test or screenshot run may use.** It records what it
 * was asked to say and prints each line, so a headless run shows the sentence boundaries the
 * chunker found, in order. A real engine in a test run would talk out loud on the workstation.
 */

import type { SpeechEngine, SpeechSynthesisLike, SpeechUtteranceLike } from '@lotse/widget';

/** What a run asked for, in the order it asked. Readable after the run, for a smoke check. */
export class SilentSynthesis implements SpeechSynthesisLike {
  readonly spoken: string[] = [];
  #speaking = false;

  get speaking(): boolean {
    return this.#speaking;
  }

  speak(utterance: SpeechUtteranceLike): void {
    this.spoken.push(utterance.text);
    this.#speaking = true;
    console.log(`lotse: would speak — ${utterance.text}`);
  }

  cancel(): void {
    this.#speaking = false;
    console.log('lotse: would stop speaking');
  }
}

/** The hook's flag as an engine, or `undefined` for a window with no speech at all. */
export function speechFromHook(on: boolean): SpeechEngine | undefined {
  if (!on) return undefined;
  const synthesis = new SilentSynthesis();
  return { synthesis, utterance: (text: string) => ({ text }) };
}
