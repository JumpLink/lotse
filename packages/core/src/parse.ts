/**
 * The small checks every hand-edited JSON file of lotse shares — the task file and the profiles file.
 *
 * Each pushes a sentence onto `problems` and returns a harmless value, so a parser can go on and list
 * every problem of a file at once instead of stopping at the first.
 */

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object with only the keys the schema names; an unknown key is a problem, not silently dropped. */
export function object(
  value: unknown,
  where: string,
  problems: string[],
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${where} has unknown key "${key}"`);
  }
  return value;
}

export function list(value: unknown, where: string, problems: string[]): unknown[] {
  if (!Array.isArray(value)) {
    problems.push(`"${where}" must be a list`);
    return [];
  }
  return value;
}

export function isId(value: string): boolean {
  return ID.test(value);
}

export function id(value: unknown, where: string, problems: string[]): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    problems.push(`${where}.id must be lowercase letters, digits, "-" or "_" (at most 40)`);
    return '';
  }
  return value;
}

export function optionalString(value: unknown, where: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where} must be a non-empty string`);
    return null;
  }
  return value;
}

export function duplicates(items: readonly { id: string }[], what: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) problems.push(`${what} "${item.id}" is defined twice`);
    seen.add(item.id);
  }
}
