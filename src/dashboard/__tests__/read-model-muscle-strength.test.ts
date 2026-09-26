/**
 * Per-muscle strength read-model (VW-330, plan B3) — the pure projection behind
 * `GET /api/muscle-strength`. Pins the rp-s7 agreement rule (two exercises
 * trending the same way before a muscle is called stronger), the "never pool
 * left and right" rule that gives a bilateral exercise two rows, the PR verdict
 * coming from the shared `evaluateE1RMPr`, the early-phase flag, and that all
 * 15 titan slugs are always present.
 */
import { describe, expect, it } from 'vitest';

import {
  buildMuscleStrengthView,
  MUSCLE_STRENGTH_CONSTANTS,
  type MuscleStrengthExerciseInput,
  type MuscleStrengthSetRow,
  type MuscleStrengthTrend,
} from '../read-models/muscle-strength';
import { MUSCLE_MAP_VERSION, TITAN_MUSCLE_GROUPS } from '../../exercises/muscle-map';

/** A fit with enough weekly points for its sign to be reported. */
const fit = (
  slope: number,
  over: Partial<MuscleStrengthTrend['trend']> = {},
): MuscleStrengthTrend => ({
  trend: { slope, intercept: 100, rSquared: 0.9, pointCount: 4, ...over },
  plateau: { verdict: 'none' },
});

const set = (over: Partial<MuscleStrengthSetRow> = {}): MuscleStrengthSetRow => ({
  sessionId: 's-1',
  startedAt: '2026-07-01T12:00:00.000Z',
  side: null,
  weightLbs: 100,
  repCount: 5,
  ...over,
});

const exercise = (
  over: Partial<MuscleStrengthExerciseInput> = {},
): MuscleStrengthExerciseInput => ({
  exerciseId: 'cable-chest-press',
  name: 'Cable Chest Press',
  primaryMuscles: ['chest'],
  sets: [set()],
  trendBySide: { none: fit(0.5) },
  ...over,
});

const muscleOf = (view: ReturnType<typeof buildMuscleStrengthView>, slug: string) => {
  const found = view.muscles.find((m) => m.muscle === slug);
  if (found === undefined) throw new Error(`no muscle row for '${slug}'`);
  return found;
};

describe('buildMuscleStrengthView', () => {
  it('names every one of the 15 titan slugs, trained or not', () => {
    const view = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 5 });

    expect(view.muscles.map((m) => m.muscle)).toEqual([...TITAN_MUSCLE_GROUPS]);
    expect(view.muscleMapVersion).toBe(MUSCLE_MAP_VERSION);
    expect(muscleOf(view, 'calves')).toMatchObject({ exercises: [], agreement: 'insufficient' });
  });

  it("calls a muscle 'stronger' only once two exercises rise together", () => {
    const view = buildMuscleStrengthView({
      exercises: [
        exercise({ exerciseId: 'press', trendBySide: { none: fit(0.5) } }),
        exercise({ exerciseId: 'fly', name: 'Cable Fly', trendBySide: { none: fit(0.3) } }),
      ],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').agreement).toBe('stronger');
    expect(MUSCLE_STRENGTH_CONSTANTS.minExercisesForAgreement).toBe(2);
  });

  it("calls a single rising exercise 'insufficient', however steep", () => {
    const view = buildMuscleStrengthView({
      exercises: [exercise({ trendBySide: { none: fit(9) } })],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').agreement).toBe('insufficient');
  });

  it("calls two exercises 'weaker' when both fall, and 'mixed' when they disagree", () => {
    const falling = buildMuscleStrengthView({
      exercises: [
        exercise({ exerciseId: 'press', trendBySide: { none: fit(-0.5) } }),
        exercise({ exerciseId: 'fly', trendBySide: { none: fit(-0.2) } }),
      ],
      yearsTraining: 5,
    });
    const split = buildMuscleStrengthView({
      exercises: [
        exercise({ exerciseId: 'press', trendBySide: { none: fit(0.5) } }),
        exercise({ exerciseId: 'fly', trendBySide: { none: fit(-0.2) } }),
      ],
      yearsTraining: 5,
    });

    expect(muscleOf(falling, 'chest').agreement).toBe('weaker');
    expect(muscleOf(split, 'chest').agreement).toBe('mixed');
  });

  it('withholds a sign from a fit too short to disagree with its own data', () => {
    const view = buildMuscleStrengthView({
      exercises: [
        exercise({ exerciseId: 'press', trendBySide: { none: fit(0.5, { pointCount: 2 }) } }),
        exercise({ exerciseId: 'fly', trendBySide: { none: fit(0.3, { pointCount: 2 }) } }),
      ],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').exercises.map((row) => row.slopePctPerWeek)).toEqual([
      null,
      null,
    ]);
    expect(muscleOf(view, 'chest').agreement).toBe('insufficient');
  });

  it('reports the fitted weekly change as a percent of the fit own day-0 value', () => {
    // slope 1 lb/day over an intercept of 100 lb: 7 lb/wk = 7 %/wk.
    const view = buildMuscleStrengthView({
      exercises: [exercise({ trendBySide: { none: fit(1) } })],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').exercises[0]).toMatchObject({
      slopePctPerWeek: 7,
      rSquared: 0.9,
      plateau: 'none',
    });
  });
});

describe('buildMuscleStrengthView — sides', () => {
  const bilateral = exercise({
    exerciseId: 'single-arm-row',
    name: 'Single-Arm Row',
    primaryMuscles: ['lats'],
    sets: [
      set({ side: 'left', weightLbs: 80, sessionId: 's-1' }),
      set({ side: 'right', weightLbs: 100, sessionId: 's-1' }),
    ],
    trendBySide: { left: fit(0.2), right: fit(0.4) },
  });

  it('yields one row per side and never a merged one', () => {
    const view = buildMuscleStrengthView({ exercises: [bilateral], yearsTraining: 5 });
    const rows = muscleOf(view, 'lats').exercises;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.side)).toEqual(['left', 'right']);
    // 80 lb x 5 -> 93.33, 100 lb x 5 -> 116.67 (Epley). A merged row would
    // carry their average, 105, or a pooled 90 lb load's estimate — neither
    // side-tagged, and neither is an assessment reference.
    const values = rows.map((row) => row.bestE1rm?.value);
    expect(values).toEqual([80 * (1 + 5 / 30), 100 * (1 + 5 / 30)]);
    expect(rows.some((row) => row.side === null)).toBe(false);
    const merged = (values[0] as number) + ((values[1] as number) - (values[0] as number)) / 2;
    expect(values).not.toContain(merged);
  });

  it('keeps a side-unknown exercise on one row', () => {
    const view = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 5 });
    const rows = muscleOf(view, 'chest').exercises;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.side).toBeNull();
  });

  it('refuses an exercise-level sign when the two limbs disagree', () => {
    const view = buildMuscleStrengthView({
      exercises: [
        { ...bilateral, trendBySide: { left: fit(0.4), right: fit(-0.4) } },
        exercise({
          exerciseId: 'pulldown',
          primaryMuscles: ['lats'],
          trendBySide: { none: fit(1) },
        }),
      ],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'lats').agreement).toBe('insufficient');
  });
});

describe('buildMuscleStrengthView — PR verdict', () => {
  const history = (): MuscleStrengthSetRow[] => [
    set({ sessionId: 'old', startedAt: '2026-06-01T12:00:00.000Z', weightLbs: 100 }),
    set({ sessionId: 'new', startedAt: '2026-07-01T12:00:00.000Z', weightLbs: 120 }),
  ];

  it('flags the newest session beating every earlier one', () => {
    const view = buildMuscleStrengthView({
      exercises: [exercise({ sets: history() })],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').exercises[0]).toMatchObject({
      isPR: true,
      priorBest: 100 * (1 + 5 / 30),
    });
  });

  it('does not flag a newest session that fell short', () => {
    const [old, recent] = history();
    const view = buildMuscleStrengthView({
      exercises: [
        exercise({
          sets: [
            { ...(old as MuscleStrengthSetRow), weightLbs: 140 },
            recent as MuscleStrengthSetRow,
          ],
        }),
      ],
      yearsTraining: 5,
    });

    expect(muscleOf(view, 'chest').exercises[0]).toMatchObject({ isPR: false });
  });

  it('never calls a first-ever session a PR', () => {
    const view = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 5 });

    expect(muscleOf(view, 'chest').exercises[0]).toMatchObject({ isPR: false, priorBest: null });
  });

  it('carries the Epley band on every best e1RM', () => {
    const view = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 5 });
    const best = muscleOf(view, 'chest').exercises[0]?.bestE1rm;

    expect(best?.method).toBe('reps');
    expect(best?.band).toMatchObject({ fitFor: 'trend', method: 'reps', seePct: null });
  });
});

describe('buildMuscleStrengthView — early phase', () => {
  it('flags a lifter under six months without dropping a single row', () => {
    const view = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 0.25 });

    expect(view.muscles.every((m) => m.earlyPhase)).toBe(true);
    expect(muscleOf(view, 'chest').exercises).toHaveLength(1);
    expect(view.earlyPhaseBasis).toContain('0.25');
    expect(MUSCLE_STRENGTH_CONSTANTS.earlyPhaseYears).toBe(0.5);
  });

  it('does not flag a lifter past it, nor one who never declared a training age', () => {
    const seasoned = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: 3 });
    const undeclared = buildMuscleStrengthView({ exercises: [exercise()], yearsTraining: null });

    expect(seasoned.muscles.some((m) => m.earlyPhase)).toBe(false);
    expect(undeclared.muscles.some((m) => m.earlyPhase)).toBe(false);
    expect(undeclared.earlyPhaseBasis).toContain('no self-reported years of training');
  });
});

describe('buildMuscleStrengthView recency (VW-558)', () => {
  const sessionSet = (side: 'left' | 'right', day: string, weightLbs: number) =>
    set({ sessionId: `${side}-${day}`, startedAt: `${day}T12:00:00.000Z`, side, weightLbs });

  const bilateral = exercise({
    sets: [
      sessionSet('left', '2026-06-01', 100),
      sessionSet('left', '2026-06-29', 80),
      sessionSet('right', '2026-06-01', 100),
      sessionSet('right', '2026-06-29', 100),
    ],
    trendBySide: {},
  });

  it('keeps a separate relative index for each side, never a pooled one', () => {
    const view = buildMuscleStrengthView({ exercises: [bilateral], yearsTraining: 5 });
    const chest = muscleOf(view, 'chest');
    const bySide = Object.fromEntries(chest.exercises.map((row) => [row.side, row.relativeIndex]));

    expect(bySide.right).toBe(100);
    expect(bySide.left).toBeLessThan(90);
    expect(chest.relativeIndexBySide).toEqual({ left: bySide.left, right: 100 });
  });

  it('weighs the newer session more heavily in the current level', () => {
    const view = buildMuscleStrengthView({ exercises: [bilateral], yearsTraining: 5 });
    const left = muscleOf(view, 'chest').exercises.find((row) => row.side === 'left')!;
    const oldBest = left.bestE1rm!.value;

    expect(left.currentLevel!).toBeLessThan((oldBest + oldBest * 0.8) / 2);
  });

  it.each([
    [0, 'current'],
    [28, 'current'],
    [29, 'fading'],
    [200, 'no_current_read'],
  ])('reads %i days since trained as %s', (days, recency) => {
    const asOf = new Date(Date.parse('2026-06-29T12:00:00.000Z') + days * 86_400_000).toISOString();
    const view = buildMuscleStrengthView({ exercises: [bilateral], yearsTraining: 5, asOf });
    const chest = muscleOf(view, 'chest');

    expect(chest.daysSinceTrained).toBe(days);
    expect(chest.exercises.every((row) => row.recency === recency)).toBe(true);
  });

  it('reports no recency without an as-of instant', () => {
    const chest = muscleOf(
      buildMuscleStrengthView({ exercises: [bilateral], yearsTraining: 5 }),
      'chest',
    );

    expect(chest.daysSinceTrained).toBeNull();
    expect(chest.exercises.map((row) => row.recency)).toEqual([null, null]);
  });
});
