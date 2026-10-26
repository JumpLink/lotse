/**
 * Opening the answer window from a process without GTK: `lotse answer <id>` with no text, and a click on
 * a `listen` notification.
 *
 * **The window only collects text.** It runs in the GUI bundle (`lotse-app … --answer <id>`), because a
 * `gi://Gtk` in the CLI bundle would load GTK for every `lotse sessions` over SSH (`gui/main.ts`). It
 * writes one framed line to stdout and exits; the caller hands the text to `answerQuestion`, so the
 * window is never a second way to answer — only a second way to type.
 *
 * Without a display, or without the window's bundle next to this one, there is no dialog and the
 * caller says why: the CLI keeps its usage error, `listen` keeps the plain notification.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { envKnob } from '@lotse/core';

/** The argument the GUI bundle reads to open the window instead of the main one. */
export const ANSWER_FLAG = '--answer';

const FRAME = 'lotse-answer:';

/** A display the window can open on. */
export function hasDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WAYLAND_DISPLAY'] || env['DISPLAY']);
}

export type DialogCommand = { readonly command: readonly string[] } | { readonly problem: string };

/**
 * The program that opens the window, from where this bundle is. `LOTSE_ANSWER_DIALOG` names one (a
 * program and its arguments, split on spaces); else the GUI bundle beside this one, run by `gjs`
 * (`app/dist/`), else the `lotse-app` executable beside it (a Flatpak's `/app/bin`).
 */
export function dialogCommand(
  selfFile: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): DialogCommand {
  if (!hasDisplay(env)) return { problem: 'no display (neither WAYLAND_DISPLAY nor DISPLAY is set)' };
  const pinned = envKnob(env, 'ANSWER_DIALOG')?.trim();
  if (pinned) return { command: pinned.split(/\s+/) };
  const dir = dirname(selfFile);
  const bundle = join(dir, 'lotse-app.gjs.mjs');
  if (exists(bundle)) return { command: ['gjs', '-m', bundle] };
  const program = join(dir, 'lotse-app');
  if (exists(program)) return { command: [program] };
  return {
    problem: `the answer window is not next to ${selfFile} (build it with \`gjsify workspace lotse-cli build:app\`, or set LOTSE_ANSWER_DIALOG)`,
  };
}

/** `dialogCommand` for the running bundle. */
export function currentDialogCommand(env: NodeJS.ProcessEnv = process.env): DialogCommand {
  return dialogCommand(fileURLToPath(import.meta.url), env);
}

/** The question id after `--answer`, or `null` when the window was not asked for. */
export function answerArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === ANSWER_FLAG) return argv[i + 1] ?? '';
    if (arg.startsWith(`${ANSWER_FLAG}=`)) return arg.slice(ANSWER_FLAG.length + 1);
  }
  return null;
}

/** The window's one line of output. JSON, so an answer may span lines. */
export function answerFrame(text: string): string {
  return `${FRAME}${JSON.stringify({ text })}\n`;
}

export type DialogResult =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'later' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * What the window did, from its exit status and stdout. Only the framed line counts — GJS or a library
 * may print something else — and the last one wins. No frame and status 0 is "Later".
 */
export function dialogResult(status: number | null, stdout: string): DialogResult {
  if (status !== 0)
    return { kind: 'failed', reason: `the answer window exited with ${status ?? 'a signal'}` };
  const line = stdout
    .split('\n')
    .filter((candidate) => candidate.startsWith(FRAME))
    .at(-1);
  if (line === undefined) return { kind: 'later' };
  try {
    const value = JSON.parse(line.slice(FRAME.length)) as { text?: unknown };
    if (typeof value.text === 'string' && value.text.trim() !== '')
      return { kind: 'answer', text: value.text };
  } catch {
    // Falls through: a frame that is not JSON is a broken window, not an answer.
  }
  return { kind: 'failed', reason: 'the answer window wrote something lotse cannot read' };
}

/** Open the window for one question and wait until it is closed. Never rejects. */
export function openAnswerDialog(command: readonly string[], questionId: string): Promise<DialogResult> {
  return new Promise((resolve) => {
    const [program = '', ...args] = command;
    let stdout = '';
    try {
      const child = spawn(program, [...args, ANSWER_FLAG, questionId], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', (error) => resolve({ kind: 'failed', reason: error.message }));
      child.on('close', (status) => resolve(dialogResult(status, stdout)));
    } catch (error) {
      resolve({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  });
}
