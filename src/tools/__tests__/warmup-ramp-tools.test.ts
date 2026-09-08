// Unit tests for `plan.warmup_ramp` (src/tools/warmup-ramp-tools.ts).
//
// What is actually under test:
//   * a cold muscle gets the full ramp, ascending and under the working load
//   * a muscle already warmed by an earlier exercise gets one feel set
//   * the tier changes the rung COUNT only
//   * `loadForReps` really is the inverse of the analytics package's forward
//     Epley estimate, not a lookalike formula
//
// The state is a hand-rolled stub in the style of report-tools.test.ts: the
// tool reads four things (the exercise catalog, the slot's session, that
// session's sets, and the tier signal) and a SQLite fixture would hide which
// one each case depends on.

import { describe, it, expect } from 'vitest';
import { estimateE1RMFromReps } from '@voltras/workout-analytics';
import type { ServerState } from '../../state/server-state.js';
import type { StoredSet } from '../../store/types.js';
import { DeviceSetWeightInput } from '../../schemas/device.js';
import { buildWarmupRamp, loadForReps, rampRows } from '../warmup-ramp-tools.js';

const SESSION_ID = 'session-1';
const AT = '2026-09-08T12:00:00.000Z';

const CATALOG: Record<string, { id: string; name: string; muscleGroups: string[] }> = {
  'chest-press': { id: 'chest-press', name: 'Chest Press', muscleGroups: ['chest', 'triceps'] },
  'chest-fly': { id: 'chest-fly', name: 'Chest Fly', muscleGroups: ['chest'] },
  'seated-row': { id: 'seated-row', name: 'Seated Row', muscleGroups: ['back', 'biceps'] },
  // A catalog entry with no muscle mapping — nothing can warm it.
  'cable-carry': { id: 'cable-carry', name: 'Cable Carry', muscleGroups: [] },
};

interface Fixture {
  sets?: StoredSet[];
  hasSession?: boolean;
  declaredTier?: string;
  sessionsLogged?: number;
}

function priorSet(id: string, exerciseId: string, extra: Partial<StoredSet> = {}): StoredSet {
  return {
    id,
    sessionId: SESSION_ID,
    startedAt: AT,
    endedAt: AT,
    partial: false,
    exerciseId,
    weightLbs: 100,
    reps: [{ id: `${id}-r0`, setId: id, index: 0 }] as unknown as StoredSet['reps'],
    ...extra,
  };
}

function makeState(fixture: Fixture = {}): ServerState {
  const live = { session: fixture.hasSession === false ? undefined : { sessionId: SESSION_ID } };
  return {
    slots: new Map([['primary', { slotId: 'primary', live }]]),
    exercises: { getById: (id: string) => CATALOG[id] },
    store: {
      getSetsForSession: () => Promise.resolve(fixture.sets ?? []),
      // Default to an intermediate signal: declared intermediate, and enough
      // logged history for the derived ceiling to admit it (tier-signal.ts).
      getTrainingProfile: () =>
        Promise.resolve({
          declaredTier: fixture.declaredTier ?? 'intermediate',
          everPlateaued: true,
        }),
      countSessions: () => Promise.resolve(fixture.sessionsLogged ?? 30),
      getSessionDateSpan: () =>
        Promise.resolve({ first: '2026-01-01T00:00:00.000Z', last: '2026-09-08T00:00:00.000Z' }),
    },
  } as unknown as ServerState;
}

describe('plan.warmup_ramp', () => {
  it('gives a cold muscle three ascending rungs, all below the working load', async () => {
    const ramp = await buildWarmupRamp(makeState(), {
      exerciseId: 'chest-press',
      workingWeightLbs: 100,
    });

    expect(ramp.feelSetOnly).toBe(false);
    expect(ramp.rows).toHaveLength(3);
    expect(ramp.rows.map((r) => r.reps)).toEqual([12, 8, 4]);
    const loads = ramp.rows.map((r) => r.weightLbs);
    expect(loads[0]).toBeLessThan(loads[1]!);
    expect(loads[1]).toBeLessThan(loads[2]!);
    expect(loads[2]).toBeLessThan(100);
    for (const load of loads) expect(Number.isInteger(load)).toBe(true);
    expect(ramp.rows.every((r) => r.setPurpose === 'warmup')).toBe(true);
    // Each rung carries its own focus, not one repeated string.
    expect(new Set(ramp.rows.map((r) => r.focus)).size).toBe(3);
  });

  // The mutation guard: rounding UP instead of down fails right here.
  it('derives the rung loads from the working weight, rounded DOWN to the device step', () => {
    // 100 lb read as a 5RM ⇒ e1RM 116.67; the 30/20/10RM loads are
    // 58.33 / 70.00 / 87.50, floored onto the 1 lb ladder.
    expect(rampRows(100, 'intermediate').map((r) => r.weightLbs)).toEqual([58, 70, 87]);
  });

  it('gives one feel set at the working load when the muscle is already warm', async () => {
    const state = makeState({ sets: [priorSet('s1', 'chest-fly')] });

    const ramp = await buildWarmupRamp(state, {
      exerciseId: 'chest-press',
      workingWeightLbs: 120,
    });

    expect(ramp.feelSetOnly).toBe(true);
    expect(ramp.rows).toHaveLength(1);
    expect(ramp.rows[0]?.weightLbs).toBe(120);
    expect(ramp.rows[0]?.reps).toBeGreaterThanOrEqual(3);
    expect(ramp.rows[0]?.reps).toBeLessThanOrEqual(6);
    expect(ramp.reason).toContain('Chest Fly');
  });

  it('an unrelated muscle group does not count as warm', async () => {
    const state = makeState({ sets: [priorSet('s1', 'seated-row')] });

    const ramp = await buildWarmupRamp(state, {
      exerciseId: 'chest-press',
      workingWeightLbs: 120,
    });

    expect(ramp.feelSetOnly).toBe(false);
    expect(ramp.rows).toHaveLength(3);
  });

  // A warm-up rung is the ramp we are deciding about; it cannot be the
  // evidence that the ramp is unnecessary.
  it("an earlier exercise's warm-up rung does not warm the muscle", async () => {
    const state = makeState({ sets: [priorSet('s1', 'chest-fly', { setPurpose: 'warmup' })] });

    const ramp = await buildWarmupRamp(state, {
      exerciseId: 'chest-press',
      workingWeightLbs: 120,
    });

    expect(ramp.feelSetOnly).toBe(false);
  });

  it('treats a slot with no session as a cold muscle', async () => {
    const ramp = await buildWarmupRamp(makeState({ hasSession: false }), {
      exerciseId: 'chest-press',
      workingWeightLbs: 100,
    });

    expect(ramp.feelSetOnly).toBe(false);
    expect(ramp.rows).toHaveLength(3);
  });

  it('widens the ramp for a beginner tier signal', async () => {
    const ramp = await buildWarmupRamp(makeState({ declaredTier: 'beginner' }), {
      exerciseId: 'chest-press',
      workingWeightLbs: 100,
    });

    expect(ramp.rows).toHaveLength(4);
    expect(ramp.reason).toContain('beginner');
  });

  it('gives the full ramp for an exercise with no muscle groups, without throwing', async () => {
    const state = makeState({ sets: [priorSet('s1', 'chest-fly')] });

    const ramp = await buildWarmupRamp(state, {
      exerciseId: 'cable-carry',
      workingWeightLbs: 100,
    });

    expect(ramp.feelSetOnly).toBe(false);
    expect(ramp.rows).toHaveLength(3);
    expect(ramp.reason).toContain('this session');
  });

  it('rejects an exercise the catalog does not know', async () => {
    await expect(
      buildWarmupRamp(makeState(), { exerciseId: 'nope', workingWeightLbs: 100 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('warm-up rung count by tier', () => {
  // Tier moves the COUNT only — the anchors, and so the loads, are shared.
  it('beginner gets one extra practice rung, advanced drops the lightest', () => {
    expect(rampRows(100, 'beginner')).toHaveLength(4);
    expect(rampRows(100, 'intermediate')).toHaveLength(3);
    expect(rampRows(100, 'advanced')).toHaveLength(2);
  });

  it("the beginner's extra rung repeats a load rather than inventing a percentage", () => {
    const beginner = rampRows(100, 'beginner').map((r) => r.weightLbs);
    const intermediate = rampRows(100, 'intermediate').map((r) => r.weightLbs);
    expect(new Set(beginner)).toEqual(new Set(intermediate));
    expect(beginner).toEqual([58, 70, 70, 87]);
  });

  it('advanced keeps the top two rungs of the intermediate ramp, renumbered', () => {
    const advanced = rampRows(100, 'advanced');
    expect(advanced.map((r) => r.order)).toEqual([1, 2]);
    expect(advanced.map((r) => [r.reps, r.weightLbs])).toEqual([
      [8, 70],
      [4, 87],
    ]);
  });
});

describe('loadForReps', () => {
  // The package publishes the forward Epley estimate and no inverse, so the
  // only thing keeping the two in the same formula is this round-trip.
  it('round-trips estimateE1RMFromReps within 1 lb across a table', () => {
    const cases: Array<[number, number]> = [
      [100, 1],
      [100, 4],
      [116.67, 10],
      [150, 8],
      [200, 12],
      [225, 20],
      [250, 30],
      [80, 3],
      [45, 15],
      [315, 5],
    ];
    for (const [e1rm, reps] of cases) {
      const load = loadForReps(e1rm, reps);
      expect(estimateE1RMFromReps(load, reps).e1RM).toBeCloseTo(e1rm, 1);
      expect(Math.abs(estimateE1RMFromReps(load, reps).e1RM - e1rm)).toBeLessThan(1);
    }
  });
});

describe('the device load step', () => {
  // The constants in warmup-ramp-tools.ts restate `device.set_weight`'s
  // contract; this fails the day that schema moves off integer pounds.
  it('matches what device.set_weight will accept', () => {
    expect(DeviceSetWeightInput.safeParse({ lbs: 5 }).success).toBe(true);
    expect(DeviceSetWeightInput.safeParse({ lbs: 4 }).success).toBe(false);
    expect(DeviceSetWeightInput.safeParse({ lbs: 58.5 }).success).toBe(false);
  });
});
