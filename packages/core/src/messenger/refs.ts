/**
 * Which chat message carried which question, so a reply to that message (XEP-0461) binds its answer to
 * exactly that question. The id is the one the send tool returned (`originId` for curlew), which a
 * reply names again as `replyToId`.
 *
 * A bounded list, newest last: an old question that dropped out simply falls back to reading the
 * reply by its text. The app keeps it in a file, so a restart of `serve` does not lose the link.
 */

export interface SentRef {
  /** The message id the send tool returned. */
  readonly messageId: string;
  readonly user: string;
  readonly questionId: string;
}

export interface RefStore {
  read(): readonly SentRef[];
  write(refs: readonly SentRef[]): void;
}

export const REF_LIMIT = 200;

export function memoryRefs(): RefStore {
  let refs: readonly SentRef[] = [];
  return {
    read: () => refs,
    write: (next) => {
      refs = next;
    },
  };
}

/** Remember that `messageIds` carried `questionId` of `user`. */
export function recordRefs(
  store: RefStore,
  user: string,
  questionId: string,
  messageIds: readonly string[],
): void {
  if (messageIds.length === 0) return;
  const known = store.read().filter((ref) => !messageIds.includes(ref.messageId));
  const added = messageIds.map((messageId): SentRef => ({ messageId, user, questionId }));
  store.write([...known, ...added].slice(-REF_LIMIT));
}

export function findRef(store: RefStore, messageId: string): SentRef | null {
  return store.read().find((ref) => ref.messageId === messageId) ?? null;
}
