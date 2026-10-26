/**
 * profiles.json from a tasks.json that still carries its profiles (ADR 0007 §3).
 *
 * Before profiles were a concept of their own, a profile lived in tasks.json with its agent, model and
 * data label. This derives the file those became. It is pure: the app decides whether profiles.json
 * exists, writes the text and tells the person — and never touches tasks.json, which keeps working.
 */

import { isRecord } from '../parse.ts';
import { ProfilesError, parseProfiles } from './profile.ts';

/**
 * The text of a profiles.json for the profiles of this tasks.json, or `null` when it has none to
 * carry over (not JSON, no `profiles` list, nothing usable in it). Only what a profile of tasks.json
 * has always had moves — agent, model, data — so the migrated profile behaves exactly as before. An
 * entry that would not validate (a bad id, no `data`) is left out: tasks.json reports it on its own.
 */
export function profilesFromTasks(tasksText: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(tasksText);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw['profiles'])) return null;

  const carried: Record<string, unknown>[] = [];
  for (const entry of raw['profiles']) {
    if (!isRecord(entry)) continue;
    const { id, agent, model, data } = entry;
    if (typeof id !== 'string' || (data !== 'private' && data !== 'public')) continue;
    if (carried.some((profile) => profile['id'] === id)) continue;
    carried.push({
      id,
      ...(typeof agent === 'string' && agent.trim() ? { agent } : {}),
      ...(typeof model === 'string' && model.trim() ? { model } : {}),
      data,
    });
  }
  if (carried.length === 0) return null;

  const text = `${JSON.stringify({ version: 1, profiles: carried }, null, 2)}\n`;
  try {
    parseProfiles(text);
  } catch (error) {
    if (error instanceof ProfilesError) return null;
    throw error;
  }
  return text;
}
