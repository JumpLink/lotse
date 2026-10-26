/**
 * Which speech engines a profile or a host allows (ADR 0009, decision 4).
 *
 * Like `narrowRights` and `ModelPolicy`, a policy only narrows: the profile asks for a limit, the host
 * may add its own, and the narrower one wins. A host that says `local-only` is not widened by a profile
 * that says `any`.
 */

/** `any`: local and cloud engines. `local-only`: engines on this machine. `off`: no speech at all. */
export type VoicePolicy = 'any' | 'local-only' | 'off';

const ORDER: readonly VoicePolicy[] = ['any', 'local-only', 'off'];

export function isVoicePolicy(value: unknown): value is VoicePolicy {
  return typeof value === 'string' && (ORDER as readonly string[]).includes(value);
}

/** The narrower of two limits; `null` means no limit, so the other one stands. */
export function narrowVoice(a: VoicePolicy | null, b: VoicePolicy | null): VoicePolicy | null {
  if (a === null) return b;
  if (b === null) return a;
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}
