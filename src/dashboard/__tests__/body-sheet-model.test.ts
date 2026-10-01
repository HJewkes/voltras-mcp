// The `#/body` muscle sheet mapping (VW-712, VW-339 slice S2).
//
// Fixtures are synthetic and typed as the four `/api/muscle-*` views; the week
// is built by `buildMuscleWeekView`, the function the route itself calls.

import { describe, expect, it } from 'vitest';

import type { BodyPageData } from '../spa/body/body-model.js';
import { statusOf } from '../spa/body/body-model.js';
import {
  ENTRY_DEPRESSION_MIN_CONFIDENCE,
  muscleSheetProps,
  recoveryLine,
} from '../spa/body/body-sheet-model.js';
import { buildMuscleWeekView, type MuscleWeekRows } from '../read-models/muscle-week.js';
import { e1rmBand } from '../../tools/e1rm-band.js';
import type {
  MusclePlanView,
  MuscleRecoveryMuscleView,
  MuscleRecoveryView,
  MuscleStrengthExerciseRow,
  MuscleStrengthSide,
  MuscleStrengthView,
} from '../read-models/index.js';
import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import type { StoredSet } from '../../store/types.js';

const NOW = new Date('2026-07-08T12:00:00.000Z');
const MONDAY = '2026-07-06T00:00:00.000Z';

const catalog: MuscleWeekRows['catalog'] = (id) =>
  id === 'cable-fly' ? { id, name: 'Cable Fly', muscleGroups: ['chest'] } : undefined;

function chestSet(index: number): StoredSet {
  return {
    id: `set-${index}`,
    sessionId: 'sess-1',
    startedAt: MONDAY,
    endedAt: MONDAY,
    partial: false,
    reps: [],
    exerciseId: 'cable-fly',
    firmwareRepCount: 10,
  };
}

function strengthRow(side: MuscleStrengthSide, e1rm: number): MuscleStrengthExerciseRow {
  return {
    exerciseId: 'cable-fly',
    name: 'Cable Fly',
    side,
    bestE1rm: { value: e1rm, band: e1rmBand(e1rm, 'reps'), method: 'reps', confidence: 0.7 },
    slopePctPerWeek: 0.8,
    rSquared: 0.6,
    isPR: false,
    priorBest: null,
    plateau: 'none',
    setCount: 6,
    currentLevel: null,
    relativeIndex: null,
    daysSinceTrained: 2,
    recency: 'current',
  };
}

const STRENGTH: MuscleStrengthView = {
  muscleMapVersion: MUSCLE_MAP_VERSION,
  agreementBasis: 'synthetic',
  earlyPhaseBasis: 'synthetic',
  muscles: [
    {
      muscle: 'chest',
      agreement: 'stronger',
      earlyPhase: false,
      relativeIndexBySide: {},
      daysSinceTrained: 2,
      exercises: [strengthRow('left', 60), strengthRow('right', 54)],
    },
  ],
};

const PLAN: MusclePlanView = {
  weekStart: MONDAY,
  muscleMapVersion: MUSCLE_MAP_VERSION,
  isDeload: false,
  muscles: [
    {
      muscle: 'chest',
      plannedSetsThisWeek: 12,
      doneSetsThisWeek: 6,
      plannedRemaining: [
        { workoutName: 'Push B', exerciseId: 'cable-fly', exerciseName: 'Cable Fly', sets: 6 },
      ],
    },
  ],
};

function untrained(muscle: TitanMuscleGroup): MuscleRecoveryMuscleView {
  return {
    muscle,
    lastTrainedAt: null,
    daysSince: null,
    lastEntryDepression: null,
    lastSessionMatchedPrior: null,
    reason: 'insufficient history',
  };
}

function trained(over: Partial<MuscleRecoveryMuscleView> = {}): MuscleRecoveryMuscleView {
  return {
    muscle: 'chest',
    lastTrainedAt: MONDAY,
    daysSince: 2,
    lastEntryDepression: null,
    lastSessionMatchedPrior: true,
    reason: null,
    ...over,
  };
}

function recovery(chest: MuscleRecoveryMuscleView): MuscleRecoveryView {
  return {
    muscleMapVersion: MUSCLE_MAP_VERSION,
    muscles: TITAN_MUSCLE_GROUPS.map((muscle) => (muscle === 'chest' ? chest : untrained(muscle))),
  };
}

function pageData(over: Partial<BodyPageData> = {}): BodyPageData {
  const sets = Array.from({ length: 10 }, (_, index) => chestSet(index));
  return {
    week: buildMuscleWeekView({ sets, catalog, now: NOW }),
    strength: STRENGTH,
    plan: PLAN,
    recovery: recovery(trained()),
    ...over,
  };
}

describe('the body muscle sheet props', () => {
  it('maps the week, strength, plan and recovery payloads onto the right side-sheet', () => {
    const data = pageData();
    const week = data.week.muscles.find((muscle) => muscle.muscle === 'chest')!;

    const props = muscleSheetProps('chest', data);

    expect(props).toMatchObject({
      muscleGroup: 'chest',
      displayName: 'Chest',
      weeklySets: 10,
      landmarks: week.landmarks,
      volumeStatus: statusOf(week),
      placement: 'right',
      lastTrained: '2 days ago · matched last session',
      strength: { agreement: 'stronger', earlyPhase: false },
      plan: {
        plannedSetsThisWeek: 12,
        doneSetsThisWeek: 6,
        exercises: [
          {
            workoutName: 'Push B',
            exerciseId: 'cable-fly',
            exerciseName: 'Cable Fly',
            sets: 6,
            done: false,
          },
        ],
      },
    });
  });

  it('keeps a bilateral exercise as one strength row per side', () => {
    const props = muscleSheetProps('chest', pageData());

    const rows = props?.strength?.exercises ?? [];
    expect(rows.map((row) => [row.side, row.bestE1rm?.value])).toEqual([
      ['left', 60],
      ['right', 54],
    ]);
  });

  it('omits the plan section when no training week is active', () => {
    const props = muscleSheetProps('chest', pageData({ plan: null }));

    expect(props).not.toBeNull();
    expect(props).not.toHaveProperty('plan');
  });

  it('omits the plan section when the active week plans no sets for the muscle', () => {
    const unplanned = { ...PLAN.muscles[0]!, plannedSetsThisWeek: 0, plannedRemaining: [] };
    const plan: MusclePlanView = { ...PLAN, muscles: [unplanned] };

    const props = muscleSheetProps('chest', pageData({ plan }));

    expect(props).not.toBeNull();
    expect(props).not.toHaveProperty('plan');
  });

  it('omits the last-trained line for a muscle never trained', () => {
    const props = muscleSheetProps('calves', pageData());

    expect(props).not.toBeNull();
    expect(props).not.toHaveProperty('lastTrained');
  });

  it('omits the last-trained line but keeps the sheet when the recovery route failed', () => {
    const props = muscleSheetProps('chest', pageData({ recovery: null }));

    expect(props).toMatchObject({ muscleGroup: 'chest', weeklySets: 10 });
    expect(props).not.toHaveProperty('lastTrained');
  });

  it('returns null for a slug titan does not draw', () => {
    expect(muscleSheetProps('not-a-muscle', pageData())).toBeNull();
  });
});

describe('the recovery line', () => {
  it('keeps each of the three missing-benchmark reasons as its own text', () => {
    const reasons = [
      'insufficient history',
      'no comparable prior',
      'no matched-load prior',
    ] as const;

    const lines = reasons.map((reason) =>
      recoveryLine(trained({ lastSessionMatchedPrior: null, reason })),
    );

    expect(lines).toEqual([
      '2 days ago · insufficient history',
      '2 days ago · no comparable prior',
      '2 days ago · no matched-load prior',
    ]);
  });

  it('says whether the last session fell below its prior', () => {
    expect(recoveryLine(trained({ lastSessionMatchedPrior: false }))).toBe(
      '2 days ago · below last session',
    );
  });

  it('reads a same-day session as today and a single day in the singular', () => {
    expect(recoveryLine(trained({ daysSince: 0 }))).toBe('today · matched last session');
    expect(recoveryLine(trained({ daysSince: 1 }))).toBe('1 day ago · matched last session');
  });

  it('states an entry depression only when its confidence clears the gate', () => {
    const confident = { pct: 7.6, confidence: ENTRY_DEPRESSION_MIN_CONFIDENCE };
    const weak = { pct: 7.6, confidence: ENTRY_DEPRESSION_MIN_CONFIDENCE - 0.01 };

    expect(recoveryLine(trained({ lastEntryDepression: confident }))).toBe(
      '2 days ago · entry 8% below prior · matched last session',
    );
    expect(recoveryLine(trained({ lastEntryDepression: weak }))).toBe(
      '2 days ago · matched last session',
    );
  });

  it('reads a negative depression as entry above prior', () => {
    const above = { pct: -3, confidence: 0.9 };

    expect(recoveryLine(trained({ lastEntryDepression: above }))).toBe(
      '2 days ago · entry 3% above prior · matched last session',
    );
  });
});
