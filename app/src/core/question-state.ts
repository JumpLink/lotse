/**
 * The question store `lotse listen` keeps under its state directory (ADR 0003 §7).
 *
 * **Two processes write here.** `listen` and `lotse answer` both read the store fresh and write it
 * whole; `writePrivateFile` renames atomically, so a reader sees the old list or the new one, never
 * half of one. The questions hold what the person was shown — no prompt, no agent message.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseQuestions, pruneQuestions, type Question, type QuestionBook } from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

/** Closed questions stay this long, so `lotse questions --all` can still say what happened. */
export const KEEP_CLOSED_MS = 7 * 86_400_000;

/** The question store, `questions.json`. A corrupt file is reported once and read as empty. */
export function questionBook(
  stateDir: string,
  now: () => Date,
  onProblem?: (problem: string) => void,
): QuestionBook {
  const file = join(stateDir, 'questions.json');
  return {
    read: () => {
      if (!existsSync(file)) return [];
      const { questions, problem } = parseQuestions(readFileSync(file, 'utf8'));
      if (problem) onProblem?.(problem);
      return questions;
    },
    write: (questions: Question[]) => {
      const kept = pruneQuestions(questions, now(), KEEP_CLOSED_MS);
      writePrivateFile(file, `${JSON.stringify(kept, null, 2)}\n`, 'questions');
    },
  };
}
