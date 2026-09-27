// Per-muscle strength read-model for the body-map page (VW-330, plan B3).
//
// PURE. No store, no clock, no tool surface: `server.ts` gathers each
// exercise's sets and its `history.trend`(metric `e1rm`) fit, and this module
// only projects them onto the 15 titan muscle slugs. The maths is entirely
// borrowed — `estimateE1RMFromReps` (the Epley formula the stored
// `estimated_1rm` series is itself built from), `evaluateE1RMPr` (the same PR
// verdict the SPA hero card shows), `e1rmBand` — so a per-muscle page can
// never disagree with the per-exercise pipelines it summarises.
//
// ── SIDES ARE NEVER MERGED ────────────────────────────────────────────────
//
// A bilateral exercise produces ONE ROW PER SIDE. Pooling left and right into
// a single strength number is a display convenience, never the assessment
// reference (`analytics/side-comparison.ts`): the whole point of a per-side
// read is that the two limbs can differ, and an average hides exactly the
// finding it exists to surface. Sets whose `side` is absent are side-unknown
// rows, not "both sides", and group into their own single row.
//
// ── WHAT `agreement` CLAIMS, AND WHAT IT DOES NOT ─────────────────────────
//
// "This muscle got stronger" needs at least two exercises with that primary
// muscle trending the same way (rp:rp-s7-multi-exercise-confirmation-for-
// muscle-gain). `agreement` reports that concordance and nothing else: it is
// the AGREEMENT OF SIGNS between separate exercises, not a magnitude verdict.
// VW-230 withheld `history.trend`'s own up/down/flat `direction` for want of a
// citable flat threshold on a load series, and nothing here reinstates one —
// a row's direction is the sign of its fitted slope, reported only once the
// fit has a residual degree of freedom to disagree with the data.
//
// Confidentiality: derived fitness metadata only — loads, reps, muscle names.
// No device settings, frames or protocol values (NF-07).

import { estimateE1RMFromReps, type E1RMEstimate } from '@voltras/workout-analytics';

import { evaluateE1RMPr } from '../../analytics/e1rm-pr.js';
import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import { e1rmBand, type E1RMBand, type E1RMMethod } from '../../tools/e1rm-band.js';
import type { StoredSide } from '../../store/types.js';

/**
 * Every magnitude this projector applies, with its source — the labelling
 * convention `analytics/goal-band.ts` uses, so a reader can tell a mined
 * finding from a call someone made.
 */
export const MUSCLE_STRENGTH_CONSTANTS = {
  /**
   * Exercises that must trend the same way before `agreement` names a
   * direction. rp:rp-s7-multi-exercise-confirmation-for-muscle-gain
   */
  minExercisesForAgreement: 2,
  /**
   * Weekly points a fit needs before its slope's sign is reported at all.
   *
   * STATISTICAL CONVENTION. Three is the fewest that leaves a least-squares
   * line a residual degree of freedom, so the fit can disagree with the data;
   * two points always fit perfectly and their "trend" is just the pair.
   */
  minSeriesPointsForDirection: 3,
  /**
   * Years of training below which strength gains are not read as muscle gains.
   * rp:rp-s7-early-strength-gains-not-pure-muscle-signal states a 6-to-12-month
   * window; this is its lower edge, so the flag is raised for at least as long
   * as the corpus says to hold the inference.
   */
  earlyPhaseYears: 0.5,
  /** ENGINEERING DEFAULT (design 4.4): the current level weighs the last this-many sessions. */
  recencySessions: 6,
  /** ENGINEERING DEFAULT (design 4.4): a session's weight halves every this-many days. */
  recencyHalfLifeDays: 28,
  /** Design 4.4: over this many days since trained, the body map draws the muscle at half opacity. */
  fadingAfterDays: 28,
  /** Design 4.4: over this many days, the body map outlines the muscle only, "no current read". */
  noCurrentReadAfterDays: 183,
} as const;

/** Which limb a row covers. `null` means the sets recorded no side. */
export type MuscleStrengthSide = StoredSide | null;

/** Grouping key for {@link MuscleStrengthSide}; `'none'` is the side-unknown group. */
export type MuscleStrengthSideKey = StoredSide | 'none';

/** The fields of one stored set this projection reads. */
export interface MuscleStrengthSetRow {
  sessionId: string;
  startedAt: string;
  side: MuscleStrengthSide;
  /** `null` when the set recorded no header weight — no load, no e1RM. */
  weightLbs: number | null;
  /** Firmware-canonical count, resolved by the caller. */
  repCount: number;
}

/** The slice of `history.trend`(metric `e1rm`) the projection reads. */
export interface MuscleStrengthTrend {
  trend: { slope: number; intercept: number; rSquared: number; pointCount: number };
  plateau: { verdict: 'plateau' | 'tolerated' | 'none' };
}

/** One exercise's window of sets, plus its per-side fits. */
export interface MuscleStrengthExerciseInput {
  exerciseId: string;
  name: string;
  /** Titan slugs this exercise targets, from the attribution table (VW-561). */
  primaryMuscles: readonly TitanMuscleGroup[];
  sets: readonly MuscleStrengthSetRow[];
  /** Each fit is scoped to that side's own sets — never a pooled one. */
  trendBySide: Partial<Record<MuscleStrengthSideKey, MuscleStrengthTrend>>;
}

export interface MuscleStrengthInput {
  exercises: readonly MuscleStrengthExerciseInput[];
  /** Self-reported years of training; `null` when never declared. */
  yearsTraining: number | null;
  /** The instant recency is read at; without it `daysSinceTrained` and `recency` are `null`. */
  asOf?: string;
}

/** The best e1RM in the window, with the band every e1RM here travels with. */
export interface MuscleStrengthBestE1rm {
  value: number;
  band: E1RMBand;
  method: E1RMMethod;
  /** WA's own 0-1 score for the estimate; falls with rep count. */
  confidence: number;
}

export interface MuscleStrengthExerciseRow {
  exerciseId: string;
  name: string;
  side: MuscleStrengthSide;
  bestE1rm: MuscleStrengthBestE1rm | null;
  /** Fitted change per week as a percentage of the fit's own day-0 value. */
  slopePctPerWeek: number | null;
  rSquared: number | null;
  isPR: boolean;
  priorBest: number | null;
  plateau: 'plateau' | 'tolerated' | 'none' | null;
  /** Recency-weighted mean of the last sessions' best e1RMs; `null` with no e1RM. */
  /** Sets in this row: the weight its relative index carries in the muscle's mean. */
  setCount: number;
  currentLevel: number | null;
  /** `currentLevel` over the best e1RM in these rows, 0 to 100 percent. Never pooled across sides. */
  relativeIndex: number | null;
  daysSinceTrained: number | null;
  recency: MuscleStrengthRecency | null;
}

export type MuscleStrengthRecency = 'current' | 'fading' | 'no_current_read';

export type MuscleStrengthAgreement = 'stronger' | 'weaker' | 'mixed' | 'insufficient';

export interface MuscleStrengthMuscle {
  muscle: TitanMuscleGroup;
  exercises: MuscleStrengthExerciseRow[];
  agreement: MuscleStrengthAgreement;
  /** True while strength gains are not yet readable as muscle gains. */
  earlyPhase: boolean;
  /** Set-weighted mean of the rows' relative indices, one per side group; sides never pool. */
  relativeIndexBySide: Partial<Record<MuscleStrengthSideKey, number>>;
  /** Days since any row of this muscle was trained; `null` without `asOf` or rows. */
  daysSinceTrained: number | null;
}

export interface MuscleStrengthView {
  muscleMapVersion: string;
  muscles: MuscleStrengthMuscle[];
  agreementBasis: string;
  earlyPhaseBasis: string;
}

const AGREEMENT_BASIS =
  'Agreement of SIGNS between separate exercises sharing this primary muscle, never a ' +
  `magnitude verdict: ${MUSCLE_STRENGTH_CONSTANTS.minExercisesForAgreement} exercises must ` +
  'trend the same way before a muscle is called stronger or weaker ' +
  '(rp:rp-s7-multi-exercise-confirmation-for-muscle-gain). A row contributes a sign only once ' +
  `its weekly fit has ${MUSCLE_STRENGTH_CONSTANTS.minSeriesPointsForDirection} points; no ` +
  'citable flat threshold exists for a load trend (VW-230), so none is applied here either.';

/** Which side group a set belongs to. Side-unknown is its own group, not "both". */
function sideKeyOf(side: MuscleStrengthSide): MuscleStrengthSideKey {
  return side ?? 'none';
}

function sideOfKey(key: MuscleStrengthSideKey): MuscleStrengthSide {
  return key === 'none' ? null : key;
}

/** The Epley estimate for one set, or null when it carries no usable load/reps. */
function estimateForSet(set: MuscleStrengthSetRow): E1RMEstimate | null {
  if (set.weightLbs === null || !Number.isFinite(set.weightLbs) || set.repCount <= 0) return null;
  return estimateE1RMFromReps(set.weightLbs, set.repCount);
}

/** The highest e1RM among these sets, or null when none yields one. */
function bestEstimate(sets: readonly MuscleStrengthSetRow[]): E1RMEstimate | null {
  let best: E1RMEstimate | null = null;
  for (const set of sets) {
    const estimate = estimateForSet(set);
    if (estimate !== null && (best === null || estimate.e1RM > best.e1RM)) best = estimate;
  }
  return best;
}

/** The session id of the most recent set in the group. */
function latestSessionId(sets: readonly MuscleStrengthSetRow[]): string | null {
  let latest: MuscleStrengthSetRow | null = null;
  for (const set of sets) {
    if (latest === null || set.startedAt > latest.startedAt) latest = set;
  }
  return latest?.sessionId ?? null;
}

/**
 * The PR verdict for this group: its newest session's best e1RM against the
 * best of everything before it, through the shared `evaluateE1RMPr`. A group
 * with only one session has no prior best and is never a PR, which is
 * `isNewE1RM`'s own no-baseline contract.
 */
function prForGroup(sets: readonly MuscleStrengthSetRow[]): {
  isPR: boolean;
  priorBest: number | null;
} {
  const newest = latestSessionId(sets);
  if (newest === null) return evaluateE1RMPr(null, null);
  const current = bestEstimate(sets.filter((s) => s.sessionId === newest));
  const prior = bestEstimate(sets.filter((s) => s.sessionId !== newest));
  return evaluateE1RMPr(current?.e1RM ?? null, prior?.e1RM ?? null);
}

/** Two decimals — a percent-per-week figure carries no more precision than that. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The fit's weekly change as a percentage of its own day-0 value. Null when
 * the fit is too short to carry a sign, or when its day-0 value is not a
 * positive load to take a percentage of.
 */
function slopePctPerWeek(fit: MuscleStrengthTrend | undefined): number | null {
  if (fit === undefined) return null;
  const { slope, intercept, pointCount } = fit.trend;
  if (pointCount < MUSCLE_STRENGTH_CONSTANTS.minSeriesPointsForDirection) return null;
  if (!(intercept > 0)) return null;
  return round2(((slope * 7) / intercept) * 100);
}

function bestE1rmOf(sets: readonly MuscleStrengthSetRow[]): MuscleStrengthBestE1rm | null {
  const best = bestEstimate(sets);
  if (best === null) return null;
  return {
    value: best.e1RM,
    band: e1rmBand(best.e1RM, best.method),
    method: best.method,
    confidence: best.confidence,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each session's best e1RM at its latest set, oldest first. */
function sessionBests(sets: readonly MuscleStrengthSetRow[]): { at: number; e1rm: number }[] {
  const bySession = new Map<string, { at: number; e1rm: number }>();
  for (const set of sets) {
    const estimate = estimateForSet(set);
    if (estimate === null) continue;
    const prior = bySession.get(set.sessionId);
    const at = Math.max(Date.parse(set.startedAt), prior?.at ?? -Infinity);
    bySession.set(set.sessionId, { at, e1rm: Math.max(estimate.e1RM, prior?.e1rm ?? 0) });
  }
  return [...bySession.values()].sort((a, b) => a.at - b.at);
}

/** The weighted mean of the last sessions' bests, each weight halving per half-life of age. */
function currentLevelOf(sets: readonly MuscleStrengthSetRow[]): number | null {
  const { recencySessions, recencyHalfLifeDays } = MUSCLE_STRENGTH_CONSTANTS;
  const recent = sessionBests(sets).slice(-recencySessions);
  const latest = recent.at(-1);
  if (latest === undefined) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const session of recent) {
    const weight = 0.5 ** ((latest.at - session.at) / DAY_MS / recencyHalfLifeDays);
    weighted += weight * session.e1rm;
    totalWeight += weight;
  }
  return round2(weighted / totalWeight);
}

function daysSinceTrainedOf(sets: readonly MuscleStrengthSetRow[], asOf?: string): number | null {
  if (asOf === undefined || sets.length === 0) return null;
  const latest = Math.max(...sets.map((set) => Date.parse(set.startedAt)));
  return Math.floor((Date.parse(asOf) - latest) / DAY_MS);
}

function recencyOf(days: number | null): MuscleStrengthRecency | null {
  if (days === null) return null;
  if (days > MUSCLE_STRENGTH_CONSTANTS.noCurrentReadAfterDays) return 'no_current_read';
  return days > MUSCLE_STRENGTH_CONSTANTS.fadingAfterDays ? 'fading' : 'current';
}

/** Current level, its index against the rows' best, and how long ago they were trained. */
function recencyFields(sets: readonly MuscleStrengthSetRow[], asOf?: string) {
  const currentLevel = currentLevelOf(sets);
  const best = bestEstimate(sets);
  const daysSinceTrained = daysSinceTrainedOf(sets, asOf);
  return {
    setCount: sets.length,
    currentLevel,
    relativeIndex:
      currentLevel === null || best === null ? null : round2((currentLevel / best.e1RM) * 100),
    daysSinceTrained,
    recency: recencyOf(daysSinceTrained),
  };
}

/** One (exercise, side) row. `sets` are already scoped to that side. */
function buildRow(
  exercise: MuscleStrengthExerciseInput,
  key: MuscleStrengthSideKey,
  sets: readonly MuscleStrengthSetRow[],
  asOf?: string,
): MuscleStrengthExerciseRow {
  const fit = exercise.trendBySide[key];
  return {
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    side: sideOfKey(key),
    bestE1rm: bestE1rmOf(sets),
    slopePctPerWeek: slopePctPerWeek(fit),
    rSquared: fit?.trend.rSquared ?? null,
    ...prForGroup(sets),
    plateau: fit?.plateau.verdict ?? null,
    ...recencyFields(sets, asOf),
  };
}

/**
 * One row per side the sets actually recorded. An exercise with no sets in the
 * window still yields a single side-unknown row, so a fit without stored sets
 * is visible rather than silently dropped.
 */
function buildExerciseRows(
  exercise: MuscleStrengthExerciseInput,
  asOf?: string,
): MuscleStrengthExerciseRow[] {
  const bySide = new Map<MuscleStrengthSideKey, MuscleStrengthSetRow[]>();
  for (const set of exercise.sets) {
    const key = sideKeyOf(set.side);
    const group = bySide.get(key);
    if (group === undefined) bySide.set(key, [set]);
    else group.push(set);
  }
  if (bySide.size === 0) return [buildRow(exercise, 'none', [], asOf)];
  return [...bySide.entries()].map(([key, sets]) => buildRow(exercise, key, sets, asOf));
}

/**
 * This exercise's own sign: `up`/`down` only when every one of its side rows
 * agrees. A lifter whose left limb rose while the right fell has no
 * exercise-level finding, and averaging the two would manufacture one.
 */
function exerciseSign(rows: readonly MuscleStrengthExerciseRow[]): 'up' | 'down' | null {
  const signs = rows.map((row) =>
    row.slopePctPerWeek === null || row.slopePctPerWeek === 0
      ? null
      : row.slopePctPerWeek > 0
        ? ('up' as const)
        : ('down' as const),
  );
  const first = signs[0];
  if (first === undefined || first === null) return null;
  return signs.every((sign) => sign === first) ? first : null;
}

function agreementOf(rows: readonly MuscleStrengthExerciseRow[]): MuscleStrengthAgreement {
  const byExercise = new Map<string, MuscleStrengthExerciseRow[]>();
  for (const row of rows) {
    const group = byExercise.get(row.exerciseId);
    if (group === undefined) byExercise.set(row.exerciseId, [row]);
    else group.push(row);
  }
  const signs = [...byExercise.values()].map(exerciseSign).filter((sign) => sign !== null);
  const { minExercisesForAgreement } = MUSCLE_STRENGTH_CONSTANTS;
  if (signs.length < minExercisesForAgreement) return 'insufficient';
  const ups = signs.filter((sign) => sign === 'up').length;
  const downs = signs.length - ups;
  if (ups >= minExercisesForAgreement && downs === 0) return 'stronger';
  if (downs >= minExercisesForAgreement && ups === 0) return 'weaker';
  return 'mixed';
}

/** Per side group, the set-weighted mean of the rows' relative indices (design 4.4, P5). */
function relativeIndexBySide(
  rows: readonly MuscleStrengthExerciseRow[],
): Partial<Record<MuscleStrengthSideKey, number>> {
  const sums = new Map<MuscleStrengthSideKey, { weighted: number; sets: number }>();
  for (const row of rows) {
    if (row.relativeIndex === null || row.setCount === 0) continue;
    const key = sideKeyOf(row.side);
    const sum = sums.get(key) ?? { weighted: 0, sets: 0 };
    sums.set(key, {
      weighted: sum.weighted + row.relativeIndex * row.setCount,
      sets: sum.sets + row.setCount,
    });
  }
  return Object.fromEntries([...sums].map(([key, sum]) => [key, round2(sum.weighted / sum.sets)]));
}

function muscleDaysSinceTrained(rows: readonly MuscleStrengthExerciseRow[]): number | null {
  const days = rows.flatMap((row) => (row.daysSinceTrained === null ? [] : [row.daysSinceTrained]));
  return days.length === 0 ? null : Math.min(...days);
}

function earlyPhaseFrom(yearsTraining: number | null): boolean {
  return yearsTraining !== null && yearsTraining < MUSCLE_STRENGTH_CONSTANTS.earlyPhaseYears;
}

function earlyPhaseBasisFor(yearsTraining: number | null): string {
  const held =
    'rp:rp-s7-early-strength-gains-not-pure-muscle-signal — under ' +
    `${MUSCLE_STRENGTH_CONSTANTS.earlyPhaseYears} years of training, a rising e1RM is as much ` +
    'skill as tissue, so a strength trend is not read as a muscle gain. Rows are flagged, never ' +
    'dropped.';
  if (yearsTraining === null) {
    return `Not raised: no self-reported years of training to judge it against. ${held}`;
  }
  return `Self-reported training age ${yearsTraining} years. ${held}`;
}

/**
 * Project per-exercise trends and sets onto every titan muscle slug. All 15
 * slugs are always present — a muscle with nothing trained is an empty
 * `exercises` list and `agreement: 'insufficient'`, which is a finding.
 */
export function buildMuscleStrengthView(input: MuscleStrengthInput): MuscleStrengthView {
  const rowsByExercise = input.exercises.map(
    (exercise) => [exercise, buildExerciseRows(exercise, input.asOf)] as const,
  );
  const earlyPhase = earlyPhaseFrom(input.yearsTraining);
  const muscles = TITAN_MUSCLE_GROUPS.map((muscle) => {
    const exercises = rowsByExercise
      .filter(([exercise]) => exercise.primaryMuscles.includes(muscle))
      .flatMap(([, rows]) => rows);
    return {
      muscle,
      exercises,
      agreement: agreementOf(exercises),
      earlyPhase,
      relativeIndexBySide: relativeIndexBySide(exercises),
      daysSinceTrained: muscleDaysSinceTrained(exercises),
    };
  });
  return {
    muscleMapVersion: MUSCLE_MAP_VERSION,
    muscles,
    agreementBasis: AGREEMENT_BASIS,
    earlyPhaseBasis: earlyPhaseBasisFor(input.yearsTraining),
  };
}
