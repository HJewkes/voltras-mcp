// Unit tests for `report.session_results` (src/tools/report-tools.ts).
//
// The rendering rules under test:
//   * one line per working set, warm-ups collapsed to a count
//   * a guest lifter's sets never appear in the owner's result
//   * a bilateral pair renders as L / R rows
//   * an attached rep band produces a `missed:` line, and no plan produces none
//
// `buildSessionResults` is exercised directly — it is the same function the
// tool callback and the outbox writer both call, so testing it covers all
// three entry points. The store is a hand-rolled stub: only five reads matter
// here and a full SQLite fixture would obscure which one each case depends on.

import { describe, it, expect } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSession,
  StoredSet,
} from '../../store/types.js';
import { buildSessionResults } from '../report-tools.js';

const SESSION_ID = 'session-1';
const ROW_ID = 'seated-row';
const CURL_ID = 'bayesian-curl';
/** Local noon, so the rendered `date` does not depend on the runner's zone. */
const ENDED_AT = new Date(2026, 8, 8, 12, 0, 0).toISOString();

interface Fixture {
  sets: StoredSet[];
  session?: Partial<StoredSession>;
  assignments?: StoredProgramAssignment[];
  planned?: StoredPlannedExercise[];
  adapter?: string;
}

function makeSet(overrides: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: SESSION_ID,
    startedAt: ENDED_AT,
    endedAt: ENDED_AT,
    partial: false,
    exerciseId: ROW_ID,
    reps: [],
    ...overrides,
  };
}

/** A set whose rep count comes from the firmware counter, like a real close. */
function workingSet(id: string, weightLbs: number, reps: number, extra: Partial<StoredSet> = {}) {
  return makeSet({ id, weightLbs, firmwareRepCount: reps, ...extra });
}

function makeState(fixture: Fixture): ServerState {
  const session: StoredSession = {
    id: SESSION_ID,
    startedAt: ENDED_AT,
    endedAt: ENDED_AT,
    ...fixture.session,
  };
  return {
    config: { adapter: fixture.adapter ?? 'node' },
    store: {
      getSession: () => Promise.resolve(session),
      getSetsForSession: () => Promise.resolve(fixture.sets),
      getAssignmentsForSession: () => Promise.resolve(fixture.assignments ?? []),
      getPlannedExercisesForTemplate: () => Promise.resolve(fixture.planned ?? []),
      getPlannedExercise: () => Promise.resolve(undefined),
    },
    exercises: {
      getById: (id: string) =>
        id === ROW_ID ? { id, name: 'Seated Row' } : { id, name: 'Bayesian Curl' },
    },
  } as unknown as ServerState;
}

describe('report.session_results', () => {
  it('renders one line per working set and collapses warm-ups to a count', async () => {
    // Arrange: three ramp-up sets flagged as warm-ups, then three at 170.
    const state = makeState({
      sets: [
        workingSet('w1', 70, 8, { isWarmup: true }),
        workingSet('w2', 100, 6, { isWarmup: true }),
        workingSet('w3', 139, 5, { isWarmup: true }),
        workingSet('s1', 170, 12),
        workingSet('s2', 170, 10),
        workingSet('s3', 170, 9),
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.date).toBe('2026-09-08');
    expect(results.exercises).toHaveLength(1);
    expect(results.exercises[0]?.exerciseName).toBe('Seated Row');
    expect(results.exercises[0]?.result).toBe(
      '170 lb x 12\n170 lb x 10\n170 lb x 9\nwarm-up: 3 sets',
    );
  });

  // VMCP-02.84 — the ramp now labels its rungs `setPurpose: 'warmup'`; the
  // count the coach reads must not change.
  it("counts setPurpose 'warmup' rows as warm-ups, and excludes a probe from both", async () => {
    const state = makeState({
      sets: [
        workingSet('w1', 70, 8, { setPurpose: 'warmup' }),
        workingSet('w2', 100, 6, { setPurpose: 'warmup' }),
        workingSet('p1', 185, 3, { setPurpose: 'probe' }),
        workingSet('s1', 170, 12),
        workingSet('s2', 170, 10),
      ],
    });

    const results = await buildSessionResults(state, SESSION_ID);

    expect(results.exercises[0]?.result).toBe('170 lb x 12\n170 lb x 10\nwarm-up: 2 sets');
  });

  // VMCP-02.74: a Band set never carries `weightLbs`, so it used to render as
  // a bare `12 reps` — indistinguishable from a set nobody recorded any
  // configuration for at all.
  it('labels a Band set by its own setting, not a missing weight', async () => {
    const state = makeState({
      sets: [
        makeSet({
          id: 's1',
          trainingMode: 'Resistance Band',
          firmwareRepCount: 12,
        }),
      ],
    });

    const results = await buildSessionResults(state, SESSION_ID);

    expect(results.exercises[0]?.result).toBe('band x 12');
  });

  it('keeps only the top-load sets when the ramp-up was never flagged', async () => {
    // Arrange: the same ramp-up as above, with nobody having set `isWarmup`.
    const state = makeState({
      sets: [
        workingSet('w1', 70, 8),
        workingSet('w2', 100, 6),
        workingSet('s1', 170, 12),
        workingSet('s2', 170, 10),
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert: an unflagged 70 lb ramp-up is not a 70 lb working set.
    expect(results.exercises[0]?.result).toBe('170 lb x 12\n170 lb x 10');
  });

  it("omits a guest lifter's sets from the owner's result", async () => {
    // Arrange: the owner's 170s plus a guest's heavier set on the same session.
    const state = makeState({
      sets: [
        workingSet('s1', 170, 12),
        workingSet('s2', 170, 10),
        workingSet('g1', 200, 8, { lifter: 'Jordan' }),
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert: the guest's 200 neither appears nor raises the top load.
    expect(results.exercises[0]?.result).toBe('170 lb x 12\n170 lb x 10');
  });

  it('renders a bilateral pair as L / R rows', async () => {
    // Arrange: one grouped effort, right side recorded first.
    const state = makeState({
      sets: [
        workingSet('r1', 30, 12, {
          exerciseId: CURL_ID,
          bilateralGroupId: 'pair-1',
          side: 'right',
        }),
        workingSet('l1', 30, 13, { exerciseId: CURL_ID, bilateralGroupId: 'pair-1', side: 'left' }),
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.exercises[0]?.result).toBe('L 30 lb x 13\nR 30 lb x 12');
  });

  it('reports how many working sets fell below an attached rep band', async () => {
    // Arrange: an 8-12 band attached via the session's workout template, and
    // one of three working sets at 6 reps.
    const state = makeState({
      sets: [workingSet('s1', 170, 12), workingSet('s2', 170, 9), workingSet('s3', 170, 6)],
      assignments: [
        { id: 'a1', sessionId: SESSION_ID, workoutTemplateId: 'tpl-1', assignedAt: ENDED_AT },
      ],
      planned: [
        {
          id: 'pe-1',
          workoutTemplateId: 'tpl-1',
          exerciseId: ROW_ID,
          orderIndex: 0,
          targetSets: 3,
          targetRepsLow: 8,
          targetRepsHigh: 12,
        },
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.exercises[0]?.result).toBe(
      '170 lb x 12\n170 lb x 9\n170 lb x 6\nmissed: 1 of 3 sets below 8 reps',
    );
  });

  it('emits no missed line when no plan is attached to the session', async () => {
    // Arrange: the same 6-rep set, with no program assignment.
    const state = makeState({
      sets: [workingSet('s1', 170, 12), workingSet('s2', 170, 9), workingSet('s3', 170, 6)],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.exercises[0]?.result).not.toContain('missed:');
  });

  it('excludes mock-adapter and zero-rep sets on the node adapter', async () => {
    // Arrange
    const state = makeState({
      sets: [
        workingSet('s1', 170, 12),
        workingSet('m1', 200, 10, { source: 'mock' }),
        workingSet('z1', 185, 0),
      ],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.exercises[0]?.result).toBe('170 lb x 12');
  });

  it('omits an exercise whose sets were all warm-ups', async () => {
    // Arrange
    const state = makeState({
      sets: [workingSet('w1', 70, 8, { isWarmup: true })],
    });

    // Act
    const results = await buildSessionResults(state, SESSION_ID);

    // Assert
    expect(results.exercises).toEqual([]);
  });
});
