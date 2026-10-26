/**
 * Setting a profile's `configOptions` on a started session.
 *
 * Same rule as the model (ADR 0002 §5): an option the agent does not offer, or a value it does not
 * list, stops the run with a sentence. There is no fallback to another value — a thought level or mode
 * the person chose is part of what they asked for.
 */

import type { AcpClient, SessionConfigOption } from '@lotse/acp';

import { configValue, projectConfigOptions } from '../config.ts';
import type { ConfigOptionValue } from './profile.ts';

export class ProfileOptionError extends Error {
  readonly option: string;

  constructor(option: string, problem: string) {
    super(`the agent ${problem} for the profile's option "${option}", so the run stopped`);
    this.name = 'ProfileOptionError';
    this.option = option;
  }
}

/** Set each wanted option the session does not already have. Returns the options as they are after. */
export async function applyConfigOptions(
  client: AcpClient,
  sessionId: string,
  offered: SessionConfigOption[] | null,
  wanted: Readonly<Record<string, ConfigOptionValue>>,
): Promise<SessionConfigOption[] | null> {
  let current = offered;
  for (const [optionId, value] of Object.entries(wanted)) {
    const control = projectConfigOptions(current).find((candidate) => candidate.id === optionId);
    if (!control) throw new ProfileOptionError(optionId, 'does not offer the option');
    if (control.kind === 'switch') {
      if (typeof value !== 'boolean') throw new ProfileOptionError(optionId, 'takes only true or false');
      if (control.currentValue === value) continue;
    } else {
      if (typeof value !== 'string' || !control.values.some((candidate) => candidate.value === value)) {
        throw new ProfileOptionError(optionId, 'does not offer that value');
      }
      if (control.currentValue === value) continue;
    }
    const answer = await client.setConfigOption({
      sessionId,
      configId: control.id,
      value: configValue(control, value),
    });
    current =
      answer.configOptions ??
      (current ?? []).map((option) =>
        option.id === control.id ? { ...option, currentValue: value } : option,
      );
  }
  return current;
}
