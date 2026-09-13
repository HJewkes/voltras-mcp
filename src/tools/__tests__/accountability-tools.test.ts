// Unit tests for `accountability.state` (src/tools/accountability-tools.ts).
//
// Uses a real `SqliteSessionStore.open(':memory:')` so the persisted row and
// the migration-created table are the ones under test, not a stub's idea of
// them. `at` pins the dry-run instant, which is the only way to exercise the
// Sunday and Thursday branches without waiting for a Sunday.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import type { ServerState } from '../../state/server-state.js';
import type { AccountabilityState } from '../../accountability/types.js';
import { describeAccountabilityState } from '../accountability-tools.js';

/** Local-time noon on days that are unambiguously that weekday in any timezone. */
const SUNDAY_NOON = '2026-09-13T12:00:00';
const THURSDAY_NOON = '2026-09-17T12:00:00';
const WEDNESDAY_NOON = '2026-09-16T12:00:00';

let store: SqliteSessionStore;

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
  store = SqliteSessionStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

describe('accountability.state', () => {
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

  it('reads a miss entered on a Monday as the early-week trigger', async () => {
    await store.putAccountabilityState(
      storedState({ state: 'missed', consecutiveMisses: 1, enteredAt: '2026-09-14T12:00:00' }),
    );

    const result = await describeAccountabilityState(makeState(), { at: THURSDAY_NOON });
    expect(result.decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
    expect(result.decision.reason).toContain('early_week_miss');
  });
});
