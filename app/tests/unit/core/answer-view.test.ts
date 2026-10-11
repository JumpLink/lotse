/**
 * What the answer window shows, decided without a widget. Times are built in local time, because the
 * window prints local time.
 */

import { describe, expect, it } from '@gjsify/unit';

import type { Question } from '@lotse/core';

import { answerView, describeExpiry, timeLeft } from '../../../src/core/answer-view.ts';

const NOW = new Date(2026, 9, 11, 15, 20);

function question(patch: Partial<Question>): Question {
  return {
    id: 'A1',
    user: 'me',
    task: 'dependency-update',
    kind: 'reply',
    sessionId: 'ses_1',
    action: null,
    text: 'Bump oxlint now?',
    createdAt: new Date(2026, 9, 11, 15, 0).toISOString(),
    expiresAt: new Date(2026, 9, 11, 18, 40).toISOString(),
    status: 'open',
    answer: null,
    answeredAt: null,
    resolution: null,
    ...patch,
  };
}

export default async () => {
  await describe('timeLeft', async () => {
    await it('rounds down to minutes and drops a zero part', async () => {
      expect(timeLeft(30_000)).toBe('in under a minute');
      expect(timeLeft(5 * 60_000 + 59_000)).toBe('in 5 min');
      expect(timeLeft(2 * 3_600_000)).toBe('in 2 h');
      expect(timeLeft(3 * 3_600_000 + 20 * 60_000)).toBe('in 3 h 20 min');
    });
  });

  await describe('describeExpiry', async () => {
    await it('says when, and how long is left', async () => {
      expect(describeExpiry(new Date(2026, 9, 11, 18, 40).toISOString(), NOW)).toBe(
        'Expires at 18:40, in 3 h 20 min',
      );
    });

    await it('adds the date when it is not today', async () => {
      expect(describeExpiry(new Date(2026, 9, 12, 9, 5).toISOString(), NOW)).toBe(
        'Expires at 2026-10-12 09:05, in 17 h 45 min',
      );
    });

    await it('says when it expired, or that it cannot tell', async () => {
      expect(describeExpiry(new Date(2026, 9, 11, 14, 0).toISOString(), NOW)).toBe('Expired at 14:00');
      expect(describeExpiry('not a date', NOW)).toBe('Expiry unknown');
    });
  });

  await describe('answerView', async () => {
    await it('a reply question gets the text field and no quick replies', async () => {
      const view = answerView(question({}), 'A1', NOW);
      expect(view.title).toBe('Question #A1');
      expect(view.subtitle).toBe('from task dependency-update');
      expect(view.text).toBe('Bump oxlint now?');
      expect(view.entry).toBe(true);
      expect(view.quickReplies).toStrictEqual([]);
      expect(view.closed).toBeNull();
    });

    await it('a permission gets Decline, then the suggested Allow once, and no text field', async () => {
      const view = answerView(question({ id: 'A2', kind: 'permission' }), 'A2', NOW);
      expect(view.entry).toBe(false);
      expect(view.quickReplies).toStrictEqual([
        { text: 'no', label: 'Decline', suggested: false },
        { text: 'yes', label: 'Allow once', suggested: true },
      ]);
    });

    await it('an answered question says how, and offers nothing that sends', async () => {
      const view = answerView(
        question({ kind: 'permission', status: 'answered', answer: 'no', resolution: 'declined' }),
        'A1',
        NOW,
      );
      expect(view.entry).toBe(false);
      expect(view.quickReplies).toStrictEqual([]);
      expect(view.closed).toBe('#A1 is answered (declined); nothing waits for an answer any more.');
    });

    await it('an open question past its expiry counts as expired', async () => {
      const view = answerView(question({ expiresAt: new Date(2026, 9, 11, 14, 0).toISOString() }), 'A1', NOW);
      expect(view.entry).toBe(false);
      expect(view.closed).toBe('#A1 has expired; nothing waits for an answer any more.');
    });

    await it('an unknown id is named the way lotse questions names it', async () => {
      const view = answerView(null, '#a9', NOW);
      expect(view.title).toBe('Question #A9');
      expect(view.closed?.startsWith('There is no question #A9.')).toBe(true);
    });
  });
};
