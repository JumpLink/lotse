/**
 * Finding and reading the answer window from the CLI side: which program opens it, the `--answer`
 * argument, and the one framed line it writes back.
 */

import { describe, expect, it } from '@gjsify/unit';

import { answerArg, answerFrame, dialogCommand, dialogResult } from '../../../src/core/answer-dialog.ts';

const SELF = '/opt/lotse/dist/lotse.gjs.mjs';
const WAYLAND = { WAYLAND_DISPLAY: 'wayland-0' };

export default async () => {
  await describe('dialogCommand', async () => {
    await it('without a display there is no window', async () => {
      const command = dialogCommand(SELF, {}, () => true);
      expect('problem' in command && command.problem.includes('no display')).toBe(true);
    });

    await it('X11 counts as a display too', async () => {
      expect(dialogCommand(SELF, { DISPLAY: ':0' }, () => true)).toStrictEqual({
        command: ['gjs', '-m', '/opt/lotse/dist/lotse-app.gjs.mjs'],
      });
    });

    await it('LOTSE_ANSWER_DIALOG wins and is split on spaces', async () => {
      expect(
        dialogCommand(
          SELF,
          { ...WAYLAND, LOTSE_ANSWER_DIALOG: ' flatpak run eu.jumplink.Lotse ' },
          () => false,
        ),
      ).toStrictEqual({ command: ['flatpak', 'run', 'eu.jumplink.Lotse'] });
    });

    await it('falls back to the lotse-app executable beside the bundle', async () => {
      const exists = (path: string) => path === '/opt/lotse/dist/lotse-app';
      expect(dialogCommand(SELF, WAYLAND, exists)).toStrictEqual({ command: ['/opt/lotse/dist/lotse-app'] });
    });

    await it('names the build step when neither is there', async () => {
      const command = dialogCommand(SELF, WAYLAND, () => false);
      expect('problem' in command && command.problem.includes('build:app')).toBe(true);
    });
  });

  await describe('answerArg', async () => {
    await it('reads both spellings', async () => {
      expect(answerArg(['--answer', 'A1'])).toBe('A1');
      expect(answerArg(['--answer=#A2'])).toBe('#A2');
    });

    await it('is null without the flag and empty without a value', async () => {
      expect(answerArg(['--gapplication-service'])).toBeNull();
      expect(answerArg(['--answer'])).toBe('');
    });
  });

  await describe('dialogResult', async () => {
    await it('round-trips a multi-line answer through the frame', async () => {
      const text = 'Pin it at 1.x.\nAnd open an issue.';
      expect(dialogResult(0, `Gtk-Message: noise\n${answerFrame(text)}`)).toStrictEqual({
        kind: 'answer',
        text,
      });
    });

    await it('takes the last frame', async () => {
      expect(dialogResult(0, answerFrame('yes') + answerFrame('no'))).toStrictEqual({
        kind: 'answer',
        text: 'no',
      });
    });

    await it('no frame is Later', async () => {
      expect(dialogResult(0, '')).toStrictEqual({ kind: 'later' });
      expect(dialogResult(0, 'some log line\n')).toStrictEqual({ kind: 'later' });
    });

    await it('a non-zero exit or a broken frame fails', async () => {
      expect(dialogResult(3, answerFrame('yes')).kind).toBe('failed');
      expect(dialogResult(null, '').kind).toBe('failed');
      expect(dialogResult(0, 'lotse-answer:{not json').kind).toBe('failed');
      expect(dialogResult(0, answerFrame('   ')).kind).toBe('failed');
    });
  });
};
