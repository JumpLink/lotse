/**
 * Where the messenger's receive loop stands: the `sentAt` of the last reply it handled and the ids seen at
 * that millisecond, kept in `<state dir>/messenger-cursor.json` so a restart of `serve` neither replays old
 * replies as answers nor skips one that arrived while it was down. A missing or unreadable file means
 * "start from now" — the safe side, because an old reply answered twice is dropped but a stale one
 * answered at all is not. A file from before `seen` existed reads as a cursor with none.
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
        const value = JSON.parse(readFileSync(path, 'utf8')) as { cursor?: unknown; seen?: unknown } | null;
        const at = value?.cursor;
        if (typeof at !== 'string' || at === '') return null;
        const seen = Array.isArray(value?.seen)
          ? value.seen.filter((key): key is string => typeof key === 'string')
          : [];
        return { at, seen };
      } catch {
        return null;
      }
    },
    write(cursor) {
      const body = cursor.seen.length > 0 ? { cursor: cursor.at, seen: cursor.seen } : { cursor: cursor.at };
      writePrivateFile(path, `${JSON.stringify(body)}\n`, 'messenger-cursor');
    },
  };
}
