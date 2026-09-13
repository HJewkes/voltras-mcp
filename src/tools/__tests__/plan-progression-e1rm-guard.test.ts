// VW-267: an estimated 1RM never moves the load.
//
// No gate in `computeProgressionDelta` reads an e1RM today — this file is the
// guard that keeps it that way. Two sessions of the same exercise, identical
// against every gate the heuristic actually reads (same rep count against the
// same band, same flat velocity, same ROM), differing only in load: 135 lb and
// 145 lb for 10 reps. The Epley estimate those produce is 180.0 and 193.3 lb,
// a 7.4% jump — inside the 9.8% pooled standard error, so it is estimation
// noise and not evidence of anything.
//
// If someone later routes an e1RM into a gate, the heavier session's delta
// stops matching the lighter one's and these cases fail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';
import { estimateE1RMFromReps } from '@voltras/workout-analytics';

import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../store/types.js';
import { E1RM_SEE_PCT, withinE1RMBand } from '../e1rm-band.js';

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

const { computeProgressionDelta, registerPlanTools } = await import('../plan-tools.js');

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

const EXERCISE_ID = 'bench-press';
const REPS_PER_SET = 10;
const LIGHT_LOAD_LBS = 135;
const HEAVY_LOAD_LBS = 145;

function makeRep(setId: string, index: number): StoredRep {
  const rep = {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 800 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 560 },
  } as Rep;
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

/** Identical against every gate the heuristic reads; only the load differs. */
function setAtLoad(sessionId: string, setId: string, weightLbs: number): StoredSet {
  return {
    id: setId,
    sessionId,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:01:00.000Z',
    partial: false,
    weightLbs,
    exerciseId: EXERCISE_ID,
    reps: Array.from({ length: REPS_PER_SET }, (_, i) => makeRep(setId, i)),
  } as StoredSet;
}

function sessionSets(sessionId: string, weightLbs: number): StoredSet[] {
  return [1, 2, 3].map((n) => setAtLoad(sessionId, `${sessionId}-s${String(n)}`, weightLbs));
}

const PLANNED: StoredPlannedExercise = {
  id: 'pe-8-12',
  workoutTemplateId: 'tmpl-1',
  exerciseId: EXERCISE_ID,
  orderIndex: 0,
  targetSets: 3,
  targetRepsLow: 8,
  targetRepsHigh: 12,
};

const LIGHT_E1RM = estimateE1RMFromReps(LIGHT_LOAD_LBS, REPS_PER_SET).e1RM;
const HEAVY_E1RM = estimateE1RMFromReps(HEAVY_LOAD_LBS, REPS_PER_SET).e1RM;

describe('plan.suggest_progression — a single-session e1RM jump moves nothing (VW-267)', () => {
  it('places the two sessions inside the pooled error band', () => {
    // Arrange / Act: the fixture's own premise, asserted rather than assumed.
    const jumpPct = (100 * (HEAVY_E1RM - LIGHT_E1RM)) / LIGHT_E1RM;

    // Assert.
    expect(jumpPct).toBeGreaterThan(0);
    expect(jumpPct).toBeLessThan(E1RM_SEE_PCT);
    expect(withinE1RMBand(LIGHT_E1RM, HEAVY_E1RM)).toBe(true);
  });

  it('suggests the same delta from the heavier session as from the lighter one', () => {
    // Arrange: same reps, same band, same velocity — only the load differs.
    const light = sessionSets('sess-light', LIGHT_LOAD_LBS);
    const heavy = sessionSets('sess-heavy', HEAVY_LOAD_LBS);

    // Act.
    const fromLight = computeProgressionDelta(PLANNED, light, 'sess-light');
    const fromHeavy = computeProgressionDelta(PLANNED, heavy, 'sess-heavy');

    // Assert: the rep band was met but not topped out, so both hold.
    expect(fromLight.delta).toBe(0);
    expect(fromHeavy.delta).toBe(fromLight.delta);
    expect(fromHeavy.repDelta).toBe(fromLight.repDelta);
    expect(fromHeavy.gates).toEqual(fromLight.gates);
  });

  it('never cites an estimated 1RM in the reasoning it gives', () => {
    // Arrange / Act.
    const suggestion = computeProgressionDelta(
      PLANNED,
      sessionSets('sess-heavy', HEAVY_LOAD_LBS),
      'sess-heavy',
    );

    // Assert.
    expect(suggestion.reasoning.toLowerCase()).not.toContain('1rm');
  });
});

// ─── the same guard, end to end over a real store ──────────────────────────

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

interface FakeTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(u: { callback: FakeTool['callback'] }): void;
  remove(): void;
}

function fakePlaceholders(): {
  placeholders: Map<string, FakeTool>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
} {
  const placeholders = new Map<string, FakeTool>();
  for (const name of PLAN_TOOLS) {
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
      return JSON.parse((await cb(args)).content[0]!.text) as unknown;
    },
  };
}

interface SuggestionResponse {
  suggestion: { delta: number; repDelta: number; reasoning: string };
}

describe('plan.suggest_progression — e1RM jump, end to end (VW-267)', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  async function seedPlan(): Promise<void> {
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'e1RM guard',
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
    await store.putPlannedExercise(PLANNED);
  }

  async function seedSession(sessionId: string, weightLbs: number): Promise<void> {
    await store.putSession({
      id: sessionId,
      startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-01T01:00:00.000Z',
      exerciseId: EXERCISE_ID,
    });
    for (const set of sessionSets(sessionId, weightLbs)) {
      await store.putSet({ ...set, userId: LOCAL_USER_ID });
    }
  }

  async function suggestFor(sessionId: string): Promise<SuggestionResponse> {
    const state = { store, slots: new Map() } as unknown as ServerState;
    const plan = fakePlaceholders();
    registerPlanTools({} as never, state, plan.placeholders as never);
    return (await plan.invoke('plan.suggest_progression', {
      exerciseId: EXERCISE_ID,
      completedSessionId: sessionId,
    })) as SuggestionResponse;
  }

  it('returns the same hold whichever of the two sessions is the basis', async () => {
    // Arrange: two sessions whose e1RM differs by less than the error band.
    await seedPlan();
    await seedSession('sess-light', LIGHT_LOAD_LBS);
    await seedSession('sess-heavy', HEAVY_LOAD_LBS);

    // Act.
    const light = await suggestFor('sess-light');
    const heavy = await suggestFor('sess-heavy');

    // Assert.
    expect(light.suggestion.delta).toBe(0);
    expect(heavy.suggestion.delta).toBe(0);
    expect(heavy.suggestion.reasoning).toBe(light.suggestion.reasoning);
  });
});
