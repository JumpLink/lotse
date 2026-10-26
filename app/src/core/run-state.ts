/**
 * What `lotse listen` keeps about runs under its state directory (ADR 0003 §7): `runs.json` — ids and
 * outcomes, never a message — and one lock per task, which keeps a run and an answer from driving the
 * same task at once.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunResult } from '@lotse/core';

import { ensureDir, writePrivateFile } from './private-file.ts';

/** What `runs.json` keeps per task: when, how it ended, which session. No message text. */
export interface RunRecord {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: RunResult['outcome'];
  readonly sessionId: string | null;
  readonly stopReason: string | null;
  readonly questionId: string | null;
  readonly reason: string | null;
  /** The precheck's verdict; `null` when the task has none. Old records lack it. */
  readonly precheck?: RunResult['precheck'];
}

export interface RunState {
  record(result: RunResult): void;
  all(): Readonly<Record<string, RunRecord>>;
}

export function runState(stateDir: string): RunState {
  const file = join(stateDir, 'runs.json');
  const read = (): Record<string, RunRecord> => {
    if (!existsSync(file)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, RunRecord>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    record: (result) => {
      const runs = read();
      runs[result.task] = {
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        outcome: result.outcome,
        sessionId: result.sessionId,
        stopReason: result.stopReason,
        questionId: result.questionId,
        reason: result.reason,
        precheck: result.precheck,
      };
      writePrivateFile(file, `${JSON.stringify(runs, null, 2)}\n`, 'runs');
    },
    all: read,
  };
}

function alive(pid: number): boolean {
  if (existsSync('/proc/self')) return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The tasks whose lock a live process holds — what `lotse status` calls running. */
export function runningTasks(stateDir: string): string[] {
  const dir = join(stateDir, 'locks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.lock'))
    .filter((name) => {
      const pid = Number.parseInt(readFileSync(join(dir, name), 'utf8'), 10);
      return Number.isInteger(pid) && pid > 0 && alive(pid);
    })
    .map((name) => name.slice(0, -'.lock'.length))
    .sort();
}

/**
 * `locks/<task>.lock`, created exclusively with the holder's pid. A lock whose process is gone is
 * stale and taken over; a live one means `null` — the task is running elsewhere.
 */
export function taskLock(stateDir: string): (task: string) => (() => void) | null {
  const dir = join(stateDir, 'locks');
  return (task) => {
    ensureDir(stateDir);
    ensureDir(dir);
    const file = join(dir, `${task}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
        rmSync(file, { force: true });
      }
    }
    return null;
  };
}
