import type {
  ExerciseSummary,
  ExpectedRepRange,
  SessionSet,
  SessionSummary,
  SetPurpose,
} from './types';

// Fixture builders: sets are written compactly, then the exercise-level
// aggregates are computed the way the server computes them, so the mock
// payloads stay internally consistent with the contract.

interface SetSpec {
  w: number | null;
  reps: number;
  vl: number | null;
  v: number | null;
  purpose?: SetPurpose;
  label?: string;
  expected?: [number, number, number, number];
  restSec?: number;
}

type ExerciseExtras = Pick<
  ExerciseSummary,
  'verdict' | 'verdictSetIndex' | 'progression' | 'progressionNote' | 'loadDrift'
>;

const NO_EXTRAS: ExerciseExtras = {
  verdict: null,
  verdictSetIndex: null,
  progression: null,
  progressionNote: null,
  loadDrift: null,
};

function expectedRange(e: SetSpec['expected']): ExpectedRepRange | null {
  if (!e) return null;
  const [expectedLow, expectedHigh, median, n] = e;
  return { expectedLow, expectedHigh, median, n, basis: `last ${n} sessions at this load` };
}

class Clock {
  private t: number;
  private ordinal = 0;
  constructor(startIso: string) {
    this.t = Date.parse(startIso);
  }
  set(spec: SetSpec): SessionSet {
    this.t += (spec.restSec ?? 120) * 1000;
    const startedAt = new Date(this.t).toISOString();
    this.t += spec.reps * 3200;
    this.ordinal += 1;
    return {
      index: this.ordinal,
      startedAt,
      endedAt: new Date(this.t).toISOString(),
      weightLbs: spec.w,
      loadLabel: spec.label ?? null,
      repCount: spec.reps,
      setPurpose: spec.purpose ?? 'working',
      velocityLossPct: spec.vl,
      bestRepVelocity: spec.v,
      expectedRepRange: expectedRange(spec.expected),
    };
  }
  iso(offsetSec = 0): string {
    return new Date(this.t + offsetSec * 1000).toISOString();
  }
}

function maxOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
}

function exercise(
  name: string,
  sets: SessionSet[],
  extras: Partial<ExerciseExtras> = {},
): ExerciseSummary {
  const working = sets.filter((s) => s.setPurpose === 'working');
  const loaded = sets.filter((s) => s.weightLbs !== null);
  return {
    name,
    setCount: sets.length,
    workingSetCount: working.length,
    totalReps: sets.reduce((n, s) => n + s.repCount, 0),
    volumeLbs: loaded.length
      ? loaded.reduce((n, s) => n + (s.weightLbs ?? 0) * s.repCount, 0)
      : null,
    topWeightLbs: maxOrNull(sets.map((s) => s.weightLbs)),
    bestRepVelocity: maxOrNull(sets.map((s) => s.bestRepVelocity)),
    maxVelocityLossPct: maxOrNull(working.map((s) => s.velocityLossPct)),
    sets,
    ...NO_EXTRAS,
    ...extras,
  };
}

function currentCase(): SessionSummary {
  const startedAt = '2026-10-14T17:30:00.000Z';
  const c = new Clock(startedAt);
  const sets = [
    c.set({ w: 140, reps: 5, vl: 12, v: 0.5, restSec: 60 }),
    c.set({ w: 140, reps: 5, vl: 12, v: 0.5, restSec: 150 }),
  ];
  return {
    session: { id: 'ses_current', startedAt, endedAt: c.iso(90), exerciseName: 'Cable Chest Press' },
    exercises: [
      exercise('Cable Chest Press', sets, {
        verdict: {
          state: 'good',
          tone: 'ok',
          dimensions: { velocityLoss: 'ok', rom: 'ok', tempo: 'ok' },
        },
        verdictSetIndex: 2,
        progression: {
          delta: -5,
          reasoning: '2/2 sets missed 12 reps (target 12-15 reps); back off 5 lb.',
          targetSets: 2,
          targetRepsLow: 12,
          targetRepsHigh: 15,
          targetWeightLbs: 135,
        },
      }),
    ],
  };
}

function fullSession(): SessionSummary {
  const startedAt = '2026-10-13T06:45:00.000Z';
  const c = new Clock(startedAt);
  const rdl = [
    c.set({ w: 60, reps: 10, vl: 5, v: 0.92, purpose: 'warmup', restSec: 240 }),
    c.set({ w: 90, reps: 6, vl: 6, v: 0.81, purpose: 'warmup', restSec: 90 }),
    c.set({ w: 120, reps: 12, vl: 14, v: 0.66, expected: [10, 15, 12, 9] }),
    c.set({ w: 120, reps: 11, vl: 18, v: 0.63, expected: [10, 15, 12, 9] }),
    c.set({ w: 120, reps: 10, vl: 23, v: 0.6, expected: [10, 15, 12, 9] }),
  ];
  const row = [
    c.set({ w: 70, reps: 8, vl: 4, v: 0.88, purpose: 'warmup', restSec: 180 }),
    c.set({ w: 100, reps: 15, vl: 9, v: 0.74, expected: [11, 16, 13, 12] }),
    c.set({ w: 100, reps: 15, vl: 11, v: 0.73, expected: [11, 16, 13, 12] }),
    c.set({ w: 100, reps: 15, vl: 13, v: 0.71, expected: [11, 16, 13, 12] }),
  ];
  const press = [
    c.set({ w: 50, reps: 8, vl: 6, v: 0.85, purpose: 'warmup', restSec: 180 }),
    c.set({ w: 80, reps: 10, vl: 21, v: 0.58 }),
    c.set({ w: 80, reps: 8, vl: 27, v: 0.55 }),
    c.set({ w: 80, reps: 6, vl: 34, v: 0.52, restSec: 75 }),
  ];
  const facePull = [
    c.set({ w: null, label: 'damper 6', reps: 15, vl: 8, v: 1.02, restSec: 150 }),
    c.set({ w: null, label: 'damper 6', reps: 15, vl: 10, v: 0.99 }),
  ];
  return {
    session: { id: 'ses_full', startedAt, endedAt: c.iso(120), exerciseName: null },
    exercises: [
      exercise('Cable Romanian Deadlift', rdl, {
        verdict: {
          state: 'slowing',
          tone: 'warn',
          dimensions: { velocityLoss: 'warn', rom: 'ok', tempo: 'ok' },
        },
        verdictSetIndex: 5,
        progression: {
          delta: 0,
          reasoning: '3/3 sets landed in 10-12 reps (target 10-12 reps); hold 120 lb.',
          targetSets: 3,
          targetRepsLow: 10,
          targetRepsHigh: 12,
          targetWeightLbs: 120,
        },
      }),
      exercise('Seated Cable Row', row, {
        verdict: {
          state: 'good',
          tone: 'ok',
          dimensions: { velocityLoss: 'ok', rom: 'ok', tempo: 'ok' },
        },
        verdictSetIndex: 9,
        progression: {
          delta: 5,
          reasoning: '3/3 sets hit 15 reps (target 12-15 reps); add 5 lb.',
          targetSets: 3,
          targetRepsLow: 12,
          targetRepsHigh: 15,
          targetWeightLbs: 105,
        },
        loadDrift: {
          programmedPct: 70,
          impliedPct: 58,
          deltaPct: -12,
          reason: 'Your bar speed at 100 lb has risen; 100 lb now sits near 58% of your estimated max.',
        },
      }),
      exercise('Standing Cable Chest Press', press, {
        verdict: {
          state: 'grinding',
          tone: 'alarm',
          dimensions: { velocityLoss: 'alarm', rom: 'ok', tempo: 'warn' },
        },
        verdictSetIndex: 13,
        progression: {
          delta: -5,
          reasoning: '2/3 sets missed 8 reps (target 8-10 reps); back off 5 lb.',
          targetSets: 3,
          targetRepsLow: 8,
          targetRepsHigh: 10,
          targetWeightLbs: 75,
        },
      }),
      exercise('Face Pull', facePull, {
        verdict: {
          state: 'good',
          tone: 'ok',
          dimensions: { velocityLoss: 'ok', rom: 'ok', tempo: 'ok' },
        },
        verdictSetIndex: 15,
        progressionNote: 'Not in your current program, so there is no load to progress.',
      }),
    ],
  };
}

function edgeCases(): SessionSummary {
  const startedAt = '2026-10-11T18:10:00.000Z';
  const c = new Clock(startedAt);
  const pulldown = [
    c.set({ w: 80, reps: 8, vl: 7, v: 0.9, purpose: 'warmup', restSec: 200 }),
    c.set({ w: 130, reps: 3, vl: 9, v: 0.61, purpose: 'probe' }),
    c.set({ w: 110, reps: 10, vl: null, v: null }),
    c.set({ w: 110, reps: 9, vl: 19, v: 0.62 }),
    c.set({ w: 110, reps: 7, vl: 26, v: 0.57 }),
  ];
  const unattributed = [
    c.set({ w: 40, reps: 12, vl: 15, v: 0.8, restSec: 260 }),
    c.set({ w: 40, reps: 10, vl: null, v: null }),
  ];
  const curl = [
    c.set({ w: 25, reps: 10, vl: null, v: null, purpose: 'technique', restSec: 180 }),
    c.set({ w: 35, reps: 12, vl: null, v: null }),
  ];
  return {
    session: { id: 'ses_edges', startedAt, endedAt: null, exerciseName: null },
    exercises: [
      exercise('Lat Pulldown', pulldown, {
        verdict: {
          state: 'form-breakdown',
          tone: 'alarm',
          dimensions: { velocityLoss: 'warn', rom: 'alarm', tempo: 'ok' },
        },
        verdictSetIndex: 5,
        progression: {
          delta: 0,
          reasoning: 'Range of motion shortened on the last set; hold 110 lb until it is clean.',
          targetSets: 3,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetWeightLbs: 110,
        },
      }),
      exercise('Unattributed', unattributed, {
        progressionNote: 'These sets named no exercise, so there is nothing to progress.',
      }),
      exercise('Cable Biceps Curl', curl, {
        progressionNote: 'No velocity telemetry was recorded, so no verdict or progression.',
      }),
    ],
  };
}

export const fixtures = {
  current: { label: 'Current case', build: currentCase },
  full: { label: 'Full session', build: fullSession },
  edges: { label: 'Edge cases', build: edgeCases },
} as const;

export type FixtureKey = keyof typeof fixtures;
