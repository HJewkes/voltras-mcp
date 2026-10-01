// The delivery emitter's per-set reads come from the slot's live state by set id.

import { describe, expect, it } from 'vitest';

import { LiveState, type ActiveSet } from '../../../state/live-state.js';
import { exerciseOf, lifterOf, repsOf, signalsOf } from '../set-lookups.js';
import { makeRep } from './proximity-fixtures.js';

const REPS = [1, 2, 3, 4].map((n) => makeRep(n, 0.8, 0.5));

function liveWith(set: Partial<ActiveSet>, sessionExercise?: string): LiveState {
  const live = new LiveState();
  live.startSession({
    sessionId: 'sess-lookups',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...(sessionExercise !== undefined ? { exerciseId: sessionExercise } : {}),
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId: 'set-1',
    sessionId: 'sess-lookups',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
    ...set,
  });
  return live;
}

describe('set lookups', () => {
  it("takes the exercise from the set's own snapshot before the session's", () => {
    const live = liveWith({ exerciseId: 'row' }, 'press');

    expect(exerciseOf(live, 'set-1')).toBe('row');
  });

  it("falls back to the session's exercise when the set carries none", () => {
    const live = liveWith({}, 'press');

    expect(exerciseOf(live, 'set-1')).toBe('press');
  });

  it('still finds a set after it closed, so the post-set debrief reads its reps', () => {
    const live = liveWith({ reps: REPS, lifter: 'Guest A' });
    live.endSet();

    expect(repsOf(live, 'set-1')).toHaveLength(REPS.length);
    expect(lifterOf(live, 'set-1')).toBe('Guest A');
  });

  it('returns no signals and no reps for a set the slot never held', () => {
    const live = liveWith({ reps: REPS });

    expect(signalsOf(live, 'set-other')).toEqual({});
    expect(repsOf(live, 'set-other')).toEqual([]);
  });

  it("passes the velocity-loss window's lead-in under eccentric overload, and none without it", () => {
    const watch = { notifyOn: [{ type: 'velocity_loss_exceeded' as const, pct: 25 }] };
    const plain = liveWith({ reps: REPS, watch });
    const overloaded = liveWith({ reps: REPS, watch });
    overloaded.applySettings({ eccentricPercentTenths: 200 });

    expect(signalsOf(plain, 'set-1')).toMatchObject({ leadInReps: 0, lossThresholdPct: 25 });
    expect(signalsOf(overloaded, 'set-1').leadInReps).toBeGreaterThan(0);
  });
});
