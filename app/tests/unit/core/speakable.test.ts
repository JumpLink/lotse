/**
 * What a TTS is given of a reply: `speakableText` for a finished one, `sentenceChunker` for a stream.
 * German samples on purpose — the abbreviations and number formats are where a naive splitter breaks.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  isVoicePolicy,
  narrowVoice,
  parseProfiles,
  sentenceChunker,
  speakableText,
  type VoicePolicy,
} from '@lotse/core';

/** `toEqual` compares with `==`, which is no use on arrays. */
function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const SAMPLES = [
  'Die Rechnung über 1.234,56 Euro ist am 15. März 2026 fällig.',
  'Das kostet ca. 12 % mehr, z. B. wegen der MwSt.',
  'Ich habe PR #107 geprüft: zwei Kommentare.',
  'Die Datei liegt unter docs/voice/hoervergleich.md, Version 0.5.1.',
];

/** The text in pieces of `size` characters, the way a stream delivers it. */
function streamed(text: string, size: number, opts?: Parameters<typeof sentenceChunker>[0]): string[] {
  const chunker = sentenceChunker(opts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...chunker.feed(text.slice(i, i + size)));
  out.push(...chunker.flush());
  return out;
}

const MARKDOWN = [
  '# Ergebnis',
  '',
  'Das ist **wichtig** und siehe [die Doku](https://example.org/doku) oder https://example.org/x. 🎉',
  '',
  '- erster Punkt',
  '- zweiter Punkt',
  '',
  '```ts',
  'const a = 1. 2;',
  '```',
  '',
  'Danach geht es weiter.',
].join('\n');

export default async () => {
  await describe('speakableText', async () => {
    await it('keeps plain German sentences untouched', async () => {
      for (const sample of SAMPLES) expect(speakableText(sample)).toBe(sample);
    });

    await it('turns Markdown into readable sentences', async () => {
      expect(speakableText(MARKDOWN)).toBe(
        [
          'Ergebnis.',
          'Das ist wichtig und siehe die Doku oder.',
          'erster Punkt.',
          'zweiter Punkt.',
          'Danach geht es weiter.',
        ].join('\n'),
      );
    });

    await it('drops code, or replaces it by the placeholder it is given', async () => {
      const text = 'Vorher.\n\n```sh\nrm -rf x\n```\n\nNachher.';
      expect(speakableText(text)).toBe('Vorher.\nNachher.');
      expect(speakableText(text, { codePlaceholder: 'Code ausgelassen' })).toBe(
        'Vorher.\nCode ausgelassen.\nNachher.',
      );
      expect(speakableText('Text.\n\n    indented()\n    more()\n\nEnde.')).toBe('Text.\nEnde.');
    });

    await it('drops the tool lines the transcript writes', async () => {
      const text = 'Ich lese die Datei.\nRead docs/a.md — completed\n— failed\nFertig.';
      expect(speakableText(text)).toBe('Ich lese die Datei.\nFertig.');
      expect(speakableText('Read a — completed', { keepToolLines: true })).toBe('Read a — completed.');
    });

    await it('reads a table row as its cells', async () => {
      expect(speakableText('| Name | Preis |\n|---|---|\n| Brot | 3 € |')).toBe('Name, Preis.\nBrot, 3 €.');
    });
  });

  await describe('sentenceChunker', async () => {
    await it('does not split inside a sample sentence, at any chunk size', async () => {
      for (const sample of SAMPLES) {
        for (const size of [1, 3, 7, 1000]) expect(streamed(sample, size).join('|')).toBe(sample);
      }
    });

    await it('splits several sentences and holds the unfinished one back', async () => {
      const chunker = sentenceChunker();
      same(chunker.feed('Erster Satz. Zweiter'), ['Erster Satz.']);
      same(chunker.feed(' Satz! Dritter'), ['Zweiter Satz!']);
      same(chunker.flush(), ['Dritter.']);
    });

    await it('waits for the word after a period before it believes it', async () => {
      const chunker = sentenceChunker();
      same(chunker.feed('Es kostet 1.'), []);
      same(chunker.feed('234 Euro. Gut.'), ['Es kostet 1.234 Euro.']);
    });

    await it('gives the same sentences for a stream as for the whole text', async () => {
      const all = SAMPLES.join(' ');
      for (const size of [1, 2, 5, 13]) same(streamed(all, size), SAMPLES);
    });

    await it('never speaks from inside an unfinished code fence', async () => {
      const chunker = sentenceChunker();
      same(chunker.feed('Vorher. Dann:\n```ts\nconst x = 1. Und'), ['Vorher.', 'Dann:']);
      same(chunker.feed(' mehr. Noch.\n'), []);
      same(chunker.feed('```\nNachher. '), ['Nachher.']);
      same(chunker.flush(), []);
      // a fence that never closes stays silent to the end
      const open = sentenceChunker();
      open.feed('```\nSatz. Satz.');
      same(open.flush(), []);
    });

    await it('matches speakableText on a whole Markdown reply, however it is cut', async () => {
      const whole = speakableText(MARKDOWN).split('\n');
      for (const size of [1, 4, 9, 1000]) same(streamed(MARKDOWN, size), whole);
    });

    await it('cuts a sentence that never ends at a comma or space', async () => {
      const long = `${'wort '.repeat(30)}ende`;
      const parts = streamed(long, 10, { maxLength: 40 });
      expect(parts.length > 1).toBe(true);
      for (const part of parts) expect(part.length <= 41).toBe(true);
    });
  });

  await describe('voice policy', async () => {
    await it('narrowVoice: the narrower wins, null is no limit', async () => {
      expect(narrowVoice('any', 'local-only')).toBe('local-only');
      expect(narrowVoice('local-only', 'any')).toBe('local-only');
      expect(narrowVoice('off', 'local-only')).toBe('off');
      expect(narrowVoice(null, 'any')).toBe('any');
      expect(narrowVoice('local-only', null)).toBe('local-only');
      expect(narrowVoice(null, null)).toBeNull();
    });

    await it('isVoicePolicy accepts the three values only', async () => {
      for (const ok of ['any', 'local-only', 'off']) expect(isVoicePolicy(ok)).toBe(true);
      for (const bad of ['', 'cloud', 'Off', null, 3]) expect(isVoicePolicy(bad)).toBe(false);
    });

    await it('is read from profiles.json, absent means no limit, a bad value is a problem', async () => {
      const file = (voice?: unknown) =>
        JSON.stringify({ version: 1, profiles: [{ id: 'a', data: 'public', ...(voice ? { voice } : {}) }] });
      expect(parseProfiles(file('local-only'))[0]!.voice).toBe('local-only' satisfies VoicePolicy);
      expect(parseProfiles(file())[0]!.voice).toBeNull();
      let message = '';
      try {
        parseProfiles(file('cloud'));
      } catch (error) {
        message = String(error);
      }
      expect(message.includes('voice must be')).toBe(true);
    });
  });
};
