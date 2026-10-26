/**
 * Where a profile's messages go, and the notes `listen` prints at start about profiles.
 *
 * A profile decides it for every task and request that runs under it: the channels its messages may
 * use, and how much of a question the messenger gets.
 */

import { isFreeModel } from '../free-models.ts';
import type { ChannelName } from '../messenger/settings.ts';
import type { SkillTask } from '../task/skill.ts';
import type { Profile } from './profile.ts';

/** `full`: the question goes to the chat. `notice`: only that one waits, and where to read it. */
export type MessengerDetail = 'full' | 'notice';

export interface Delivery {
  /** `null`: every active channel. */
  readonly channels: readonly ChannelName[] | null;
  readonly messengerDetail: MessengerDetail;
}

/** The delivery of the profile `profileId`; an unknown or absent profile gets the defaults. */
export function deliveryOf(profiles: readonly Profile[], profileId?: string): Delivery {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return { channels: profile?.channels ?? null, messengerDetail: profile?.messengerDetail ?? 'full' };
}

/**
 * The delivery of the messages about `taskId`: that of the profile its SKILL.md binds it to. A task
 * that is not there (`@chat`, one removed since) gets the defaults.
 */
export function deliveryOfTask(
  source: {
    readonly profiles: readonly Profile[];
    readonly skill: (id: string) => SkillTask | null;
  },
  taskId: string,
): Delivery {
  let profile: string | undefined;
  try {
    const skill = source.skill(taskId);
    profile = skill
      ? (skill.profile ?? (source.profiles.length === 1 ? source.profiles[0]?.id : undefined))
      : undefined;
  } catch {
    profile = undefined;
  }
  return deliveryOf(source.profiles, profile);
}

/**
 * One sentence per private profile on a free model, for `listen` to print at start. A free model may be
 * unvetted for private data; choosing one is the person's call, so this informs and blocks nothing.
 */
export function freeModelNotes(profiles: readonly Profile[]): string[] {
  return profiles
    .filter((profile) => profile.data === 'private' && profile.model && isFreeModel(profile.model))
    .map(
      (profile) =>
        `profile "${profile.id}" is private and runs on the free model "${profile.model}" — your choice, noted`,
    );
}

/** One sentence per profile none of whose channels is active: its questions reach nobody. */
export function unreachableProfileNotes(
  profiles: readonly Profile[],
  active: readonly ChannelName[],
): string[] {
  return profiles.flatMap((profile) =>
    profile.channels && !profile.channels.some((name) => active.includes(name))
      ? [
          `profile "${profile.id}" may use only ${profile.channels.join(', ')}, which is not active — its questions are in \`lotse questions\` only`,
        ]
      : [],
  );
}
