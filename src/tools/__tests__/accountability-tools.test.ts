// Unit tests for `accountability.state` (src/tools/accountability-tools.ts).
//
// Uses a real `openTestStore()` so the persisted row and
// the migration-created table are the ones under test, not a stub's idea of
// them. `at` pins the dry-run instant, which is the only way to exercise the
// Sunday and Thursday branches without waiting for a Sunday.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_USER_ID } from '../../store/types.js';
import type { ServerState } from '../../state/server-state.js';
import type { AccountabilityState } from '../../accountability/types.js';
import {
  describeAccountabilityPreview,
  describeAccountabilityState,
} from '../accountability-tools.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

/** Local-time noon on days that are unambiguously that weekday in any timezone. */
const SUNDAY_NOON = '2026-09-13T12:00:00';
const THURSDAY_NOON = '2026-09-17T12:00:00';
const WEDNESDAY_NOON = '2026-09-16T12:00:00';

let store: SessionStore;

function makeState(): ServerState {
  return {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
}

function storedState(overrides: Partial<AccountabilityState> = {}): AccountabilityState {
  return {
    userId: LOCAL_USER_ID,
    state: 'planned',
    enteredAt: '2026-09-01T00:00:00.000Z',
    consecutiveMisses: 0,
    ghostSends: [],
    lastInboundAt: null,
    proactiveSends: [],
    holdingUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  store = openTestStore();
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

/** One unreviewed local day: a session nobody has marked, holding a working set. */
async function seedUnreviewedDay(): Promise<void> {
  const at = '2026-09-10T15:00:00.000Z';
  await store.putSession({ id: 'unreviewed', startedAt: at, endedAt: at });
  await store.putSet({
    id: 'unreviewed-set',
    sessionId: 'unreviewed',
    startedAt: at,
    endedAt: at,
    partial: false,
    reps: [],
  });
}

describe('accountability.state', () => {
  // VW-489: the message's counts exclude unreviewed history, so the read has to
  // say how much is being withheld or a zero reads as "he did not train".
  it('says how many past days are waiting on a review', async () => {
    await seedUnreviewedDay();

    const result = await describeAccountabilityState(makeState(), { at: WEDNESDAY_NOON });

    expect(result.unreviewedDays).toBe(1);
    expect(result.unreviewedDayList).toEqual(['2026-09-10']);
  });

  it('reports defaults and says they are not persisted when no row exists', async () => {
    const result = await describeAccountabilityState(makeState(), { at: WEDNESDAY_NOON });
    expect(result.persisted).toBe(false);
    expect(result.protocolState).toBe('planned');
    expect(result.tick).toBe('none');
    expect(result.decision).toMatchObject({ action: 'silent' });
    expect(result.decision.reason).toContain('no scheduled tick today');
  });

  it('round-trips the persisted row and counts the 7-day send window', async () => {
    await store.putAccountabilityState(
      storedState({
        state: 'missed',
        consecutiveMisses: 1,
        lastInboundAt: '2026-09-05T10:00:00.000Z',
        proactiveSends: [
          { at: '2026-09-01T18:00:00.000Z', kind: 'sunday_anchor' },
          { at: '2026-09-12T18:00:00.000Z', kind: 'miss_recovery' },
        ],
      }),
    );

    const result = await describeAccountabilityState(makeState(), { at: WEDNESDAY_NOON });
    expect(result.persisted).toBe(true);
    expect(result.protocolState).toBe('missed');
    expect(result.consecutiveMisses).toBe(1);
    expect(result.lastInboundAt).toBe('2026-09-05T10:00:00.000Z');
    // Only the 2026-09-12 send is inside the rolling window.
    expect(result.proactiveSendsInWindow).toBe(1);
  });

  it('dry-runs the Sunday anchor without writing anything', async () => {
    await store.putAccountabilityState(storedState());

    const result = await describeAccountabilityState(makeState(), { at: SUNDAY_NOON });
    expect(result.tick).toBe('sunday_anchor');
    expect(result.decision).toMatchObject({ action: 'send', kind: 'sunday_anchor' });

    const persisted = await store.getAccountabilityState(LOCAL_USER_ID);
    expect(persisted?.proactiveSends).toEqual([]);
    expect(persisted?.state).toBe('planned');
  });

  it('dry-runs the Thursday tick against the report.weekly trend, not a raw count', async () => {
    await store.putAccountabilityState(storedState());

    const result = await describeAccountabilityState(makeState(), { at: THURSDAY_NOON });
    expect(result.tick).toBe('thursday');
    // An empty store has no planned work, so `report.weekly` reports no
    // adherence at all — which is not a direction and must fire nothing.
    expect(result.adherenceTrend).toBeNull();
    expect(result.decision.action).toBe('silent');
  });

  it('reads the Thursday trend as of `at`, not the wall clock (VW-472)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T12:00:00'));
    await store.putAccountabilityState(storedState());
    await seedOneTemplatePlan();
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'after-at',
      startedAt: '2026-09-18T12:00:00',
      endedAt: '2026-09-18T12:30:00',
    });
    await store.putProgramAssignment({
      id: 'after-at-assignment',
      sessionId: 'after-at',
      workoutTemplateId: 'tpl',
      assignedAt: '2026-09-18T12:00:00',
    });

    const result = await describeAccountabilityState(makeState(), { at: THURSDAY_NOON });

    expect(result.tick).toBe('thursday');
    expect(result.adherenceTrend).toBeNull();
  });

  it('reads a miss entered on a Monday as the early-week trigger', async () => {
    await store.putAccountabilityState(
      storedState({ state: 'missed', consecutiveMisses: 1, enteredAt: '2026-09-14T12:00:00' }),
    );

    const result = await describeAccountabilityState(makeState(), { at: THURSDAY_NOON });
    expect(result.decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
    expect(result.decision.reason).toContain('early_week_miss');
  });
});

/** `count` ended sessions minutes apart on one local day: one visit logged per exercise. */
async function rowsOnOneDay(day: Date, count: number, prefix: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, i * 4);
    await seedTrainingDay(store, {
      kind: 'training',
      id: `${prefix}-${i}`,
      startedAt: start.toISOString(),
      endedAt: new Date(start.getTime() + 3 * 60_000).toISOString(),
    });
  }
}

/** The smallest plan tree `plan.next_workout` resolves, so the preview has something to render. */
async function seedOneTemplatePlan(): Promise<void> {
  await store.putTrainingProgram({
    id: 'prog',
    name: 'Base',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B1',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0 });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Full A', orderIndex: 0 });
}

describe('accountability.preview', () => {
  it('carries the unreviewed-day count even when it decides to stay silent', async () => {
    await seedUnreviewedDay();

    const result = await describeAccountabilityPreview(makeState(), { at: WEDNESDAY_NOON });

    expect(result.decision.action).not.toBe('send');
    expect(result.unreviewedDays).toBe(1);
  });

  it('reads the rolling line in training days, as of `at` (VW-462)', async () => {
    await store.putAccountabilityState(storedState());
    await seedOneTemplatePlan();
    await rowsOnOneDay(new Date(2026, 8, 7), 12, 'visit');
    await rowsOnOneDay(new Date(2026, 8, 15), 1, 'after-at');

    const result = await describeAccountabilityPreview(makeState(), { at: SUNDAY_NOON });

    expect(result.inputsUsed?.rolling28DayTrainingDays).toBe(1);
    expect(result.text).toContain('Rolling 28-day training days: 1.');
  });

  it('offers the planning sitting when no block is dated (VW-476)', async () => {
    await store.putAccountabilityState(storedState());
    await seedOneTemplatePlan();

    const result = await describeAccountabilityPreview(makeState(), { at: SUNDAY_NOON });

    expect(result.inputsUsed?.planning).toEqual({ reason: 'No block has dates yet.' });
    expect(result.text).toContain(
      'The next block is due to be planned: No block has dates yet. Pick a time this week',
    );
  });
});
