/**
 * A transcript, projected onto the things a surface can draw.
 *
 * `toTranscript` decides what a line *is*; this decides what one line *looks like*. The two are kept
 * apart for the same reason `config.ts` exists: a projection is pure, so it is testable on Node and
 * GJS alike, and a widget is not. Nothing here imports `gi://`, reads a clock, or knows a widget
 * exists — the surface asks for items and builds whatever it likes from them.
 *
 * Four decisions are in here, and they are the ones a reader is most likely to "fix" wrongly:
 *
 * **1. Consecutive chunks of one message are one bubble.** An ACP message arrives as
 * `session/update` chunks, and a stream boundary lands wherever the model happened to emit —
 * measured, a one-word answer arrived as `RESUME-` and `OK`. Rendering the chunks as they came
 * would put two bubbles where the person sent one, and would make an answer's own bubbles
 * indistinguishable from two answers. So a run of adjacent entries of one kind is joined.
 *
 * **2. Joined with nothing between, and trimmed only at the end.** `labelOf` in `@lotse/session`
 * arrived at this first and says why: trimming each chunk before joining glues words together at the
 * seam (`'first '` + `'answer'` becomes `'firstanswer'`), which is the mid-word artefact both
 * functions exist to remove. A test here asserts the two agree on the same input, so a change to one
 * that the other does not follow fails a test rather than showing up in one surface and not the
 * other.
 *
 * **3. A run ends at anything that is not the same kind.** A `thought` or a `tool` line *between*
 * two chunks ends the answer: concatenating across it would splice "reading the file" into a
 * sentence that never contained it. `labelOf` breaks on the same boundary, for the same reason.
 *
 * **4. Order is the record's, not the clock's.** Nothing is sorted. The transcript is a record of
 * what happened in the order it was appended; a surface that re-sorted it by timestamp would be
 * re-deriving history the agent's own `session/load` is the authority on — and it would be
 * re-deriving it from timestamps that a hand-edited store can carry as garbage.
 *
 * **A tool entry is one item per line, deliberately.** `toTranscript` records a `tool_call` and each
 * of its `tool_call_update`s as its own line, so one read can be three rows. Collapsing them by
 * `toolCallId` would have to decide which text is the newer state, and a `tool_call_update` is
 * allowed to carry a status and no title — so "the newer one wins" silently drops the title and the
 * row becomes ` — completed`. The record has the lines; this projection does not second-guess the
 * agent's protocol with them. One row per recorded line, and the summary is that line.
 *
 * **The fold lives beside the rows, not instead of them.** Since lines carry a structured `tool`
 * record, each `ToolItem` also has `call`: the call's state folded field by field across every line
 * of the same id up to this one. Field by field is what the text-level collapse above could not do —
 * an update without a title keeps the earlier title, because an absent field is "unchanged" in the
 * record and not an empty string. A surface that wants one row per call can now draw only the last
 * row of each id; this projection still does not make that choice for it.
 *
 * **A tool line has no body, and that is the honest outcome rather than a missing feature.** A
 * `tool_call` carries `rawOutput` in whatever shape the agent's tool used, and `toTranscript`
 * deliberately does not keep it (its own file header is about this). The input it does keep is for a
 * host to recognise its own call through `call`, not a body to print: a code-mode script or a JSON
 * blob behind a disclosure is not something a person reads. The first version put the recorded line,
 * the agent's `toolCallId` and the raw ISO timestamp in the body — which is the summary again, an
 * internal id, and a timestamp no surface renders. Repeating the summary behind a disclosure and
 * calling it a body is a control that points at nothing, so a tool line is its summary and a surface
 * draws it as a plain row.
 *
 * **A host line is never merged.** See `HostItem`.
 */

import type { EntryKind, McpCall, TranscriptEntry } from '@lotse/session';

/**
 * Kinds whose adjacent entries are one message rather than several — see decision 1.
 *
 * `tool` is left out, and the reason is in the file header: a `tool_call` and its updates are
 * separate *protocol* lines, and how to fold them is a question about the agent's stream that this
 * module does not get to answer for it. `host` is left out because a host line is not a stream
 * fragment at all — each one is a whole thing the host did.
 */
const MERGED_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['user', 'agent', 'thought', 'system']);

/**
 * How long a closed disclosure's one line may be.
 *
 * The transcript's measure is about 76 characters at 1em (`css.ts`), and a disclosure line is 0.9em,
 * so 84 fits about the same physical width. A tool title can be an entire shell command, and a
 * disclosure that wraps is no longer a disclosure — it is a paragraph between two answers, which is
 * the thing the "one collapsible line" is for. The cut is only ever in the summary; the full text is
 * in the body, so nothing is lost by it.
 */
const SUMMARY_MAX = 84;

/** One message, in the speaker's own style. The side is the surface's choice; this only says who. */
export interface UserItem {
  readonly kind: 'user';
  readonly text: string;
  readonly at: string;
}

/** The agent's answer. Merged across chunks, so one of these is one answer however it streamed. */
export interface AgentItem {
  readonly kind: 'agent';
  readonly text: string;
  readonly at: string;
}

/**
 * A line that is closed until somebody opens it.
 *
 * Both a thought and a tool call are this, which is why the surface builds **one** disclosure
 * widget for them instead of two: the shape is the same and the difference is the icon and the
 * summary. `summary` is the closed line and is always one line; `detail` is what there is behind it,
 * and `null` when there is nothing — then it is not a disclosure at all and the surface draws a
 * plain row.
 */
export interface DisclosureItem {
  /** The one line, truncated to `SUMMARY_MAX`. */
  readonly summary: string;
  /**
   * What the record holds to show behind the line, or `null` when it holds nothing.
   *
   * `null` rather than an empty string, because the two are different claims: an empty string is a
   * body somebody has to look at and find blank, and `null` is a surface free to draw a line
   * instead of a disclosure.
   */
  readonly detail: string | null;
  /**
   * Whether this starts open.
   *
   * Here rather than in the widget because it is a decision about the *content* — a model thinking
   * out loud in paragraphs does not belong in the surface (the plan's §3) — and a rule that lives
   * in the widget is a rule each surface re-decides.
   */
  readonly expanded: boolean;
  /** ISO 8601, from the entry the run started with. */
  readonly at: string;
}

/** A thought, closed by default. Its body is the reasoning itself, so there always is one. */
export interface ThoughtItem extends DisclosureItem {
  readonly kind: 'thought';
}

/**
 * A tool call's state as of one line: every earlier line of the same call folded in, newer fields
 * winning. What a host presenter is handed (`LotseChatOptions.toolPresenter`), so it can recognise
 * its own MCP call without replaying the stream itself.
 */
export interface ToolCallView {
  /** `null` for a line that carried no id — then the view is that line alone. */
  readonly toolCallId: string | null;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawInputOmitted?: true;
  /** From the latest line that named any; empty when none did. */
  readonly mcp: readonly McpCall[];
}

/**
 * A tool call, closed by default — and with no body, because lotse records the line and the call's
 * input, never its output. See the file header; the `detail` a future one would carry is a tool's
 * output, and `TranscriptEntry` is where it would have to arrive.
 */
export interface ToolItem extends DisclosureItem {
  readonly kind: 'tool';
  /** The folded call, or `null` for a line written before lines carried a structured record. */
  readonly call: ToolCallView | null;
}

/** Bookkeeping the conversation did with itself: a mode change, a plan, an unknown update. */
export interface SystemItem {
  readonly kind: 'system';
  readonly text: string;
  readonly at: string;
}

/**
 * A line the embedding application recorded (`LotseChat.appendHostItem`). Never merged: two host
 * lines are two things the host did, and joining them would make one claim out of two.
 */
export interface HostItem {
  readonly kind: 'host';
  /** The host's own type name; empty when the stored record was unreadable and dropped. */
  readonly type: string;
  readonly text: string;
  readonly data: unknown;
  /** The icon the host asked for, or `null` for none. */
  readonly icon: string | null;
  readonly at: string;
}

/** A control that passed the projection. Nothing else reaches a surface. */
export type TranscriptItem = UserItem | AgentItem | ThoughtItem | ToolItem | SystemItem | HostItem;

/** One run of adjacent entries of a single kind, before it is turned into an item. */
interface Run {
  readonly kind: EntryKind;
  /**
   * When the run **started** — the first entry's timestamp, not the last.
   *
   * A run is one message, so it begins when the message began. The alternative — the last chunk's
   * time — would put a bubble's clock at the moment it happened to finish streaming, which is a
   * number that moves while the person is reading and means nothing to them.
   */
  readonly at: string;
  /** Raw chunks, untrimmed, in arrival order. See decision 2. */
  readonly chunks: string[];
  /** The entry the run started with — the only one, for a kind that is never merged. */
  readonly entry: TranscriptEntry;
  /** The folded call as of `entry`, for a `tool` run. */
  readonly call: ToolCallView | null;
}

/**
 * Project a transcript onto display items.
 *
 * Accepts the same `readonly TranscriptEntry[]` the store holds, so a surface can hand over
 * `record.turns` unchanged. An entry whose text is blank is dropped: `toTranscript` already skips
 * empty chunks, so one here means a hand-edited store, and a bubble with nothing in it is a hole in
 * the conversation rather than a message.
 */
export function toTranscriptItems(entries: readonly TranscriptEntry[]): TranscriptItem[] {
  const runs: Run[] = [];
  const calls = new Map<string, ToolCallView>();
  for (const entry of entries) {
    // Folded before the blank test, so a line with nothing to read still contributes its state to
    // the next one that has.
    const call = entry.kind === 'tool' ? foldCall(calls, entry) : null;
    // The raw chunk, not a trimmed one. An ACP chunk is a stream fragment and can split mid-word
    // (measured: `RESUME-` then `OK`), so the spaces in it are part of the message — trimming here
    // is exactly the bug decision 2 is about. The blank test below is on the trimmed value only to
    // decide whether there is anything to show at all.
    const chunk = entry.text ?? '';
    if (chunk.trim() === '') continue;
    const last = runs[runs.length - 1];
    if (last && last.kind === entry.kind && MERGED_KINDS.has(entry.kind)) {
      last.chunks.push(chunk);
      continue;
    }
    runs.push({
      kind: entry.kind,
      at: entry.at,
      chunks: [chunk],
      entry,
      call,
    });
  }
  return runs.map(toItem);
}

/**
 * Fold one tool line into the state of its call, and return that state as of this line.
 *
 * Keyed by agent session and `toolCallId`, because an id is only unique within the session that
 * issued it and one record can span a `session/load` into a new one. A line with no id, or written
 * before lines carried a `tool` record, is not folded: `null` is the honest "the record does not
 * say", and a view built from the text would be `parseToolLine` again in a second place.
 */
function foldCall(calls: Map<string, ToolCallView>, entry: TranscriptEntry): ToolCallView | null {
  const record = entry.tool;
  if (!record) return null;
  const key = entry.toolCallId === undefined ? null : `${entry.sessionId ?? ''}\u0000${entry.toolCallId}`;
  const before = key === null ? undefined : calls.get(key);
  const next: { -readonly [K in keyof ToolCallView]: ToolCallView[K] } = {
    toolCallId: entry.toolCallId ?? null,
    mcp: before?.mcp ?? [],
  };
  for (const field of ['kind', 'title', 'status'] as const) {
    const value = record[field] ?? before?.[field];
    if (value !== undefined) next[field] = value;
  }
  // A newer input and a newer "omitted" each replace the other: they are two answers to the same
  // question, and keeping both would claim an input the agent later said was too large, or the
  // reverse.
  if (record.rawInput !== undefined) next.rawInput = record.rawInput;
  else if (record.rawInputOmitted) next.rawInputOmitted = true;
  else if (before?.rawInput !== undefined) next.rawInput = before.rawInput;
  else if (before?.rawInputOmitted) next.rawInputOmitted = true;
  // Replaced, never merged: a later line's list is the agent's fuller account of the same run (the
  // code reading while it runs, the reported calls once it is done), not further calls.
  if (record.mcp && record.mcp.length > 0) next.mcp = record.mcp;
  if (key !== null) calls.set(key, next);
  return next;
}

function toItem(run: Run): TranscriptItem {
  // Trimmed exactly once, here, on the finished run — never per chunk.
  const text = run.chunks.join('').trim();
  switch (run.kind) {
    case 'user':
      return { kind: 'user', text, at: run.at };
    case 'agent':
      return { kind: 'agent', text, at: run.at };
    case 'system':
      return { kind: 'system', text, at: run.at };
    case 'thought':
      return {
        kind: 'thought',
        summary: thoughtSummary(run.chunks.length),
        detail: text,
        expanded: false,
        at: run.at,
      };
    case 'tool':
      return {
        kind: 'tool',
        summary: oneLine(text),
        // `null`, not the recorded line again: the summary IS that line, and `toTranscript` keeps no
        // output for the body to be anything else. See the file header.
        detail: null,
        expanded: false,
        at: run.at,
        call: run.call,
      };
    case 'host':
      return {
        kind: 'host',
        type: run.entry.host?.type ?? '',
        text,
        data: run.entry.host?.data,
        icon: run.entry.host?.icon || null,
        at: run.at,
      };
  }
}

/**
 * A closed line out of a body of text.
 *
 * Whitespace collapses first: an agent's tool `title` is free text and can hold a newline, and a
 * closed row that wraps is a row that has stopped being a disclosure. Then the cut, so a shell
 * command can be scanned by its first few words.
 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** What the disclosure says while it is closed. Fixed English — see `session-groups.ts` §2. */
function thoughtSummary(chunks: number): string {
  return chunks === 1 ? 'Thought' : `${chunks} thoughts`;
}
