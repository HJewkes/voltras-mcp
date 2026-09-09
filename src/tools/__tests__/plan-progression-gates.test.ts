// Rep-range routing (VMCP-06.01 / B24), the percent-of-load increment
// (VMCP-06.09 / B23) and the progression gates block (VMCP-06.07 / B07 v1) in
// `computeProgressionDelta`, plus the tier read that `plan.suggest_progression`
// performs on its behalf (VW-92 consumer 1 of 3).
//
// The routing and gate cases drive the exported pure function directly: it is
// store-free by design (VW-120), and `getTierSignal`'s ceiling cannot produce
// 'advanced' today, so tier variants are only reachable that way.
//
// The last case is end-to-end over a real in-memory store, because the point
// there is that the tier the tool reports came from the profile row a
// `profile.set_training_background` call wrote.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError, TrainingMode: {}, TrainingModeNames: {} };
});

const {
  computeProgressionDelta,
  computePercentIncrement,
  DEFAULT_PROGRESSION_CONTEXT,
  registerPlanTools,
} = await import('../plan-tools.js');
const { registerProfileTools } = await import('../profile-tools.js');

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number, peakVelocity: number): StoredRep {
  const rep = {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity },
    eccentric: { ...EMPTY_PHASE, peakVelocity: peakVelocity * 0.7 },
  } as Rep;
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

/**
 * `repCount` reps at a flat peak velocity (0% loss) unless `velocities` says
 * otherwise. `velocities: 'none'` models a set with no velocity telemetry at
 * all — every peak is 0, which is "nothing to judge", not "no fatigue".
 */
function setWithReps(setId: string, repCount: number, velocities?: number[] | 'none'): StoredSet {
  const peakFor = (i: number): number => {
    if (velocities === 'none') return 0;
    if (velocities === undefined) return 800;
    return velocities[i] ?? velocities[velocities.length - 1];
  };
  return {
    id: setId,
    sessionId: 'sess-prior',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:01:00.000Z',
    partial: false,
    weightLbs: 135,
    exerciseId: 'bench-press',
    reps: Array.from({ length: repCount }, (_, i) => makeRep(setId, i, peakFor(i))),
  } as StoredSet;
}

function plannedBand(repsLow: number, repsHigh: number): StoredPlannedExercise {
  return {
    id: `pe-${String(repsLow)}-${String(repsHigh)}`,
    workoutTemplateId: 'tmpl-1',
    exerciseId: 'bench-press',
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: repsLow,
    targetRepsHigh: repsHigh,
  };
}

/** Peak velocity decaying 1000 -> 500 over `repCount` reps: a 50% loss. */
function decayingVelocities(repCount: number): number[] {
  return Array.from({ length: repCount }, (_, i) => 1000 - (500 * i) / (repCount - 1));
}

const BASIS = 'sess-prior';

describe('computeProgressionDelta — B24 rep-range routing', () => {
  it('adds load when a sub-15-rep band is topped out at low velocity loss', () => {
    // Arrange: 8-12 band, three sets of 12, flat velocity.
    const sets = [1, 2, 3].map((n) => setWithReps(`s${String(n)}`, 12));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS);

    // Assert.
    expect(suggestion.delta).toBe(5);
    expect(suggestion.repDelta).toBe(0);
  });

  it('adds a rep, not load, when a 15-20 band is topped out at low velocity loss', () => {
    // Arrange: same shape, one band above the load ceiling.
    const sets = [1, 2, 3].map((n) => setWithReps(`s${String(n)}`, 20));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(15, 20), sets, BASIS);

    // Assert: the load holds and the rep moves, and the reasoning names the band.
    expect(suggestion.delta).toBe(0);
    expect(suggestion.repDelta).toBe(1);
    expect(suggestion.reasoning).toContain('15-20 reps');
  });

  it('routes by the boundary itself: a 14-rep top adds load, a 15-rep top adds a rep', () => {
    // Arrange: bands either side of REP_RANGE_LOAD_CEILING (15).
    const below = [1, 2, 3].map((n) => setWithReps(`b${String(n)}`, 14));
    const at = [1, 2, 3].map((n) => setWithReps(`a${String(n)}`, 15));

    // Act.
    const belowSuggestion = computeProgressionDelta(plannedBand(10, 14), below, BASIS);
    const atSuggestion = computeProgressionDelta(plannedBand(10, 15), at, BASIS);

    // Assert.
    expect(belowSuggestion).toMatchObject({ delta: 5, repDelta: 0 });
    expect(atSuggestion).toMatchObject({ delta: 0, repDelta: 1 });
  });

  it('holds both dials when either band is topped out at/over the velocity-loss ceiling', () => {
    // Arrange: 12 reps and 20 reps, both taken to a 50% intra-set velocity loss.
    const lowBand = [setWithReps('s1', 12, decayingVelocities(12))];
    const highBand = [setWithReps('s1', 20, decayingVelocities(20))];

    // Act.
    const low = computeProgressionDelta(plannedBand(8, 12), lowBand, BASIS);
    const high = computeProgressionDelta(plannedBand(15, 20), highBand, BASIS);

    // Assert: the VMCP-02.25 hold still overrides both branches.
    expect(low).toMatchObject({ delta: 0, repDelta: 0 });
    expect(high).toMatchObject({ delta: 0, repDelta: 0 });
    expect(low.gates.effort).toBe('hard');
    expect(high.gates.effort).toBe('hard');
  });

  it('leaves the missed and in-band branches on repDelta 0', () => {
    // Arrange: three sets under the 15-rep band, then three inside it.
    const missed = [1, 2, 3].map((n) => setWithReps(`m${String(n)}`, 12));
    const inBand = [1, 2, 3].map((n) => setWithReps(`i${String(n)}`, 17));

    // Act.
    const missedSuggestion = computeProgressionDelta(plannedBand(15, 20), missed, BASIS);
    const inBandSuggestion = computeProgressionDelta(plannedBand(15, 20), inBand, BASIS);

    // Assert.
    expect(missedSuggestion).toMatchObject({ delta: -5, repDelta: 0 });
    expect(inBandSuggestion).toMatchObject({ delta: 0, repDelta: 0 });
  });
});

// B23 (VMCP-06.09): `sources/mined/rp-university-idea-backlog.md` "### 14. B23"
// proposes replacing the fixed +5 lb step with a percent-of-load rule but
// states no percent (it explicitly discards RP's own sex-keyed default rather
// than quoting it), so the production constant is null and the fixed step is
// the only load-increment path today. `computePercentIncrement` tests below
// use an illustrative percent to exercise the rounding/floor/cap arithmetic in
// isolation — not a stand-in for a real cited value.
describe('computePercentIncrement — B23 arithmetic', () => {
  it('rounds a percent-of-load increment down to the device step', () => {
    // Arrange/Act: 200 lb top load at an illustrative 12%.
    const delta = computePercentIncrement(200, 12);

    // Assert: 200 * 0.12 = 24, already on the 1 lb device step.
    expect(delta).toBe(24);
  });

  it('floors the increment at the fixed step when the percent rounds below it', () => {
    // Arrange/Act: 20 lb top load at the same illustrative 12% -> 2.4 lb.
    const delta = computePercentIncrement(20, 12);

    // Assert: floored to the fixed +5 lb step.
    expect(delta).toBe(5);
  });

  it('caps the increment when a cap is supplied', () => {
    const delta = computePercentIncrement(500, 12, 5, 10);
    expect(delta).toBe(10);
  });
});

describe('computeProgressionDelta — B23 percent-of-load (null constant)', () => {
  it('stays on the fixed step and reports basis "fixed" for a heavy top load', () => {
    // Arrange: 8-12 band topped out at 200 lb, flat velocity.
    const sets = [1, 2, 3].map((n) => ({ ...setWithReps(`p${String(n)}`, 12), weightLbs: 200 }));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS);

    // Assert: the percent path never engages while the constant is null.
    expect(suggestion.delta).toBe(5);
    expect(suggestion.basis).toBe('fixed');
  });

  it('stays on the fixed step and reports basis "fixed" for a light top load', () => {
    // Arrange: same band, 20 lb top load.
    const sets = [1, 2, 3].map((n) => ({ ...setWithReps(`l${String(n)}`, 12), weightLbs: 20 }));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS);

    // Assert.
    expect(suggestion.delta).toBe(5);
    expect(suggestion.basis).toBe('fixed');
  });

  it('leaves the B24 rep branch unchanged at 15+ reps: no load increment applies', () => {
    // Arrange: 15-20 band topped out — B24 routes to +1 rep, not load.
    const sets = [1, 2, 3].map((n) => setWithReps(`r${String(n)}`, 20));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(15, 20), sets, BASIS);

    // Assert.
    expect(suggestion.delta).toBe(0);
    expect(suggestion.repDelta).toBe(1);
    expect(suggestion.basis).toBe('fixed');
  });

  it('yields the fixed +5 lb step and basis "fixed" for the explicit default context', () => {
    // Arrange: same as above, but passing DEFAULT_PROGRESSION_CONTEXT explicitly
    // rather than relying on the parameter default.
    const sets = [1, 2, 3].map((n) => ({ ...setWithReps(`e${String(n)}`, 12), weightLbs: 200 }));

    // Act.
    const suggestion = computeProgressionDelta(
      plannedBand(8, 12),
      sets,
      BASIS,
      DEFAULT_PROGRESSION_CONTEXT,
    );

    // Assert.
    expect(suggestion.delta).toBe(5);
    expect(suggestion.basis).toBe('fixed');
  });

  it('applies a percent-of-load increment when context.incrementPercent overrides the null default', () => {
    // Arrange: 8-12 band topped out at 200 lb. 12% is illustrative — proving
    // the injection path works, not a stand-in for a real cited B23 value.
    const sets = [1, 2, 3].map((n) => ({ ...setWithReps(`o${String(n)}`, 12), weightLbs: 200 }));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS, {
      ...DEFAULT_PROGRESSION_CONTEXT,
      incrementPercent: 12,
    });

    // Assert: 200 lb * 12% = 24 lb, already on the 1 lb device step.
    expect(suggestion.basis).toBe('percent');
    expect(suggestion.delta).toBe(24);
    expect(suggestion.reasoning).toContain('12% of 200 lb = 24 lb');
  });
});

describe('computeProgressionDelta — B07 gates', () => {
  it('unlocks sets for an intermediate whose hard sets topped the band out', () => {
    // Arrange: band topped out at a 50% velocity loss — hard sets, band hit.
    const sets = [1, 2].map((n) => setWithReps(`s${String(n)}`, 12, decayingVelocities(12)));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS, {
      tier: 'intermediate',
    });

    // Assert: the hold stands, with the set unlock advertised in the reasoning.
    expect(suggestion.gates.setsUnlocked).toBe(true);
    expect(suggestion.delta).toBe(0);
    expect(suggestion.reasoning).toContain('sets unlocked');
  });

  it('never unlocks sets for a beginner on the same hard, band-topping sets', () => {
    // Arrange: identical inputs to the intermediate case above.
    const sets = [1, 2].map((n) => setWithReps(`s${String(n)}`, 12, decayingVelocities(12)));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS, {
      tier: 'beginner',
    });

    // Assert: beginners progress load and technique, not sets.
    expect(suggestion.gates.effort).toBe('hard');
    expect(suggestion.gates.setsUnlocked).toBe(false);
    expect(suggestion.reasoning).not.toContain('sets unlocked');
  });

  it('never unlocks sets while the effort gate is not hard', () => {
    // Arrange: an advanced lifter topping the band out at a flat velocity.
    const sets = [1, 2, 3].map((n) => setWithReps(`s${String(n)}`, 12));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS, {
      tier: 'advanced',
    });

    // Assert.
    expect(suggestion.gates.effort).toBe('easy');
    expect(suggestion.gates.setsUnlocked).toBe(false);
  });

  it('calls a set at exactly the easy-loss threshold easy, and one just over it unknown', () => {
    // Arrange: 15% loss (1000 -> 850) is the cited "<=15%" boundary; 16%
    // (1000 -> 840) is the first loss past it, and short of the 25% hold.
    const at = [setWithReps('at', 12, [1000, 850])];
    const over = [setWithReps('over', 12, [1000, 840])];

    // Act.
    const atThreshold = computeProgressionDelta(plannedBand(8, 12), at, BASIS);
    const overThreshold = computeProgressionDelta(plannedBand(8, 12), over, BASIS);

    // Assert.
    expect(atThreshold.gates.effort).toBe('easy');
    expect(overThreshold.gates.effort).toBe('unknown');
  });

  it('reports effort unknown, and today’s delta, when no set carries velocity', () => {
    // Arrange: three band-topping sets whose reps recorded no velocity at all.
    const sets = [1, 2, 3].map((n) => setWithReps(`s${String(n)}`, 12, 'none'));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS);

    // Assert: no fatigue signal is not "easy" — and it does not block the +5.
    expect(suggestion.gates.effort).toBe('unknown');
    expect(suggestion.delta).toBe(5);
    expect(suggestion.repDelta).toBe(0);
  });

  it('leaves technique unknown, and unblocking, until VW-93 supplies it', () => {
    // Arrange.
    const sets = [1, 2, 3].map((n) => setWithReps(`s${String(n)}`, 12));

    // Act.
    const suggestion = computeProgressionDelta(plannedBand(8, 12), sets, BASIS);

    // Assert.
    expect(suggestion.gates.technique).toBe('unknown');
    expect(suggestion.delta).toBe(5);
  });

  it('never suggests more load or reps while technique is unstable', () => {
    // Arrange: the two branches that would otherwise progress, with the VW-93
    // technique input stubbed to 'unstable'.
    const loadBand = [1, 2, 3].map((n) => setWithReps(`l${String(n)}`, 12));
    const repBand = [1, 2, 3].map((n) => setWithReps(`r${String(n)}`, 20));

    // Act.
    const load = computeProgressionDelta(plannedBand(8, 12), loadBand, BASIS, {
      tier: 'intermediate',
      technique: 'unstable',
    });
    const reps = computeProgressionDelta(plannedBand(15, 20), repBand, BASIS, {
      tier: 'intermediate',
      technique: 'unstable',
    });

    // Assert.
    expect(load.delta).toBeLessThanOrEqual(0);
    expect(load.repDelta).toBe(0);
    expect(reps.delta).toBeLessThanOrEqual(0);
    expect(reps.repDelta).toBe(0);
    expect(load.reasoning).toContain('unstable');
  });
});

// ─── the tier read, end to end ─────────────────────────────────────────────

const PLAN_TOOLS = [
  'plan.program.create',
  'plan.program.list',
  'plan.program.get',
  'plan.program.archive',
  'plan.block.create',
  'plan.block.list_for_program',
  'plan.week.create',
  'plan.week.list_for_block',
  'plan.template.create',
  'plan.template.get',
  'plan.template.list_for_week',
  'plan.exercise.create',
  'plan.exercise.list_for_template',
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
];

const PROFILE_TOOLS = [
  'profile.set_training_background',
  'profile.get_training_background',
  'profile.get_tier_signal',
  'profile.get_starting_prescription',
  'profile.get_onboarding_gaps',
];

interface FakeTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(u: { callback: FakeTool['callback'] }): void;
  remove(): void;
}

function fakePlaceholders(names: readonly string[]): {
  placeholders: Map<string, FakeTool>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
} {
  const placeholders = new Map<string, FakeTool>();
  for (const name of names) {
    const tool: FakeTool = {
      update(u) {
        tool.callback = u.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (cb === undefined) throw new Error(`no callback installed for ${name}`);
      const result = await cb(args);
      return JSON.parse(result.content[0]!.text) as unknown;
    },
  };
}

describe('plan.suggest_progression — tier read', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  async function seedPlanAndSession(): Promise<void> {
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Tier',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 4,
    });
    await store.putTrainingWeek({
      id: 'week-1',
      blockId: 'block-1',
      orderIndex: 0,
      weekIndex: 0,
      isDeload: false,
    });
    await store.putWorkoutTemplate({ id: 'tmpl-1', weekId: 'week-1', orderIndex: 0, name: 'Full' });
    await store.putPlannedExercise(plannedBand(8, 12));
    await store.putSession({
      id: BASIS,
      startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-01T01:00:00.000Z',
      exerciseId: 'bench-press',
    });
    for (const n of [1, 2, 3]) {
      await store.putSet({ ...setWithReps(`s${String(n)}`, 12), userId: LOCAL_USER_ID });
    }
  }

  it('reports the declared beginner tier alongside the suggestion', async () => {
    // Arrange: a lifter who declared themselves a beginner, and one prior
    // session of the exercise to progress from.
    await seedPlanAndSession();
    const state = { store, slots: new Map() } as unknown as ServerState;
    const plan = fakePlaceholders(PLAN_TOOLS);
    const profile = fakePlaceholders(PROFILE_TOOLS);
    registerPlanTools({} as never, state, plan.placeholders as never);
    registerProfileTools({} as never, state, profile.placeholders as never);
    await profile.invoke('profile.set_training_background', { declaredTier: 'beginner' });

    // Act.
    const res = (await plan.invoke('plan.suggest_progression', {
      exerciseId: 'bench-press',
    })) as {
      suggestion: {
        delta: number;
        repDelta: number;
        gates: { technique: string; effort: string; setsUnlocked: boolean };
        tier: { tier: string; confidence: string; source: string };
      };
    };

    // Assert.
    expect(res.suggestion.tier).toMatchObject({ tier: 'beginner', source: 'declared' });
    expect(res.suggestion.gates).toMatchObject({ technique: 'unknown', setsUnlocked: false });
    expect(res.suggestion.repDelta).toBe(0);
  });
});
