// `sessions_28d` counts training days, not stored session rows (VW-460). The
// owner's ruling: "One per training day". These cases run derivation and the
// goals route over a real sqlite store, so the store read, the window and the
// day rule are all exercised together. VW-462 adds the layoff read, which counts
// training days since a gap through the same rule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blockEndsAt } from '../../analytics/goal-block-weeks.js';
import { localDate, readTrainingDays } from '../../analytics/training-days.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';
import { deriveTarget, readDerivationContext, selectionOf } from '../../tools/goal-derivation.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 28 * DAY_MS;
const NOW = new Date(2026, 8, 19, 18, 0);

let store: SessionStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store = openTestStore();
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
});

let seq = 0;
async function ended(startedAt: Date, over: { lifter?: string; open?: boolean } = {}) {
  const start = startedAt.toISOString();
  await store.putSession({
    kind: 'training',
    id: `s-${++seq}`,
    startedAt: start,
    ...(over.open === true
      ? {}
      : { endedAt: new Date(startedAt.getTime() + 60_000).toISOString() }),
    ...(over.lifter === undefined ? {} : { lifter: over.lifter }),
  });
  // VW-489: a session with no working set is not a training day, so every
  // fixture that means "he trained" has to hold one.
  await store.putSet({
    id: `set-${seq}`,
    sessionId: `s-${seq}`,
    startedAt: start,
    endedAt: new Date(startedAt.getTime() + 30_000).toISOString(),
    partial: false,
    reps: [],
    ...(over.lifter === undefined ? {} : { lifter: over.lifter }),
  });
}

/** The owner's 2026-09-07: twelve rows over one visit to the gym. */
async function twelveRowsOn(day: Date): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await ended(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, i * 4));
  }
}

async function sessionsPriority(): Promise<StoredPriority> {
  return store.putPriority({
    id: 'pri-sessions',
    userId: LOCAL_USER_ID,
    horizonWeeks: 8,
    kind: 'muscle',
    ref: 'sessions',
    level: 'maintain',
    declaredAt: NOW.toISOString(),
    mesosHeld: 0,
  });
}

function sessionsTarget(committed: number): StoredGoalTarget {
  const at = new Date(NOW.getTime() - 7 * DAY_MS).toISOString();
  return {
    id: 'tgt-sessions',
    priorityId: 'pri-sessions',
    metric: 'sessions_28d',
    startValue: committed,
    startMeasuredAt: at,
    bandLowPctPerWeek: 0,
    bandHighPctPerWeek: 0,
    committedValue: committed,
    stretchValue: committed,
    basis: 'execution_ramp',
    infoLevel: 'cold',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: at,
    endsAt: blockEndsAt(at, 8),
  };
}

describe('the training-day count', () => {
  it('counts twelve ended session rows on one day as one training day', async () => {
    await twelveRowsOn(new Date(2026, 8, 7));

    const days = await readTrainingDays(store, NOW.toISOString());

    expect(days).toEqual(['2026-09-07']);
  });

  it('counts a session that started exactly 28 days before now', async () => {
    const edge = new Date(NOW.getTime() - WINDOW_MS);
    await ended(edge);

    const days = await readTrainingDays(store, NOW.toISOString());

    expect(days).toEqual([localDate(new Date(edge.getTime() + 60_000).toISOString())]);
  });

  it('does not count a session that started a millisecond before the window opens', async () => {
    await ended(new Date(NOW.getTime() - WINDOW_MS - 1));

    expect(await readTrainingDays(store, NOW.toISOString())).toEqual([]);
  });

  it('does not count a guest’s day', async () => {
    await ended(new Date(2026, 8, 11, 9), { lifter: 'guest' });

    expect(await readTrainingDays(store, NOW.toISOString())).toEqual([]);
  });

  // VW-489. The owner's store holds 24 sessions nobody ever ended, between them
  // 41 sets. A workout he actually did and forgot to close is still a day he
  // trained, so it counts, on the local date its last set ended.
  it('counts a session that was never ended, by its last set’s end', async () => {
    await ended(new Date(2026, 8, 10, 9), { open: true });

    expect(await readTrainingDays(store, NOW.toISOString())).toEqual(['2026-09-10']);
  });

  it('does not count a session with no working set, ended or not', async () => {
    await store.putSession({
      kind: 'training',
      id: 'empty',
      startedAt: new Date(2026, 8, 12, 9).toISOString(),
      endedAt: new Date(2026, 8, 12, 9, 1).toISOString(),
    });

    expect(await readTrainingDays(store, NOW.toISOString())).toEqual([]);
  });

  // The rule the whole task turns on: unreviewed history is not evidence.
  it('does not count a session nobody has marked, nor one marked test', async () => {
    await store.putSession({
      id: 'unreviewed',
      startedAt: new Date(2026, 8, 13, 9).toISOString(),
      endedAt: new Date(2026, 8, 13, 10).toISOString(),
    });
    await store.putSet({
      id: 'unreviewed-set',
      sessionId: 'unreviewed',
      startedAt: new Date(2026, 8, 13, 9).toISOString(),
      endedAt: new Date(2026, 8, 13, 9, 1).toISOString(),
      partial: false,
      reps: [],
    });
    await ended(new Date(2026, 8, 14, 9));
    await store.setSessionKind([`s-${seq}`], 'test');

    expect(await readTrainingDays(store, NOW.toISOString())).toEqual([]);
  });
});

describe('sessions_28d derivation', () => {
  it('commits to the training days of the last 28 days, not the session rows', async () => {
    await twelveRowsOn(new Date(2026, 8, 7));
    await ended(new Date(2026, 8, 14, 9));
    const priority = await sessionsPriority();
    const context = await readDerivationContext({ store }, priority);

    const derived = await deriveTarget({ store }, context, selectionOf(sessionsTarget(0)));

    expect('band' in derived && derived.band.committedValue).toBe(2);
  });
});

describe('sessions_28d on the goals route', () => {
  it('counts the window that ends at the view’s now, not the clock’s', async () => {
    await ended(new Date(NOW.getTime() - 40 * DAY_MS));
    await ended(new Date(NOW.getTime() - 35 * DAY_MS));
    await ended(new Date(NOW.getTime() - DAY_MS));
    const priority = await sessionsPriority();
    await store.putGoalTarget(sessionsTarget(2));
    const viewNow = new Date(NOW.getTime() - 20 * DAY_MS);

    const [view] = await fetchGoalProgressViews(store, priority, viewNow);

    expect(view?.actuals).toEqual([
      { ts: viewNow.toISOString(), value: 2, matched: true, isPR: false },
    ]);
  });
});

describe('the layoff read (VW-462)', () => {
  async function layoffAfterGap(): Promise<boolean> {
    await ended(new Date(NOW.getTime() - 200 * DAY_MS));
    const context = await readDerivationContext({ store }, await sessionsPriority());
    return context.layoff;
  }

  it('keeps a lifter in the return meso after one day of twelve sessions', async () => {
    await twelveRowsOn(new Date(NOW.getTime() - 10 * DAY_MS));

    expect(await layoffAfterGap()).toBe(true);
  });

  it('ends the return meso after twelve distinct training days', async () => {
    for (let i = 0; i < 12; i++) await ended(new Date(NOW.getTime() - (30 - 2 * i) * DAY_MS));

    expect(await layoffAfterGap()).toBe(false);
  });

  it('sees the newest gap behind more than 500 earlier sessions (VW-472)', async () => {
    for (let i = 0; i < 520; i++) await ended(new Date(NOW.getTime() - (800 - i) * DAY_MS));
    for (let i = 0; i < 3; i++) await ended(new Date(NOW.getTime() - (10 - i) * DAY_MS));

    const context = await readDerivationContext({ store }, await sessionsPriority());

    expect(context.layoff).toBe(true);
  });
});

describe('a guest’s training days', () => {
  it('reads the named lifter’s days instead of the owner’s', async () => {
    await ended(new Date(2026, 8, 10, 9));
    await ended(new Date(2026, 8, 11, 9), { lifter: 'guest' });

    const days = await readTrainingDays(store, NOW.toISOString(), { lifter: 'guest' });

    expect(days).toEqual(['2026-09-11']);
  });
});
