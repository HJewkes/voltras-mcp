// Tests for the store-side drift guard (VW-90 / B15).
//
// The judgement itself is tested in `@voltras/workout-analytics`
// (`drift-guard.test.ts`). What is load-bearing HERE is the loading and
// scoping: pull the wrong sets and a perfectly comparable pair of sessions
// reads as drifted, or — worse — a genuinely drifted pair reads as clean and
// the downstream detector fires on it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BaselineKey, Phase } from '@voltras/workout-analytics';

import { checkDriftGuard } from '../drift-guard.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSet } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/**
 * A rep with an explicit concentric duration and ROM — the only two things the
 * drift guard reads.
 */
function makeRep(setId: string, index: number, conSec: number, romM: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: start,
      endTime: start + conSec * 1000,
      startPosition: 0,
      endPosition: romM,
    },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + conSec * 1000,
      endTime: start + conSec * 1000 + 2000,
      startPosition: romM,
      endPosition: 0,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function makeSet(
  overrides: Partial<StoredSet> & { id: string; sessionId: string },
  opts: { repCount?: number; conSec?: number; romM?: number } = {},
): StoredSet {
  const { repCount = 6, conSec = 1, romM = 0.5 } = opts;
  return {
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: daysAgo(3),
    endedAt: daysAgo(3),
    partial: false,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(overrides.id, i, conSec, romM)),
    ...overrides,
  };
}

describe('checkDriftGuard', () => {
  let store: SqliteSessionStore;
  const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  const check = async (): Promise<ReturnType<typeof checkDriftGuard>> =>
    checkDriftGuard(store, {
      key,
      baselineSessionId: 'sess-1',
      currentSessionId: 'sess-2',
    });

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    for (const s of ['sess-1', 'sess-2']) {
      await store.putSession({ id: s, startedAt: daysAgo(3) });
    }
  });

  it('reports no drift when both sessions were executed the same way', async () => {
    // Arrange
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.comparable).toBe(true);
    expect(verdict.flagged).toBe(false);
    expect(verdict.tempoDriftPct).toBe(0);
    expect(verdict.romDriftPct).toBe(0);
  });

  it('refuses the comparison when the current session cut ROM by a third', async () => {
    // Arrange
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }, { romM: 0.6 }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { romM: 0.4 }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.comparable).toBe(false);
    expect(verdict.romDriftPct).toBeCloseTo(-33.33, 1);
  });

  it('pools every set of the exercise within a session', async () => {
    // Arrange: baseline session has two sets; the second is markedly slower, so
    // pooling them moves the median away from the first set's cadence.
    await store.putSet(makeSet({ id: 'a1', sessionId: 'sess-1' }, { conSec: 1 }));
    await store.putSet(makeSet({ id: 'a2', sessionId: 'sess-1' }, { conSec: 2 }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { conSec: 1 }));

    // Act
    const verdict = await check();

    // Assert: baseline median is 1.5 s vs 1.0 s current — a −33 % read
    expect(verdict.tempoDriftPct).toBeCloseTo(-33.33, 1);
  });

  it('ignores sets belonging to a different exercise in the same session', async () => {
    // Arrange: a squat set with wildly different execution shares sess-2
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));
    await store.putSet(
      makeSet({ id: 'c', sessionId: 'sess-2', exerciseId: 'back-squat' }, { conSec: 4, romM: 1.2 }),
    );

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.tempoDriftPct).toBe(0);
    expect(verdict.romDriftPct).toBe(0);
  });

  it('excludes warm-ups, which are performed at a different cadence by design', async () => {
    // Arrange: the current session's warm-up is slow and short-ROM
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));
    await store.putSet(
      makeSet({ id: 'w', sessionId: 'sess-2', isWarmup: true }, { conSec: 3, romM: 0.2 }),
    );

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.flagged).toBe(false);
    expect(verdict.tempoDriftPct).toBe(0);
  });

  it('narrows to one limb when the key names a side', async () => {
    // Arrange: left drifts hard, right does not
    await store.putSet(makeSet({ id: 'l1', sessionId: 'sess-1', side: 'left' }, { romM: 0.6 }));
    await store.putSet(makeSet({ id: 'r1', sessionId: 'sess-1', side: 'right' }, { romM: 0.5 }));
    await store.putSet(makeSet({ id: 'l2', sessionId: 'sess-2', side: 'left' }, { romM: 0.3 }));
    await store.putSet(makeSet({ id: 'r2', sessionId: 'sess-2', side: 'right' }, { romM: 0.5 }));

    // Act
    const left = await checkDriftGuard(store, {
      key: { ...key, side: 'left' },
      baselineSessionId: 'sess-1',
      currentSessionId: 'sess-2',
    });
    const right = await checkDriftGuard(store, {
      key: { ...key, side: 'right' },
      baselineSessionId: 'sess-1',
      currentSessionId: 'sess-2',
    });

    // Assert
    expect(left.comparable).toBe(false);
    expect(left.romDriftPct).toBeCloseTo(-50, 1);
    expect(right.comparable).toBe(true);
    expect(right.romDriftPct).toBe(0);
  });

  it('flags rather than blocks when a session has too few reps to read', async () => {
    // Arrange
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 2 }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.comparable).toBe(true);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasoning).toContain('insufficient reps');
  });

  it('refuses the comparison when a session has no qualifying reps at all', async () => {
    // Arrange: sess-2 recorded nothing for this exercise
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));

    // Act
    const verdict = await check();

    // Assert: an absent read is not evidence of comparability
    expect(verdict.comparable).toBe(false);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasoning).toContain('current session');
  });
});
