// Tests for the store-side MRV underperformance detector (VW-91 / B04).
//
// The judgement itself is tested in `@voltras/workout-analytics`
// (`mrv-underperformance.test.ts`). What is load-bearing HERE is the loading,
// the scoping, and — above all — that the drift guard is genuinely in the path:
// a detector that re-derived comparability of its own would eventually disagree
// with the gate, and fire on a pair the gate had refused.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BaselineKey, Phase } from '@voltras/workout-analytics';

import { checkMrvGuard, checkMrvUnderperformance } from '../mrv-guard.js';
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

interface RepShape {
  conSec: number;
  romM: number;
  velocityMps: number;
}

/**
 * A rep with an explicit concentric duration, ROM and mean velocity — the
 * tempo/ROM pair the drift guard reads, plus the velocity the MRV detector
 * reads. `_totalVelocity / _movementSampleCount` is how mean velocity is
 * derived, so one movement sample carrying the whole total gives it exactly.
 */
function makeRep(setId: string, index: number, shape: RepShape): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: start,
      endTime: start + shape.conSec * 1000,
      startPosition: 0,
      endPosition: shape.romM,
      _totalVelocity: shape.velocityMps,
      _movementSampleCount: 1,
    },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + shape.conSec * 1000,
      endTime: start + shape.conSec * 1000 + 2000,
      startPosition: shape.romM,
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
  opts: { repCount?: number; conSec?: number; romM?: number; velocityMps?: number } = {},
): StoredSet {
  const { repCount = 6, conSec = 1, romM = 0.5, velocityMps = 0.5 } = opts;
  return {
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: daysAgo(3),
    endedAt: daysAgo(3),
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: repCount }, (_, i) =>
      makeRep(overrides.id, i, { conSec, romM, velocityMps }),
    ),
    ...overrides,
  };
}

describe('checkMrvUnderperformance', () => {
  let store: SqliteSessionStore;
  const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  const check = async (): Promise<ReturnType<typeof checkMrvUnderperformance>> =>
    checkMrvUnderperformance(store, {
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

  it('reads no underperformance when both sessions did the same work', async () => {
    // Arrange
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.evaluable).toBe(true);
    expect(verdict.underperformed).toBe(false);
    expect(verdict.volumeLoadDeltaPct).toBe(0);
    expect(verdict.velocityDeltaPct).toBe(0);
  });

  it('flags a session that lost a third of its reps at the same load', async () => {
    // Arrange: 6 reps → 4 reps @ 100 lbs
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 4 }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.evaluable).toBe(true);
    expect(verdict.underperformed).toBe(true);
    expect(verdict.volumeLoadDeltaPct).toBeCloseTo(-33.33, 1);
  });

  it('honours the drift guard rather than re-deriving comparability', async () => {
    // Arrange: matched load with a clear volume-load decline (9 → 6 reps), both
    // sides well past the drift guard's rep floor, but the current session was
    // executed at a wildly different tempo and ROM — so the guard refuses the
    // pair outright. A detector doing its own comparability check would happily
    // fire here.
    await store.putSet(
      makeSet({ id: 'a', sessionId: 'sess-1' }, { repCount: 9, conSec: 1, romM: 0.6 }),
    );
    await store.putSet(
      makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 6, conSec: 3, romM: 0.3 }),
    );

    // Act
    const verdict = await check();

    // Assert: gated out, and the reason is the drift guard's, not a new one
    expect(verdict.evaluable).toBe(false);
    expect(verdict.underperformed).toBe(false);
    expect(verdict.reasoning).toContain('drift guard refused');
    expect(verdict.reasoning).toContain('too different to compare');
  });

  it('carries a soft-flagged drift verdict through as a caveat', async () => {
    // Arrange: +20 % tempo — inside the flagged band, so comparable but shaky —
    // alongside a real volume-load decline.
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }, { conSec: 1 }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 4, conSec: 1.2 }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.evaluable).toBe(true);
    expect(verdict.underperformed).toBe(true);
    expect(verdict.caveat).toContain('treat the result as a caveat');
  });

  it('ignores sets belonging to a different exercise in the same session', async () => {
    // Arrange: a heavy squat set shares sess-2 and would swamp the volume load
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));
    await store.putSet(
      makeSet({ id: 'c', sessionId: 'sess-2', exerciseId: 'back-squat', weightLbs: 315 }),
    );

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.volumeLoadDeltaPct).toBe(0);
    expect(verdict.underperformed).toBe(false);
  });

  it('excludes warm-ups, whose light load would deflate the median', async () => {
    // Arrange: the current session logged a 45 lb ramp-up set
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }));
    await store.putSet(
      makeSet({ id: 'w', sessionId: 'sess-2', isWarmup: true, weightLbs: 45 }, { repCount: 10 }),
    );

    // Act
    const verdict = await check();

    // Assert: the warm-up neither drops the median load nor inflates volume
    expect(verdict.evaluable).toBe(true);
    expect(verdict.volumeLoadDeltaPct).toBe(0);
  });

  it('narrows to one limb when the key names a side', async () => {
    // Arrange: left collapses, right holds
    await store.putSet(makeSet({ id: 'l1', sessionId: 'sess-1', side: 'left' }));
    await store.putSet(makeSet({ id: 'r1', sessionId: 'sess-1', side: 'right' }));
    await store.putSet(makeSet({ id: 'l2', sessionId: 'sess-2', side: 'left' }, { repCount: 3 }));
    await store.putSet(makeSet({ id: 'r2', sessionId: 'sess-2', side: 'right' }));

    // Act
    const left = await checkMrvUnderperformance(store, {
      key: { ...key, side: 'left' },
      baselineSessionId: 'sess-1',
      currentSessionId: 'sess-2',
    });
    const right = await checkMrvUnderperformance(store, {
      key: { ...key, side: 'right' },
      baselineSessionId: 'sess-1',
      currentSessionId: 'sess-2',
    });

    // Assert
    expect(left.underperformed).toBe(true);
    expect(left.volumeLoadDeltaPct).toBeCloseTo(-50, 1);
    expect(right.underperformed).toBe(false);
  });

  it('refuses to evaluate when the lifter simply used less weight', async () => {
    // Arrange: 100 → 80 lbs, and fewer reps besides
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2', weightLbs: 80 }, { repCount: 4 }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.evaluable).toBe(false);
    expect(verdict.reasoning).toContain('median load dropped');
  });

  it('reads no weight recorded as unmeasurable, not as a clean comparison', async () => {
    // Arrange: sess-2's sets never captured a header weight
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2', weightLbs: undefined }));

    // Act
    const verdict = await check();

    // Assert
    expect(verdict.evaluable).toBe(false);
    expect(verdict.underperformed).toBe(false);
    expect(verdict.reasoning).toContain('current session');
    expect(verdict.reasoning).toContain('no sets with recorded weight');
  });
});

describe('checkMrvGuard', () => {
  let store: SqliteSessionStore;
  const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    for (const s of ['sess-1', 'sess-2', 'sess-3']) {
      await store.putSession({ id: s, startedAt: daysAgo(3) });
    }
  });

  it('flags only when BOTH consecutive pairs underperformed', async () => {
    // Arrange: 6 → 4 → 3 reps at matched load — every step is a real decline
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 4 }));
    await store.putSet(makeSet({ id: 'c', sessionId: 'sess-3' }, { repCount: 3 }));

    // Act
    const result = await checkMrvGuard(store, {
      key,
      session1Id: 'sess-1',
      session2Id: 'sess-2',
      session3Id: 'sess-3',
    });

    // Assert
    expect(result.priorPair.underperformed).toBe(true);
    expect(result.currentPair.underperformed).toBe(true);
    expect(result.guard.mrvFlagged).toBe(true);
    expect(result.guard.reasoning).toContain('two consecutive sessions underperformed');
  });

  it('does not flag a single down session sandwiched between two solid ones', async () => {
    // Arrange: 6 → 4 (down) → 6 (recovered) — one bad session is noise
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'b', sessionId: 'sess-2' }, { repCount: 4 }));
    await store.putSet(makeSet({ id: 'c', sessionId: 'sess-3' }));

    // Act
    const result = await checkMrvGuard(store, {
      key,
      session1Id: 'sess-1',
      session2Id: 'sess-2',
      session3Id: 'sess-3',
    });

    // Assert
    expect(result.priorPair.underperformed).toBe(true);
    expect(result.currentPair.underperformed).toBe(false);
    expect(result.guard.mrvFlagged).toBe(false);
    expect(result.guard.reasoning).toContain('only one of the two sessions underperformed');
  });

  it('stays inconclusive rather than flagged when a pair could not be evaluated', async () => {
    // Arrange: sess-2 has no recorded sets at all, so the prior pair has no read
    await store.putSet(makeSet({ id: 'a', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'c', sessionId: 'sess-3' }, { repCount: 4 }));

    // Act
    const result = await checkMrvGuard(store, {
      key,
      session1Id: 'sess-1',
      session2Id: 'sess-2',
      session3Id: 'sess-3',
    });

    // Assert: never read a bare `false` from an absent evaluation
    expect(result.priorPair.evaluable).toBe(false);
    expect(result.guard.mrvFlagged).toBe(false);
    expect(result.guard.reasoning).toContain('inconclusive');
  });
});
