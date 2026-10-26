/**
 * A task as `listen` and `lotse run` run it: what to say, where, with which tools and how much it may
 * do. It comes from a `tasks/<id>/SKILL.md` (`skill.ts`) bound to a profile; there is no task file.
 */

import type { McpServer } from '@lotse/acp';

/**
 * The three rights levels (ADR 0002 §6). `read` declines every permission request without asking,
 * `confirm` asks for each, `released` allows the listed areas once per call and asks for the rest.
 */
export type RightsLevel = 'read' | 'confirm' | 'released';

/**
 * An area the person released without questions: a tool, matched by the exact title the agent gives
 * the call, optionally narrowed by its kind. The person's decision, recorded here and nowhere else.
 */
export interface ReleasedArea {
  readonly tool: string;
  readonly kind: string | null;
}

export interface PersonNeededConfig {
  readonly enabled: boolean;
  readonly timeoutMin: number | null;
}

export const PERSON_NEEDED_OFF: PersonNeededConfig = { enabled: false, timeoutMin: null };

/**
 * A cheaper turn before the task: it ends with `WORK` or `NOTHING` on its last line, and only `WORK`
 * starts the task. It gets the task's `mcpServers` and a gate that declines every permission request.
 */
export interface Precheck {
  readonly prompt: string;
}

export interface Task {
  readonly id: string;
  readonly profile: string;
  readonly prompt: string;
  readonly cwd: string;
  /** Passed to `session/new` as is — MCP is passed through, not known. */
  readonly mcpServers: readonly McpServer[];
  readonly precheck: Precheck | null;
  readonly rights: RightsLevel;
  /** The `person_needed` tool. `timeoutMin` `null`: the settings' default. */
  readonly personNeeded: PersonNeededConfig;
}

export interface QuestionLimits {
  /** How long a question stays open before it is answered `cancelled`. */
  readonly expiresMs: number;
  /** More open questions than this and the task is skipped without a model call. */
  readonly maxOpen: number;
  /** More questions created in the last hour than this and the task is skipped. */
  readonly maxPerHour: number;
}

export const DEFAULT_QUESTION_LIMITS: QuestionLimits = {
  expiresMs: 12 * 3_600_000,
  maxOpen: 3,
  maxPerHour: 6,
};
