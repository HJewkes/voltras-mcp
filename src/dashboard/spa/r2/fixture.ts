/**
 * R2 harness fixture data (VMCP R2 React harness).
 *
 * Synthetic session mirroring the R2 synthesis gallery's data
 * (coordination/design-explorations/drilldown-pass/r2-synthesis/gallery.html):
 * one Pull-A session, 5 exercises, per-rep mean-concentric velocities with
 * decay/gain/erratic shapes, a live 4th set on Seated Cable Row.
 *
 * FIXTURE ONLY — no server, no API. Every value here is mock data; the
 * fidelity legend tags consumers accordingly.
 */

export interface FixtureSet {
  reps: number;
  rpe: number;
  /** Per-rep mean-concentric velocities (m/s). */
  velocities: number[];
  /** Prev-session comparison for SetRow's `previous` (restored per audit). */
  previous: { reps: number; weight: number };
  live?: boolean;
}

export interface FixtureExercise {
  id: string;
  name: string;
  weight: number;
  e1rm: number;
  pr?: boolean;
  /** CON / HOLD / ECC durations in ms (real-world). */
  tempoMs: { con: number; hold: number; ecc: number };
  category: string;
  sets: FixtureSet[];
  /** Superset partner grouping (rendered via SupersetWrapper). */
  superset?: 'A' | null;
}

function genSet(peak: number, n: number, shape: string): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    let v: number;
    if (shape === 'decay') v = peak * (1 - 0.3 * t);
    else if (shape === 'slow')
      v = peak * (1 - 0.32 * t) + (i === 0 ? -0.045 : i === 1 ? -0.02 : i === 2 ? -0.005 : 0);
    else if (shape === 'gain') v = peak * (0.84 + 0.17 * t);
    else if (shape === 'erratic') v = peak * (1 - 0.24 * t) + (i % 2 ? 0.028 : -0.028);
    else v = peak * (1 - 0.26 * t);
    v += (((i * 37) % 7) - 3) * 0.004;
    a.push(Math.max(0.18, Math.round(v * 100) / 100));
  }
  return a;
}

function sets(
  weight: number,
  specs: Array<{ reps: number; rpe: number; peak: number; shape: string; live?: boolean }>,
): FixtureSet[] {
  return specs.map((s, i) => ({
    reps: s.reps,
    rpe: s.rpe,
    velocities: genSet(s.peak, s.reps, s.shape),
    previous: { reps: Math.max(5, s.reps - (i === 0 ? 0 : 1)), weight: weight - 5 },
    live: s.live,
  }));
}

export const SESSION: FixtureExercise[] = [
  {
    id: 'cable-row',
    name: 'Seated Cable Row',
    weight: 145,
    e1rm: 205,
    pr: true,
    tempoMs: { con: 900, hold: 300, ecc: 1500 },
    category: 'Back',
    superset: null,
    sets: sets(145, [
      { reps: 8, rpe: 7, peak: 0.68, shape: 'slow' },
      { reps: 8, rpe: 7.5, peak: 0.66, shape: 'decay' },
      { reps: 8, rpe: 8, peak: 0.63, shape: 'decay' },
      { reps: 8, rpe: 8.5, peak: 0.6, shape: 'decay', live: true },
      { reps: 7, rpe: 9.5, peak: 0.57, shape: 'erratic' },
    ]),
  },
  {
    id: 'lat-pull',
    name: 'Lat Pulldown',
    weight: 130,
    e1rm: 188,
    tempoMs: { con: 850, hold: 200, ecc: 1400 },
    category: 'Back',
    superset: null,
    sets: sets(130, [
      { reps: 10, rpe: 7, peak: 0.78, shape: 'decay' },
      { reps: 10, rpe: 8, peak: 0.74, shape: 'decay' },
      { reps: 9, rpe: 8.5, peak: 0.7, shape: 'gain' },
      { reps: 8, rpe: 9, peak: 0.66, shape: 'decay' },
    ]),
  },
  {
    id: 'cable-press',
    name: 'Cable Chest Press',
    weight: 90,
    e1rm: 150,
    tempoMs: { con: 800, hold: 200, ecc: 1300 },
    category: 'Chest',
    superset: 'A',
    sets: sets(90, [
      { reps: 10, rpe: 7, peak: 0.7, shape: 'decay' },
      { reps: 9, rpe: 8, peak: 0.66, shape: 'decay' },
      { reps: 8, rpe: 8.5, peak: 0.62, shape: 'erratic' },
    ]),
  },
  {
    id: 'cable-fly',
    name: 'Cable Fly',
    weight: 45,
    e1rm: 78,
    tempoMs: { con: 1100, hold: 400, ecc: 1600 },
    category: 'Chest',
    superset: 'A',
    sets: sets(45, [
      { reps: 12, rpe: 6, peak: 0.9, shape: 'decay' },
      { reps: 12, rpe: 7, peak: 0.86, shape: 'decay' },
      { reps: 11, rpe: 8, peak: 0.82, shape: 'erratic' },
    ]),
  },
  {
    id: 'face-pull',
    name: 'Face Pull',
    weight: 35,
    e1rm: 60,
    tempoMs: { con: 900, hold: 500, ecc: 1200 },
    category: 'Rear Delt',
    superset: null,
    sets: sets(35, [
      { reps: 15, rpe: 6, peak: 0.95, shape: 'decay' },
      { reps: 15, rpe: 7, peak: 0.9, shape: 'decay' },
      { reps: 14, rpe: 8, peak: 0.85, shape: 'decay' },
    ]),
  },
];

export const LIVE = {
  exerciseId: 'cable-row',
  exerciseIndex: 0,
  setIndex: 3,
  targetReps: 8,
  /** Scripted live-set velocities (rep 4 rebounds — running-best rebase case). */
  stream: [0.61, 0.59, 0.56, 0.61, 0.55, 0.52, 0.49, 0.46],
  restSeconds: 90,
};

export const PACE = {
  budgetSec: 60 * 60,
  elapsedSec: 42 * 60 + 18,
  volumeDonePct: 76,
  loadLbs: 7340,
  fatigue: 'moderate',
};

/** e1RM trend for StrengthTrendChart (ISO dates; last point PR). */
export const E1RM_TREND = [
  { date: '2026-05-25', e1rm: 188 },
  { date: '2026-06-01', e1rm: 192 },
  { date: '2026-06-08', e1rm: 195 },
  { date: '2026-06-15', e1rm: 199 },
  { date: '2026-06-22', e1rm: 201 },
  { date: '2026-06-29', e1rm: 205, isPR: true },
];

/** Capacity band + workout dots for the Session Pace tile (YYYY-MM-DD dates). */
export const CAPACITY_BAND = {
  band: [
    { date: '2026-06-01', bandLow: 48, bandHigh: 72 },
    { date: '2026-06-08', bandLow: 50, bandHigh: 75 },
    { date: '2026-06-15', bandLow: 52, bandHigh: 78 },
    { date: '2026-06-22', bandLow: 54, bandHigh: 80 },
    { date: '2026-06-29', bandLow: 56, bandHigh: 83 },
    { date: '2026-07-06', bandLow: 58, bandHigh: 85 },
  ],
  workouts: [
    { date: '2026-06-08', load: 60, status: 'within' as const },
    { date: '2026-06-15', load: 68, status: 'within' as const },
    { date: '2026-06-22', load: 84, status: 'above' as const },
    { date: '2026-06-29', load: 70, status: 'within' as const },
    { date: '2026-07-06', load: 74, status: 'within' as const },
  ],
};

export interface FixtureMuscle {
  name: string;
  displayName: string;
  weeklySets: number;
  landmarks: { mev: number; mav: number; mrv: number };
  volumeStatus: 'untrained' | 'behind' | 'ontrack' | 'target' | 'over';
  lastTrained: string;
  weeklyHistory: number[];
  contributing: Array<{ name: string; sets: number; contributionWeight: number }>;
  upcoming: Array<{ name: string; workoutName: string; sets: number }>;
}

export const MUSCLES: FixtureMuscle[] = [
  {
    name: 'lats',
    displayName: 'Lats',
    weeklySets: 19,
    landmarks: { mev: 8, mav: 16, mrv: 20 },
    volumeStatus: 'over',
    lastTrained: 'today',
    weeklyHistory: [10, 12, 14, 16, 18, 19],
    contributing: [
      { name: 'Seated Cable Row', sets: 5, contributionWeight: 1 },
      { name: 'Lat Pulldown', sets: 4, contributionWeight: 1 },
      { name: 'Face Pull', sets: 3, contributionWeight: 0.3 },
    ],
    upcoming: [{ name: 'Lat Pulldown', workoutName: 'Pull B', sets: 4 }],
  },
  {
    name: 'chest',
    displayName: 'Chest',
    weeklySets: 14,
    landmarks: { mev: 8, mav: 16, mrv: 20 },
    volumeStatus: 'ontrack',
    lastTrained: '2 days ago',
    weeklyHistory: [8, 9, 11, 12, 13, 14],
    contributing: [
      { name: 'Cable Chest Press', sets: 3, contributionWeight: 1 },
      { name: 'Cable Fly', sets: 3, contributionWeight: 1 },
    ],
    upcoming: [{ name: 'Cable Chest Press', workoutName: 'Push B', sets: 3 }],
  },
  {
    name: 'quads',
    displayName: 'Quads',
    weeklySets: 13,
    landmarks: { mev: 8, mav: 14, mrv: 18 },
    volumeStatus: 'ontrack',
    lastTrained: '4 days ago',
    weeklyHistory: [9, 10, 11, 12, 13, 13],
    contributing: [{ name: 'Leg Press', sets: 6, contributionWeight: 1 }],
    upcoming: [{ name: 'Leg Press', workoutName: 'Legs A', sets: 6 }],
  },
  {
    name: 'abs',
    displayName: 'Abs',
    weeklySets: 4,
    landmarks: { mev: 6, mav: 10, mrv: 14 },
    volumeStatus: 'behind',
    lastTrained: '5 days ago',
    weeklyHistory: [6, 5, 5, 4, 4, 4],
    contributing: [{ name: 'Cable Crunch', sets: 4, contributionWeight: 1 }],
    upcoming: [],
  },
];

export const PROGRAM = {
  name: '12-Week Hypertrophy',
  weekNumber: 8,
  totalWeeks: 12,
  meso: 'Intensification',
  mesoWeek: 3,
  mesoTotal: 5,
};
