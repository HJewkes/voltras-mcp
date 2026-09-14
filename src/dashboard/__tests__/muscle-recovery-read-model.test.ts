// Unit tests for the muscle-recovery read-model (VW-332, B5 of the body-map plan).
//
// Pure shaping only — no store, no HTTP. Covers: the recovery performance
// benchmark against the previous COMPARABLE session (matched, fell short, and
// each of the three null paths), the entry-depression read coming from the last
// session and no other, `daysSince`, every titan slug being present, and the
// executable form of the "no recovery window" constraint.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import {
  buildMuscleRecoveryView,
  type MuscleRecoveryRows,
} from '../read-models/muscle-recovery.js';
import { buildFatigueAxesLookup } from '../read-models/muscle-recovery-fatigue.js';
import { MUSCLE_MAP_VERSION, TITAN_MUSCLE_GROUPS } from '../../exercises/muscle-map.js';
import type { StoredSession, StoredSet } from '../../store/types.js';

const NOW = new Date('2026-07-10T12:00:00.000Z');

const CATALOG = [
  {
    id: 'chest-press',
    name: 'Chest Press',
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['triceps'],
  },
  { id: 'cable-row', name: 'Cable Row', muscleGroups: ['back'] },
];

const catalog: MuscleRecoveryRows['catalog'] = (id) => CATALOG.find((e) => e.id === id);

/** No axis reading for any pair — the default for cases that are not about fatigue. */
const noFatigue: MuscleRecoveryRows['fatigueBySession'] = () => undefined;

let nextSetId = 0;

/** A working, owner-owned, device-counted set — the eligible baseline every case starts from. */
function set(
  sessionId: string,
  exerciseId: string,
  startedAt: string,
  overrides: Partial<StoredSet> = {},
): StoredSet {
  nextSetId += 1;
  return {
    id: `set-${nextSetId}`,
    sessionId,
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId,
    weightLbs: 100,
    firmwareRepCount: 8,
    ...overrides,
  };
}

function session(id: string, startedAt: string, dietPhase?: string): StoredSession {
  return dietPhase === undefined ? { id, startedAt } : { id, startedAt, dietPhase };
}

function build(
  sets: StoredSet[],
  options: {
    sessions?: StoredSession[];
    fatigueBySession?: MuscleRecoveryRows['fatigueBySession'];
    now?: Date;
  } = {},
) {
  return buildMuscleRecoveryView({
    sessions: options.sessions ?? [],
    sets,
    fatigueBySession: options.fatigueBySession ?? noFatigue,
    catalog,
    now: options.now ?? NOW,
  });
}

function muscle(view: ReturnType<typeof build>, slug: string) {
  return view.muscles.find((m) => m.muscle === slug);
}

/** Two sessions of the same exercise at the same load, the later doing `laterReps`. */
function twoSessions(laterReps: number, laterOverrides: Partial<StoredSet> = {}): StoredSet[] {
  return [
    set('sess-1', 'chest-press', '2026-07-01T10:00:00.000Z', { firmwareRepCount: 8 }),
    set('sess-2', 'chest-press', '2026-07-08T10:00:00.000Z', {
      firmwareRepCount: laterReps,
      ...laterOverrides,
    }),
  ];
}

describe('buildMuscleRecoveryView — the recovery performance benchmark', () => {
  it('calls the last session matched when it beat the previous comparable session', () => {
    // Same exercise, same 100 lb: 10 reps against 8 clears load x reps.
    const view = build(twoSessions(10));

    expect(muscle(view, 'chest')).toMatchObject({
      lastTrainedAt: '2026-07-08T10:00:00.000Z',
      lastSessionMatchedPrior: true,
      reason: null,
    });
  });

  it('counts an exact repeat of the previous comparable session as matched', () => {
    expect(muscle(build(twoSessions(8)), 'chest')?.lastSessionMatchedPrior).toBe(true);
  });

  it('calls it unmatched when the last session fell short', () => {
    expect(muscle(build(twoSessions(6)), 'chest')).toMatchObject({
      lastSessionMatchedPrior: false,
      reason: null,
    });
  });

  it('compares the SESSION top-load sets, not the last set performed', () => {
    // The later session's heaviest set is the 120 lb one; its lighter back-off
    // set must not become the thing the benchmark reads.
    const view = build([
      set('sess-1', 'chest-press', '2026-07-01T10:00:00.000Z', { weightLbs: 120 }),
      set('sess-2', 'chest-press', '2026-07-08T10:00:00.000Z', { weightLbs: 120 }),
      set('sess-2', 'chest-press', '2026-07-08T10:10:00.000Z', {
        weightLbs: 60,
        firmwareRepCount: 20,
      }),
    ]);

    expect(muscle(view, 'chest')).toMatchObject({ lastSessionMatchedPrior: true, reason: null });
  });

  it('returns null with "insufficient history" when the muscle was trained once', () => {
    const view = build([set('sess-1', 'chest-press', '2026-07-08T10:00:00.000Z')]);

    expect(muscle(view, 'chest')).toMatchObject({
      lastTrainedAt: '2026-07-08T10:00:00.000Z',
      lastSessionMatchedPrior: null,
      reason: 'insufficient history',
    });
  });

  it('returns null with "no matched-load prior" when only the load moved', () => {
    const view = build([
      set('sess-1', 'chest-press', '2026-07-01T10:00:00.000Z', { weightLbs: 90 }),
      set('sess-2', 'chest-press', '2026-07-08T10:00:00.000Z', { weightLbs: 100 }),
    ]);

    expect(muscle(view, 'chest')).toMatchObject({
      lastSessionMatchedPrior: null,
      reason: 'no matched-load prior',
    });
  });

  it('returns null with "no comparable prior" when something other than load changed', () => {
    const view = build([
      set('sess-1', 'chest-press', '2026-07-01T10:00:00.000Z', { side: 'left' }),
      set('sess-2', 'chest-press', '2026-07-08T10:00:00.000Z', { side: 'right' }),
    ]);

    expect(muscle(view, 'chest')).toMatchObject({
      lastSessionMatchedPrior: null,
      reason: 'no comparable prior',
    });
  });

  it('pairs across two phase tags naming the same training context (VW-366)', () => {
    // `recomposition` shares maintenance's equivalence class, so the pair is
    // like-vs-like despite the different label.
    const view = build(twoSessions(10), {
      sessions: [
        session('sess-1', '2026-07-01T10:00:00.000Z', 'maintenance'),
        session('sess-2', '2026-07-08T10:00:00.000Z', 'recomposition'),
      ],
    });

    expect(muscle(view, 'chest')?.lastSessionMatchedPrior).toBe(true);
  });

  it('refuses the pair when the two sessions sat in different training contexts', () => {
    const view = build(twoSessions(10), {
      sessions: [
        session('sess-1', '2026-07-01T10:00:00.000Z', 'fat-loss'),
        session('sess-2', '2026-07-08T10:00:00.000Z', 'gain'),
      ],
    });

    expect(muscle(view, 'chest')).toMatchObject({
      lastSessionMatchedPrior: null,
      reason: 'no comparable prior',
    });
  });
});

describe('buildMuscleRecoveryView — shaping', () => {
  it('returns all 15 titan slugs, untrained ones carrying nulls and a reason', () => {
    const view = build([]);

    expect(view.muscleMapVersion).toBe(MUSCLE_MAP_VERSION);
    expect(view.muscles.map((m) => m.muscle)).toEqual([...TITAN_MUSCLE_GROUPS]);
    expect(view.muscles.every((m) => m.lastTrainedAt === null)).toBe(true);
    expect(view.muscles.every((m) => m.daysSince === null)).toBe(true);
    expect(view.muscles.every((m) => m.lastSessionMatchedPrior === null)).toBe(true);
    expect(view.muscles.every((m) => m.reason === 'insufficient history')).toBe(true);
  });

  it('reports whole elapsed days since the last eligible set', () => {
    const view = build([set('sess-1', 'chest-press', '2026-07-08T10:00:00.000Z')]);

    expect(muscle(view, 'chest')?.daysSince).toBe(2);
  });

  it('credits every titan slug the exercise maps to, secondary groups excluded', () => {
    const view = build([set('sess-1', 'cable-row', '2026-07-08T10:00:00.000Z')]);

    expect(muscle(view, 'lats')?.lastTrainedAt).toBe('2026-07-08T10:00:00.000Z');
    expect(muscle(view, 'upper_back')?.lastTrainedAt).toBe('2026-07-08T10:00:00.000Z');
    expect(muscle(view, 'triceps')?.lastTrainedAt).toBeNull();
  });

  it('excludes mock-adapter, guest, warm-up and no-rep sets', () => {
    const view = build([
      set('sess-1', 'chest-press', '2026-07-08T10:00:00.000Z', { source: 'mock' }),
      set('sess-1', 'chest-press', '2026-07-08T11:00:00.000Z', { lifter: 'guest' }),
      set('sess-1', 'chest-press', '2026-07-08T12:00:00.000Z', {
        setPurpose: 'warmup',
        isWarmup: true,
      }),
      set('sess-1', 'chest-press', '2026-07-08T13:00:00.000Z', { firmwareRepCount: 0, reps: [] }),
    ]);

    expect(muscle(view, 'chest')?.lastTrainedAt).toBeNull();
  });

  it('ignores a set recorded after the instant being reported on', () => {
    const view = build([set('sess-1', 'chest-press', '2026-07-11T10:00:00.000Z')]);

    expect(muscle(view, 'chest')?.lastTrainedAt).toBeNull();
  });
});

describe('buildMuscleRecoveryView — entry depression', () => {
  const axesFor = (pct: number | null, confidence: number) => ({
    entryDepression: {
      value: pct,
      confidence,
      controlledConfounders: [],
      uncontrolled: [],
      setsCompared: 2,
      basis: 'test',
    },
    lateSessionDecay: {
      value: null,
      confidence: 0,
      controlledConfounders: [],
      uncontrolled: [],
      setsCompared: 0,
      basis: 'test',
    },
    note: 'test',
  });

  it('surfaces the axis of the LAST session only', () => {
    const readings = new Map([
      ['sess-1', axesFor(30, 0.9)],
      ['sess-2', axesFor(6, 0.5)],
    ]);

    const view = build(twoSessions(10), {
      fatigueBySession: ({ sessionId }) => readings.get(sessionId),
    });

    expect(muscle(view, 'chest')?.lastEntryDepression).toEqual({ pct: 6, confidence: 0.5 });
  });

  it('keys the lookup on the exercise as well as the session', () => {
    // Two exercises in one session: chest must read chest-press's axis, not the row's.
    const view = build(
      [
        set('sess-1', 'chest-press', '2026-07-08T10:00:00.000Z'),
        set('sess-1', 'cable-row', '2026-07-08T11:00:00.000Z'),
      ],
      {
        fatigueBySession: ({ exerciseId }) =>
          exerciseId === 'chest-press' ? axesFor(4, 0.7) : axesFor(25, 0.7),
      },
    );

    expect(muscle(view, 'chest')?.lastEntryDepression).toEqual({ pct: 4, confidence: 0.7 });
    expect(muscle(view, 'lats')?.lastEntryDepression).toEqual({ pct: 25, confidence: 0.7 });
  });

  it('reports null when the axis was not measurable', () => {
    const view = build(twoSessions(10), { fatigueBySession: () => axesFor(null, 0.2) });

    expect(muscle(view, 'chest')?.lastEntryDepression).toBeNull();
  });
});

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
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** `_movementSampleCount: 1` keeps the rep above `selectEligibleReps`' floor. */
function repsAt(velocity: number, count: number): Rep[] {
  return Array.from({ length: count }, (_, i) => ({
    repNumber: i + 1,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity: velocity,
      _totalVelocity: velocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  }));
}

describe('buildFatigueAxesLookup', () => {
  function velocitySet(sessionId: string, startedAt: string, velocity: number): StoredSet {
    return set(sessionId, 'chest-press', startedAt, {
      reps: repsAt(velocity, 5) as StoredSet['reps'],
      firmwareRepCount: 5,
    });
  }

  it('measures the opener against the most recent prior session at the same load', () => {
    const sets = [
      velocitySet('sess-1', '2026-07-01T10:00:00.000Z', 1.0),
      velocitySet('sess-2', '2026-07-08T10:00:00.000Z', 0.9),
    ];

    const axis = buildFatigueAxesLookup(sets)({
      sessionId: 'sess-2',
      exerciseId: 'chest-press',
    })?.entryDepression;

    expect(axis?.value).toBeCloseTo(10, 6);
  });

  it('flows that reading into the view for the muscle the exercise trains', () => {
    const sets = [
      velocitySet('sess-1', '2026-07-01T10:00:00.000Z', 1.0),
      velocitySet('sess-2', '2026-07-08T10:00:00.000Z', 0.9),
    ];

    const view = build(sets, { fatigueBySession: buildFatigueAxesLookup(sets) });

    expect(muscle(view, 'chest')?.lastEntryDepression?.pct).toBeCloseTo(10, 6);
  });

  it('reports an unmeasurable axis for a session with nothing prior to compare against', () => {
    const sets = [velocitySet('sess-1', '2026-07-08T10:00:00.000Z', 0.9)];

    const axes = buildFatigueAxesLookup(sets)({ sessionId: 'sess-1', exerciseId: 'chest-press' });
    expect(axes?.entryDepression.value).toBeNull();
  });

  it('returns undefined for a (session, exercise) pair that recorded no sets', () => {
    const lookup = buildFatigueAxesLookup([velocitySet('sess-1', '2026-07-08T10:00:00.000Z', 0.9)]);

    expect(lookup({ sessionId: 'sess-9', exerciseId: 'chest-press' })).toBeUndefined();
    expect(lookup({ sessionId: 'sess-1', exerciseId: 'cable-row' })).toBeUndefined();
  });
});

/**
 * The B5 constraint, made executable. No citable per-muscle recovery window
 * exists, so this feature must never render one — not an elapsed-time budget,
 * not a projected return-to-ready moment. Prose drifts where a test does not
 * watch it, so the vocabulary is pinned here rather than left to review.
 */
describe('the no-recovery-window constraint', () => {
  const SOURCES = ['muscle-recovery.ts', 'muscle-recovery-fatigue.ts'] as const;

  const FORBIDDEN = /hour|countdown|ready in \d/i;

  it('never names a recovery window in the read-model sources', () => {
    for (const name of SOURCES) {
      const path = fileURLToPath(new URL(`../read-models/${name}`, import.meta.url));
      expect(FORBIDDEN.test(readFileSync(path, 'utf8')), `${name} names a recovery window`).toBe(
        false,
      );
    }
  });

  it('never emits one in a rendered view either', () => {
    const view = build(twoSessions(10), {
      sessions: [
        session('sess-1', '2026-07-01T10:00:00.000Z', 'maintenance'),
        session('sess-2', '2026-07-08T10:00:00.000Z', 'maintenance'),
      ],
    });

    expect(FORBIDDEN.test(JSON.stringify(view))).toBe(false);
  });
});
