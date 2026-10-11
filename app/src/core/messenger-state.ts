/**
 * Where the messenger's receive loop stands: the `sentAt` of the last reply it handled, kept in
 * `<state dir>/messenger-cursor.json` so a restart of `serve` neither replays old replies as answers nor
 * skips one that arrived while it was down. A missing or unreadable file means "start from now" — the
 * safe side, because an old reply answered twice is dropped but a stale one answered at all is not.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CursorStore } from '@lotse/core';

import { writePrivateFile } from './private-file.ts';

export function messengerCursorFile(stateDir: string): string {
  return join(stateDir, 'messenger-cursor.json');
}

export function fileCursorStore(path: string): CursorStore {
  return {
    read() {
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const cursor = (value as { cursor?: unknown } | null)?.cursor;
        return typeof cursor === 'string' && cursor !== '' ? cursor : null;
      } catch {
        return null;
      }
    },
    write(cursor) {
      writePrivateFile(path, `${JSON.stringify({ cursor })}\n`, 'messenger-cursor');
    },
  };
}
