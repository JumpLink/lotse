/** `30m`, `2h`, `1d` → milliseconds. Anything else, including zero, is `null`. */

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*([mhd])$/.exec(text.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return count * UNITS[match[2]!]!;
}
