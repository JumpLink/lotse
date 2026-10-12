/**
 * The session record — what a lotse session *is*.
 *
 * The design rule that shaped this file, taken from beifahrer's ADR 0006 ("recipes are data and
 * hold no gate") and restated for sessions: **a session is a scope, not a permission.** The record
 * below says what is *reachable* — which agent, which directory, which conversation it belongs to.
 * It cannot say what is *allowed*, because there is no field for it. There is no allow-list to
 * store, therefore none to hand on, therefore a session passed around in a group chat is a
 * corridor and not a key.
 *
 * `assertScopeIsNotAuthority` in `@lotse/acp` is the runtime canary over the same idea, because a
 * TypeScript type cannot stop a later `{ ...session, grants: [...] }`. The canary is what makes
 * this type more than a comment.
 *
 * `boundTo` is optional **on purpose**: lotse has to run standalone, with no curlew anywhere
 * near it. A messenger integration binds a session to a conversation later; a person at a terminal
 * does not. Nothing else changes.
 */

import { assertScopeIsNotAuthority } from '@lotse/acp/gate';
import type { SessionId } from '@lotse/acp/types';

/** Who is in the session. `'local'` is the only value Scheibe 1 can produce. */
export type Principal = string;

/** The stand-in principal for a person at a terminal. A real name arrives with a real surface. */
export const LOCAL_PRINCIPAL: Principal = 'local';

/**
 * Who wrote a line. `host` is the embedding application, never the agent: a line an app built on
 * lotse put into its own conversation (an order placed, a draft saved), recorded next to the agent's
 * so a resumed session shows both in the order they happened.
 */
export type EntryKind = 'user' | 'agent' | 'thought' | 'tool' | 'system' | 'host';

/**
 * How large a recorded tool input may be, as `JSON.stringify` counts it.
 *
 * The record keeps a tool call's input so a host can recognise *its own* MCP call in a transcript —
 * a `create_order` with the arguments it was given. It does not keep a file an agent wrote or a
 * page it fetched: the session file is read in full on every write, and one pasted dump would make
 * each later line pay for it. Over the cap the input is dropped and `rawInputOmitted` says so.
 */
export const TOOL_INPUT_MAX = 8 * 1024;

/**
 * One MCP tool the call reached.
 *
 * `reported` is the agent's own account (opencode's `rawOutput.metadata.toolCalls`), with the input
 * and status it saw. `code` is read off the source of a code-mode call (`tools.<server>.<tool>(`)
 * and is a claim about what the code *names*, not what ran — so it carries no input and no status.
 */
export interface McpCall {
  server: string;
  tool: string;
  input?: unknown;
  status?: string;
  source: 'reported' | 'code';
}

/**
 * What one `tool_call`/`tool_call_update` line said about the call, beyond its text.
 *
 * Only the fields the line itself carried are set: an update is a delta, and filling in an absent
 * field here would be lotse inventing a state the agent never sent. Folding the deltas into one
 * view is the projection's job (`toTranscriptItems`), where it can be undone. `rawOutput` and
 * `content` are never stored — they are the tool's result, which is the agent's to keep.
 */
export interface ToolCallRecord {
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  /** Set when the line carried a `rawInput` larger than `TOOL_INPUT_MAX`, which was dropped. */
  rawInputOmitted?: true;
  mcp?: readonly McpCall[];
}

/** A line the embedding application recorded. `type` and `data` are the host's own; lotse reads neither. */
export interface HostRecord {
  type: string;
  data?: unknown;
  /**
   * A themed icon name drawn in front of the text. Stored rather than passed at draw time, so a
   * resumed session shows the line the way it looked when the host wrote it.
   */
  icon?: string;
}

/**
 * One line of the transcript.
 *
 * The transcript is a *record of what happened*, not a re-derivation of it: an agent's own
 * `session/load` is the authority on history, and lotse's copy exists so `lotse sessions` and
 * `lotse resume` can show something without spawning a process. A transcript that claimed more
 * than that would be a second source of truth about someone else's conversation.
 *
 * `text` is always the line a human reads, for every kind. The structured fields sit beside it and
 * a reader that knows none of them — `lotse sessions`, an older lotse — still has the whole story.
 */
export interface TranscriptEntry {
  kind: EntryKind;
  text: string;
  /** ISO 8601. Supplied by the caller, so the model stays pure and a test can pin the clock. */
  at: string;
  /** The agent's `sessionId`, when the entry came from a session that has one. */
  sessionId?: SessionId;
  /** A tool call's `toolCallId`, for `kind: 'tool'`. */
  toolCallId?: string;
  /** What the protocol line said about the call, for `kind: 'tool'`. Absent on lines older lotse wrote. */
  tool?: ToolCallRecord;
  /** The host's own payload, for `kind: 'host'`. */
  host?: HostRecord;
}

/**
 * Which copy of the agent holds a session's history: the person's own install (`host`) or the copy
 * shipped inside the build (`bundled`). The two keep separate databases, so `resume` has to go back
 * to the one that has the session. A label, never a permission.
 */
export type AgentSource = 'host' | 'bundled';

export interface SessionRecord {
  /** The agent's own session id. Opaque; lotse stores it and hands it back, never parses it. */
  id: SessionId;
  /** Which adapter started the agent, e.g. `opencode`. */
  agent: string;
  /**
   * Which copy of `agent` started the session. **Absent means `host`**: records written before this
   * field existed were all started on the person's own install.
   */
  agentSource?: AgentSource;
  /** The working directory the session runs in. Part of its *scope*, so part of the record. */
  cwd: string;
  principal: Principal;
  /**
   * What this session is bound to in the wider suite — a curlew conversation, later. `null`
   * means standalone, and standalone is a first-class case, not a missing feature.
   */
  boundTo: string | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  /** How this session is put back in front of an agent. Recorded, then honoured on resume. */
  reattach: 'load' | 'resume' | null;
  turns: TranscriptEntry[];
}

/** What `lotse start` needs to open a session. The clock is injected, so the model stays pure. */
export interface NewSession {
  id: SessionId;
  agent: string;
  agentSource?: AgentSource;
  cwd: string;
  principal?: Principal;
  boundTo?: string | null;
  title?: string | null;
  reattach?: 'load' | 'resume' | null;
  at: string;
}

export function newSession(input: NewSession): SessionRecord {
  const record: SessionRecord = {
    id: input.id,
    agent: input.agent,
    cwd: input.cwd,
    principal: input.principal ?? LOCAL_PRINCIPAL,
    boundTo: input.boundTo ?? null,
    createdAt: input.at,
    updatedAt: input.at,
    title: input.title ?? null,
    reattach: input.reattach ?? null,
    turns: [],
  };
  // Left off the record when not given, so a record stays byte-identical to what older lotse wrote.
  if (input.agentSource) record.agentSource = input.agentSource;
  assertScopeIsNotAuthority(record as unknown as Record<string, unknown>);
  return record;
}

/**
 * Append transcript lines. Mutates nothing: the store persists, so an update that cannot be written
 * must not be visible in memory either. Returns a new record.
 */
export function appendTurns(record: SessionRecord, entries: TranscriptEntry[]): SessionRecord {
  if (entries.length === 0) return record;
  const at = entries[entries.length - 1]?.at ?? record.updatedAt;
  return { ...record, turns: [...record.turns, ...entries], updatedAt: at };
}

/**
 * Stamp `updatedAt` without adding anything.
 *
 * Exists for the case a record is edited without a new transcript line — a rename, a re-bind.
 * A turn write goes through `appendTurns`, which sets the timestamp from the entry itself, so
 * that the recorded time is when the thing happened rather than when it was saved.
 */
export function touch(record: SessionRecord, at: string): SessionRecord {
  return { ...record, updatedAt: at };
}

/** Bound sessions first for the same principal, then newest — the order a list wants. */
export function byRecency(a: SessionRecord, b: SessionRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function forPrincipal(records: SessionRecord[], principal: Principal): SessionRecord[] {
  return records.filter((record) => record.principal === principal);
}

/**
 * The label a human sees: the title, else the agent's opening answer, else the id.
 *
 * "Opening answer" means the **whole run of leading agent turns**, not the first one. An agent's
 * reply arrives as `session/update` chunks and a stream boundary lands wherever the model happened
 * to emit — measured: a one-word answer split into `RESUME-` and `OK`, two turns, and a `lotse
 * sessions` row labelled `RESUME-`. Joining until the first user turn is what makes the label a
 * sentence rather than a fragment of one.
 */
export function labelOf(record: SessionRecord): string {
  if (record.title) return record.title;
  const parts: string[] = [];
  for (const turn of record.turns) {
    if (turn.kind === 'agent') {
      parts.push(turn.text);
      continue;
    }
    // A `thought`, `tool` or `host` line before the answer is not part of it and is skipped; one *between*
    // the answer's chunks ends the run. Concatening across it would splice "reading the file" into
    // a sentence that never contained it.
    if (parts.length > 0) break;
  }
  // Trim once, at the end. Trimming each chunk before joining glues words together at the seam —
  // `'first '` + `'answer'` becomes `'firstanswer'` — which is the same mid-word artefact this
  // function exists to remove. Caught by the test that asserts the joined form.
  const joined = parts.join('').trim();
  if (!joined) return record.id;
  return joined.length > 72 ? `${joined.slice(0, 72)}…` : joined;
}
