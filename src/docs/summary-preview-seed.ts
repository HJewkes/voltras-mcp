// The store seed behind `npm run dashboard:preview -- summary` (VW-943).
//
// One ended four-exercise session, shaped like the completion page's design
// fixture (`dashboard/__tests__/fixtures/session-summary/2-full-session.json`):
// warm-ups before the loaded lifts, verdicts that differ, a damper lift with no
// load, and an add, a hold and a back-off. Three lifts are prescribed in a dated
// block that is in force today; the face pull is not, so its card says so.
//
// Only the recorded sets are written. Every verdict, delta and reasoning line the
// page shows is the server's own, derived at read time by `buildSessionSummary`
// and `computeProgressionDelta`; `src/dashboard/__tests__/summary-preview-seed.test.ts`
// pins what they come to.
//
// Confidentiality: exercise ids, loads, rep counts and velocities only —
// derived fitness metadata, no protocol data of any kind (NF-07).

import { mondayOf } from '../plan/block-calendar.js';
import { LOCAL_USER_ID, type SessionStore, type StoredSet } from '../store/types.js';
import { rep } from './personas/rep.js';

export const SUMMARY_PREVIEW_SESSION_ID = 'preview-summary-session';

/** One recorded set: its load (absent on the damper), its rep count and its velocity decay. */
interface SummaryPreviewSet {
  readonly purpose: 'warmup' | 'working';
  readonly weightLbs?: number;
  readonly reps: number;
  readonly bestMps: number;
  /** How far the last rep's velocity sits below the first's. */
  readonly lossPct: number;
}

interface SummaryPreviewExercise {
  readonly exercise: { readonly id: string; readonly name: string };
  /** The prescription in the dated block, or absent for the lift outside the program. */
  readonly planned?: { readonly repsLow: number; readonly repsHigh: number; readonly lbs: number };
  readonly damperLevel?: number;
  readonly sets: readonly SummaryPreviewSet[];
}

const warmup = (weightLbs: number, reps: number, bestMps: number): SummaryPreviewSet => ({
  purpose: 'warmup',
  weightLbs,
  reps,
  bestMps,
  lossPct: 5,
});

export const SUMMARY_PREVIEW_EXERCISES: readonly SummaryPreviewExercise[] = [
  {
    exercise: { id: 'cable-romanian-deadlift', name: 'Cable Romanian Deadlift' },
    planned: { repsLow: 10, repsHigh: 12, lbs: 120 },
    sets: [
      warmup(60, 8, 0.78),
      warmup(90, 6, 0.7),
      { purpose: 'working', weightLbs: 120, reps: 12, bestMps: 0.62, lossPct: 14 },
      { purpose: 'working', weightLbs: 120, reps: 11, bestMps: 0.6, lossPct: 18 },
      { purpose: 'working', weightLbs: 120, reps: 9, bestMps: 0.58, lossPct: 23 },
    ],
  },
  {
    exercise: { id: 'cable-row', name: 'Cable Row' },
    planned: { repsLow: 12, repsHigh: 14, lbs: 100 },
    sets: [
      warmup(60, 10, 0.84),
      { purpose: 'working', weightLbs: 100, reps: 15, bestMps: 0.71, lossPct: 9 },
      { purpose: 'working', weightLbs: 100, reps: 15, bestMps: 0.7, lossPct: 11 },
      { purpose: 'working', weightLbs: 100, reps: 15, bestMps: 0.69, lossPct: 13 },
    ],
  },
  {
    exercise: { id: 'cable-chest-press', name: 'Cable Chest Press' },
    planned: { repsLow: 8, repsHigh: 10, lbs: 80 },
    sets: [
      warmup(50, 8, 0.66),
      { purpose: 'working', weightLbs: 80, reps: 8, bestMps: 0.55, lossPct: 21 },
      { purpose: 'working', weightLbs: 80, reps: 7, bestMps: 0.52, lossPct: 27 },
      { purpose: 'working', weightLbs: 80, reps: 6, bestMps: 0.49, lossPct: 34 },
    ],
  },
  {
    exercise: { id: 'cable-face-pull', name: 'Cable Face Pull' },
    damperLevel: 5,
    sets: [
      { purpose: 'working', reps: 15, bestMps: 0.88, lossPct: 8 },
      { purpose: 'working', reps: 15, bestMps: 0.86, lossPct: 10 },
    ],
  },
];

/** The store slice the seed writes through. Every write is a public store method. */
export type SummaryPreviewStore = Pick<
  SessionStore,
  | 'putTrainingProgram'
  | 'putTrainingBlock'
  | 'putTrainingWeek'
  | 'appendBlockSchedule'
  | 'putWorkoutTemplate'
  | 'putPlannedExercise'
  | 'putSession'
  | 'putSet'
>;

const MINUTE_MS = 60_000;
const SET_SPACING_MS = 2.5 * MINUTE_MS;
const SET_DURATION_MS = 45_000;
const BLOCK_WEEKS = 4;

/**
 * Write the ended session into `store`, which must be the ONLY holder of its
 * file — the server opens it afterwards, never alongside. The session ends a
 * few minutes before `now`, inside a block that started this week.
 */
export async function seedSummaryPreview(
  store: SummaryPreviewStore,
  now: Date,
): Promise<{ sessionId: string; exercises: number; sets: number }> {
  await seedPrescription(store, now);
  const sets = SUMMARY_PREVIEW_EXERCISES.flatMap((lift) => lift.sets.map((set) => ({ lift, set })));
  const startMs = now.getTime() - 5 * MINUTE_MS - sets.length * SET_SPACING_MS;
  const last = SUMMARY_PREVIEW_EXERCISES[SUMMARY_PREVIEW_EXERCISES.length - 1]!;
  await store.putSession({
    id: SUMMARY_PREVIEW_SESSION_ID,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(startMs + sets.length * SET_SPACING_MS).toISOString(),
    exerciseId: last.exercise.id,
    exerciseName: last.exercise.name,
    kind: 'training',
  });
  for (const [index, { lift, set }] of sets.entries()) {
    await store.putSet(recordedSet(lift, set, index, startMs + index * SET_SPACING_MS));
  }
  return {
    sessionId: SUMMARY_PREVIEW_SESSION_ID,
    exercises: SUMMARY_PREVIEW_EXERCISES.length,
    sets: sets.length,
  };
}

/** A dated block in force today, one template prescribing every planned lift. */
async function seedPrescription(store: SummaryPreviewStore, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await store.putTrainingProgram({
    id: 'preview-summary-program',
    name: 'Preview Program',
    createdAt: nowIso,
  });
  await store.putTrainingBlock({
    id: 'preview-summary-block',
    programId: 'preview-summary-program',
    orderIndex: 0,
    name: 'Block 1 — Accumulation',
    weeksCount: BLOCK_WEEKS,
  });
  await store.putTrainingWeek({
    id: 'preview-summary-week-1',
    blockId: 'preview-summary-block',
    orderIndex: 0,
    name: 'Week 1',
    isDeload: false,
  });
  await store.appendBlockSchedule({
    blockId: 'preview-summary-block',
    startsOn: mondayOf(nowIso),
    weeksCount: BLOCK_WEEKS,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: nowIso,
  });
  await store.putWorkoutTemplate({
    id: 'preview-summary-template',
    weekId: 'preview-summary-week-1',
    name: 'Full Body A',
    orderIndex: 0,
  });
  for (const [orderIndex, { exercise, planned }] of SUMMARY_PREVIEW_EXERCISES.entries()) {
    if (planned === undefined) continue;
    await store.putPlannedExercise({
      id: `preview-summary-planned-${exercise.id}`,
      workoutTemplateId: 'preview-summary-template',
      exerciseId: exercise.id,
      orderIndex,
      targetSets: 3,
      targetRepsLow: planned.repsLow,
      targetRepsHigh: planned.repsHigh,
      targetWeightLbs: planned.lbs,
    });
  }
}

/**
 * One recorded set. `source: 'local'` rather than `'mock'` for the reason
 * `preview-seeds.ts` gives: these stand in for the lifter's own work.
 */
function recordedSet(
  lift: SummaryPreviewExercise,
  set: SummaryPreviewSet,
  index: number,
  startMs: number,
): StoredSet {
  const id = `preview-summary-set-${index + 1}`;
  return {
    id,
    sessionId: SUMMARY_PREVIEW_SESSION_ID,
    userId: LOCAL_USER_ID,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(startMs + SET_DURATION_MS).toISOString(),
    partial: false,
    exerciseId: lift.exercise.id,
    slot: 'primary',
    setPurpose: set.purpose,
    setIndexInSession: index + 1,
    ...(set.weightLbs === undefined
      ? { trainingMode: 'Damper' as const, damperLevel: lift.damperLevel }
      : { trainingMode: 'Weight Training' as const, weightLbs: set.weightLbs }),
    source: 'local',
    reps: decayingReps(id, set),
  };
}

/** Velocities falling evenly from the set's best to `lossPct` below it by the last rep. */
function decayingReps(
  setId: string,
  { reps, bestMps, lossPct }: SummaryPreviewSet,
): StoredSet['reps'] {
  return Array.from({ length: reps }, (_, index) => {
    const velocity = bestMps * (1 - (lossPct / 100) * (index / (reps - 1)));
    return rep(setId, index, Number(velocity.toFixed(3)));
  });
}
