/**
 * Reading a streamed agent reply aloud, sentence by sentence (ADR 0010, stage 1).
 *
 * The engine is the host's: a minimal structural type shaped like the W3C `speechSynthesis`, so a
 * browser passes `window.speechSynthesis`, a GNOME app passes `@gjsify/speech-synthesis`, and a test
 * passes a fake that records what it was told to say. Core imports none of the three.
 *
 * ```ts
 * const aloud = readAloud({ engine: { synthesis, utterance: (text) => new SpeechSynthesisUtterance(text) } });
 * aloud.setEnabled(true);
 * for await (const delta of agentMessageChunks) aloud.feed(delta);
 * aloud.end();
 * ```
 *
 * **No queue of its own.** `speak()` appends to the engine's queue and `cancel()` empties it, so
 * stopping is `cancel()` plus a fresh chunker — which also drops the half-built sentence that has not
 * been spoken yet. Nothing here waits for an utterance to finish; the engine keeps the order.
 *
 * **`off` is the only policy this can enforce.** `readAloudOffered` hides the feature when the
 * effective `voice` policy says `off`. Whether a given engine is local or cloud cannot be read off a
 * `speechSynthesis`-shaped object, so `local-only` is the host's promise when it picks the engine, not
 * a check made here.
 *
 * Pure and platform-free like `speakable.ts` and `sentence-chunker.ts`, whose cleaning it inherits:
 * the chunker already drops code blocks and tables, so what reaches `speak()` is what a person would
 * say.
 */

import { sentenceChunker, type SentenceChunker, type SentenceChunkerOptions } from './sentence-chunker.ts';
import type { VoicePolicy } from './voice-policy.ts';

/** The part of `SpeechSynthesisUtterance` this needs: the text that will be spoken. */
export interface SpeechUtteranceLike {
  readonly text: string;
}

/** The part of `speechSynthesis` this needs. `speak` queues, `cancel` empties the queue. */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  readonly speaking: boolean;
}

/**
 * A host's speech engine: the synthesiser plus a way to make an utterance for it.
 *
 * The factory exists because `SpeechSynthesisUtterance` is a class and a class cannot be called
 * without `new`. One line on the host's side — `(text) => new SpeechSynthesisUtterance(text)` — and
 * core needs no runtime branch over how the utterance is built.
 */
export interface SpeechEngine {
  readonly synthesis: SpeechSynthesisLike;
  readonly utterance: (text: string) => SpeechUtteranceLike;
}

export interface ReadAloudOptions extends SentenceChunkerOptions {
  readonly engine: SpeechEngine;
  /** An engine failure, in the host's own words. Like `AgentSessionEvents.onNotice`. */
  onNotice?: (message: string) => void;
}

/**
 * Whether a surface may offer reading aloud at all: it needs an engine, and the effective `voice`
 * policy must not be `off`. `null` is no limit, so it offers.
 */
export function readAloudOffered(
  engine: SpeechEngine | null | undefined,
  voice: VoicePolicy | null,
): engine is SpeechEngine {
  return engine != null && voice !== 'off';
}

export class ReadAloud {
  readonly #opts: ReadAloudOptions;
  readonly #engine: SpeechEngine;
  #chunker: SentenceChunker;
  #enabled = false;
  /** Something of ours may still be in the engine's queue, so `stop()` has a reason to cancel. */
  #spoken = false;

  constructor(opts: ReadAloudOptions) {
    this.#opts = opts;
    this.#engine = opts.engine;
    this.#chunker = sentenceChunker(opts);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** The engine's own answer: whether an utterance is being spoken right now. */
  get speaking(): boolean {
    return this.#engine.synthesis.speaking;
  }

  /** Turning it off stops what is playing; turning it on starts with the next `feed`. */
  setEnabled(on: boolean): void {
    if (on === this.#enabled) return;
    this.#enabled = on;
    if (!on) this.stop();
  }

  /** Streamed Markdown from the agent. Each sentence goes to the engine as soon as it is complete. */
  feed(markdown: string): void {
    if (!this.#enabled) return;
    this.#say(this.#chunker.feed(markdown));
  }

  /** The reply is over: speak the tail that has no sentence end of its own. */
  end(): void {
    if (!this.#enabled) return;
    this.#say(this.#chunker.flush());
  }

  /**
   * Silence now: empty the engine's queue and drop the sentence being built.
   *
   * **`cancel()` is not gated on `speaking`** — per spec that is false while utterances are merely
   * pending, so gating it would leave the queue to play on. It is gated on having spoken something,
   * because the engine may be the host's and shared, and cancelling speech we never started is not
   * ours to do.
   */
  stop(): void {
    this.#chunker = sentenceChunker(this.#opts);
    if (!this.#spoken) return;
    this.#spoken = false;
    try {
      this.#engine.synthesis.cancel();
    } catch (error) {
      this.#opts.onNotice?.(`reading aloud could not be stopped: ${describe(error)}`);
    }
  }

  /** A failing engine switches the feature off rather than throwing into the caller's event handler. */
  #say(sentences: readonly string[]): void {
    for (const sentence of sentences) {
      try {
        this.#engine.synthesis.speak(this.#engine.utterance(sentence));
        this.#spoken = true;
      } catch (error) {
        this.#enabled = false;
        this.#chunker = sentenceChunker(this.#opts);
        this.#opts.onNotice?.(`reading aloud is off: the speech engine failed (${describe(error)})`);
        return;
      }
    }
  }
}

/** A driver for one conversation. `setEnabled` to arm it; see the file comment. */
export function readAloud(opts: ReadAloudOptions): ReadAloud {
  return new ReadAloud(opts);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
