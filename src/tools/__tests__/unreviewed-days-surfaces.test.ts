// Every surface that shows a training-derived number says when history is
// withheld (VW-489).
//
// The reviewer of #479 found that only `report.weekly` and the tier signal
// carried the count, so the goals page, the planning brief, goal proposals and
// the accountability message could all render a flat zero on a store with 21
// unreviewed days and give the lifter no way to tell "not yet reviewed" from
// "not yet trained". One read (`readUnreviewed`), so no two surfaces can
// disagree about how many days are waiting.

import { describe, expect, it } from 'vitest';

import { readUnreviewed } from '../../analytics/session-review.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

/** Two unreviewed local days, one of them holding two sessions. */
async function openUnreviewed(): Promise<SessionStore> {
  const store = openTestStore();
  const days: [string, string][] = [
    ['u1', '2026-09-07T15:00:00.000Z'],
    ['u2', '2026-09-07T16:00:00.000Z'],
    ['u3', '2026-09-10T15:00:00.000Z'],
  ];
  for (const [id, at] of days) {
    await store.putSession({ id, startedAt: at, endedAt: at, exerciseId: 'row' });
    await store.putSet({
      id: `${id}-set`,
      sessionId: id,
      userId: LOCAL_USER_ID,
      startedAt: at,
      endedAt: at,
      partial: false,
      weightLbs: 120,
      exerciseId: 'row',
      reps: [],
    });
  }
  return store;
}

describe('the one unreviewed read', () => {
  it('counts local days, not session rows, and names them newest first', async () => {
    const store = await openUnreviewed();

    const read = await readUnreviewed(store);

    expect(read.unreviewedDays).toBe(2);
    expect(read.unreviewedDayList).toEqual(['2026-09-10', '2026-09-07']);
    await store.close();
  });

  it('reports nothing waiting once every day is marked', async () => {
    const store = await openUnreviewed();
    await store.setSessionKind(['u1', 'u2', 'u3'], 'test');

    const read = await readUnreviewed(store);

    expect(read).toEqual({ unreviewedDays: 0, unreviewedDayList: [] });
    await store.close();
  });

  it('still reports a day whose sessions disagree, because half of it is unjudged', async () => {
    const store = await openUnreviewed();
    await store.setSessionKind(['u1'], 'training');

    const read = await readUnreviewed(store);

    expect(read.unreviewedDayList).toContain('2026-09-07');
    await store.close();
  });
});
