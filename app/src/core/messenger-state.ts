/**
 * Where the messenger's receive loop stands: the `sentAt` of the last reply it handled and the ids seen at
 * that millisecond, kept in `<state dir>/messenger-cursor.json` so a restart of `serve` neither replays old
 * replies as answers nor skips one that arrived while it was down. A missing or unreadable file means
 * "start from now" — the safe side, because an old reply answered twice is dropped but a stale one
 * answered at all is not. A file from before `seen` existed reads as a cursor with none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CursorStore, PendingRequest, PendingStore, RefStore, SentRef } from '@lotse/core';

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

export function pendingRequestsFile(stateDir: string): string {
  return join(stateDir, 'pending-requests.json');
}

/**
 * The requests accepted and not yet answered (`PendingStore`), in `<state dir>/pending-requests.json`: ids
 * and times, never what was asked. A missing or unreadable file is an empty list.
 */
export function filePendingStore(path: string): PendingStore {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!Array.isArray(value)) return [];
        return value.filter(
          (item): item is PendingRequest =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as PendingRequest).id === 'string' &&
            typeof (item as PendingRequest).at === 'string',
        );
      } catch {
        return [];
      }
    },
    write(list) {
      writePrivateFile(path, `${JSON.stringify(list)}\n`, 'pending-requests');
    },
  };
}

export function messengerRefsFile(stateDir: string): string {
  return join(stateDir, 'messenger-refs.json');
}

/**
 * The ids of the sent question messages (`RefStore`), in `<state dir>/messenger-refs.json`: message id,
 * user and question id, never a text. A missing or unreadable file is an empty list.
 */
export function fileRefStore(path: string): RefStore {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!Array.isArray(value)) return [];
        return value.filter(
          (item): item is SentRef =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as SentRef).messageId === 'string' &&
            typeof (item as SentRef).user === 'string' &&
            typeof (item as SentRef).questionId === 'string',
        );
      } catch {
        return [];
      }
    },
    write(list) {
      writePrivateFile(path, `${JSON.stringify(list)}\n`, 'messenger-refs');
    },
  };
}
