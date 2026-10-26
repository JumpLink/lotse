/**
 * `lotse questions` — what the agents are waiting on (ADR 0003 §4).
 *
 * Reads the question store and nothing else: no task configuration, no agent, no GI. It works while
 * `listen` runs and while it does not, because the store is the only place a question lives.
 */

import { _, fmt } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import { formatQuestionId, isOpen, type LotsePaths } from '@lotse/core';

import type { ListenPaths } from '../../core/paths.ts';
import { questionBook } from '../../core/question-state.ts';
import { err, out, pickArgv } from './output.ts';

const command = (_paths: LotsePaths, listen: ListenPaths): CommandModule => ({
  command: 'questions',
  describe: _('list the questions agents are waiting on'),
  builder: (yargs) =>
    yargs
      .option('all', { type: 'boolean', describe: _('also list answered, expired and cancelled questions') })
      .option('json', { type: 'boolean', describe: _('print the questions as JSON') })
      .strict(),
  handler: (argv) => {
    const raw = argv as Record<string, unknown>;
    const all = pickArgv<boolean>(raw, 'all') === true;
    const json = pickArgv<boolean>(raw, 'json') === true;
    const now = new Date();
    const book = questionBook(
      listen.stateDir,
      () => now,
      (problem) => err(fmt(_('  {problem}'), { problem })),
    ).read();
    const shown = book
      .filter((question) => all || isOpen(question, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (json) {
      out(JSON.stringify(shown, null, 2));
      return;
    }
    if (shown.length === 0) {
      err(all ? 'no questions' : 'no open questions');
      return;
    }
    for (const question of shown) {
      const status = isOpen(question, now) ? `open until ${question.expiresAt}` : question.status;
      out(`${formatQuestionId(question.id)}  ${question.task}  ${question.kind}  ${status}`);
      for (const line of question.text.split('\n')) out(fmt(_('    {line}'), { line }));
      if (!isOpen(question, now) && question.resolution)
        out(fmt(_('    → {resolution}'), { resolution: question.resolution }));
    }
  },
});

export const questionsCommand = command;
