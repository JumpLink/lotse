/**
 * `lotse answer <id> [text…]` — answer a question an agent asked (ADR 0003 §5).
 *
 * A permission question takes yes or no, which the run that holds the request picks up. A reply
 * question continues the session: `session/load`, else `session/resume`, else a follow-up run that
 * carries the question as context. The command prints which of these happened, on stderr, and the
 * agent's reply on stdout.
 *
 * Without text, or with `--dialog`, the answer window collects it (`answer-dialog.ts`) where there is a
 * display; the text it returns takes the same path as text on the command line.
 */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import { answerQuestion, type LotsePaths } from '@lotse/core';

import { currentDialogCommand, openAnswerDialog } from '../../core/answer-dialog.ts';
import type { ServePaths } from '../../core/paths.ts';
import { stderrChannel } from '../../core/stderr-channel.ts';
import { err, out, pickArgv } from './output.ts';
import { readTasks, serveDeps, trackedAgents } from './serve-deps.ts';

const FAILED = new Set(['unknown', 'dropped', 'expired', 'busy', 'invalid']);

/** The text from the answer window; `null` when there is nothing to answer, with the exit code set. */
async function textFromDialog(id: string, asked: boolean): Promise<string | null> {
  const command = currentDialogCommand();
  if ('problem' in command) {
    err(asked ? `no answer window: ${command.problem}` : 'an answer needs text: yes, no, or the reply');
    process.exitCode = 1;
    return null;
  }
  const result = await openAnswerDialog(command.command, id.replace(/^#/, ''));
  if (result.kind === 'answer') return result.text;
  if (result.kind === 'failed') {
    err(result.reason);
    process.exitCode = 1;
  }
  return null;
}

/** Hand the answer to the core, the same way for text from the command line and from the window. */
async function answerWith(
  id: string,
  text: string,
  quiet: boolean,
  paths: LotsePaths,
  serve: ServePaths,
): Promise<void> {
  const loaded = readTasks(serve);
  if (!loaded) return;
  const agents = trackedAgents();
  // The agent's reply is printed here; a question it asks back reaches the person through `serve`'s
  // channel on its next question, and through `lotse questions` right away.
  const deps = serveDeps({ paths, serve, loaded, channel: stderrChannel(), open: agents.open, quiet });
  if (!deps) return;
  try {
    const result = await answerQuestion(id, text, deps);
    err(result.message);
    if (result.run?.reply) out(result.run.reply);
    if (FAILED.has(result.mode) || result.run?.outcome === 'failed') process.exitCode = 1;
  } finally {
    await agents.closeAll();
  }
}

const command = (paths: LotsePaths, serve: ServePaths): CommandModule => ({
  command: 'answer <id> [text..]',
  describe: _('answer a question from `lotse questions`; yes/no for a permission, text for a reply'),
  builder: (yargs) =>
    yargs
      .positional('id', { type: 'string', describe: _('the question id, like #A1 or A1') })
      .positional('text', {
        type: 'string',
        array: true,
        describe: _('yes, no, or the reply; without it the answer window opens where there is a display'),
      })
      .option('dialog', { type: 'boolean', describe: _('type the answer in a window') })
      .option('quiet', { type: 'boolean', describe: _("do not echo the agent's log lines") })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const id = String(pickArgv<string | number>(raw, 'id') ?? '');
    const given = (pickArgv<string[]>(raw, 'text') ?? []).join(' ').trim();
    const dialog = pickArgv<boolean>(raw, 'dialog') === true;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    if (given && dialog) {
      err(_('either text or --dialog, not both'));
      process.exitCode = 1;
      return;
    }
    if (given) return answerWith(id, given, quiet, paths, serve);
    try {
      const text = await textFromDialog(id, dialog);
      if (text) await answerWith(id, text, quiet, paths, serve);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      // On GJS the closed window's child-process handle keeps the main loop alive after the handler
      // returns, so the command would hang after Later or Send; Node exits on its own.
      process.exit(process.exitCode ?? 0);
    }
  },
});

export const answerCommand = command;
