/** The action log `lotse listen` appends to under its state directory: ids and kinds, never a message. */

import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { RunLogEntry } from '@lotse/core';

import { ensureDir } from './private-file.ts';

/** The action log, `listen.log`: one JSON line per entry, with a timestamp. */
export function actionLog(stateDir: string, now: () => Date): (entry: RunLogEntry) => void {
  const file = join(stateDir, 'listen.log');
  return (entry) => {
    ensureDir(stateDir);
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  };
}
