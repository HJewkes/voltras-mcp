/**
 * The session-completion page's derivation layer (VW-937).
 *
 * Pure and store-free, like `planner-model.ts`: every number and choice the
 * page shows is made here over the `SessionSummaryView` wire type, so the
 * `.tsx` stays markup and the rules stay unit-testable. Visible text comes
 * from `SUMMARY_FRAGMENTS`; this module returns kinds and numbers, plus the
 * two filled labels that carry numbers of their own.
 */
import { estimateE1RMFromReps } from '@voltras/workout-analytics';

import { classifyRepsAgainstBand, type RepBandClass } from '../../../analytics/rep-band.js';
import type { RepsToThresholdRange } from '../../../analytics/reps-to-threshold-range.js';
import { SUMMARY_FRAGMENTS as LINES } from '../../../coach-copy/dashboard.js';
import { fillSlots } from '../../../coach-copy/fill.js';
import { selectWorkingSets } from '../../../store/working-sets.js';
import { formatMass, type MassUnit } from '../live-page/mass';
import {
  e1rmChangePct,
  e1rmSeries,
  isRealSummarySet,
  nextTargetWeightLbs,
  sessionRollup,
  type SessionRollup,
} from './planner-model';
import type {
  SessionSummaryExercise,
  SessionSummarySet,
  SessionSummaryView,
} from '../../read-models/session-summary-view';

/**
 * Next session's load: the top working load plus the recommended delta.
 * Never `progression.targetWeightLbs`, which is the PLANNED load this session
 * was scored against, not the load the recommendation moves to.
 */
export function nextLoad(exercise: SessionSummaryExercise): number | null {
  return nextTargetWeightLbs(exercise);
}

/**
 * The delta as the difference of the two loads the page displays, so a chip
 * always adds up with the numbers beside it: 140 to 135 lb reads 64 to 61 kg,
 * which is -3 kg, where converting the raw -5 lb would say -2 kg.
 */
export function displayDelta(exercise: SessionSummaryExercise, unit: MassUnit): number | null {
  const next = nextLoad(exercise);
  if (next === null || exercise.progression === null) return null;
  const from = next - exercise.progression.delta;
  return formatMass(next, unit).value - formatMass(from, unit).value;
}

/** One scored set's rep count against the planned band. */
export interface RepMark {
  /** 1-based session ordinal, as `SessionSummarySet.index`. */
  index: number;
  repCount: number;
  mark: RepBandClass;
}

/**
 * The sets the recommendation scored, marked by the same rule its tally uses:
 * `selectWorkingSets`, then rep count alone against the band. An unloaded set
 * is scored when no set of the exercise recorded a load, and dropped beside a
 * loaded one, exactly as the server does. Empty with no rep band to score.
 */
export function repMarks(exercise: SessionSummaryExercise): RepMark[] {
  const low = exercise.progression?.targetRepsLow ?? null;
  if (low === null) return [];
  const high = exercise.progression?.targetRepsHigh ?? undefined;
  return selectWorkingSets(exercise.sets).map((set) => ({
    index: set.index,
    repCount: set.repCount,
    mark: classifyRepsAgainstBand(set.repCount, low, high),
  }));
}

export type Disagreement =
  | 'moved-well-missed-reps'
  | 'moved-well-plan-backs-off'
  | 'struggled-plan-adds';

/**
 * Whether the verdict and the recommendation point opposite ways. A back-off
 * beside a good verdict blames the reps only when most scored sets really fell
 * short: the technique gate, a session with no sets and the diet-phase table
 * can all back off too, and the page must not invent a miss.
 *
 * Keyed on the verdict state, not its tone: slowing is a typical stopping
 * point and shares the warn tone with grinding, so only grinding or a form
 * breakdown counts as a struggle (VW-955).
 */
export function disagreement(exercise: SessionSummaryExercise): Disagreement | null {
  const { verdict, progression } = exercise;
  if (verdict === null || progression === null) return null;
  if (verdict.state === 'good' && progression.delta < 0) {
    return mostSetsMissed(repMarks(exercise))
      ? 'moved-well-missed-reps'
      : 'moved-well-plan-backs-off';
  }
  if (STRUGGLE_STATES.has(verdict.state) && progression.delta > 0) return 'struggled-plan-adds';
  return null;
}

const STRUGGLE_STATES: ReadonlySet<string> = new Set(['grinding', 'form-breakdown']);

/** The server's strict majority: a tie is not a majority. */
function mostSetsMissed(marks: readonly RepMark[]): boolean {
  const missed = marks.filter((m) => m.mark === 'under').length;
  return missed >= Math.floor(marks.length / 2) + 1;
}

/** One set's estimated 1RM; null for a set that is not evidence of strength. */
export interface SetE1rm {
  index: number;
  e1rm: number | null;
}

/**
 * e1RM per set, in set order, by the same estimator and rules as `e1rmSeries`:
 * only a working set with a load and reps has one, so a warm-up or an
 * unloaded set gets null rather than a fabricated number.
 */
export function e1rmBySet(exercise: SessionSummaryExercise): SetE1rm[] {
  const working = new Set(selectWorkingSets(exercise.sets));
  return exercise.sets.map((set) => ({
    index: set.index,
    e1rm: working.has(set) ? setE1rm(set) : null,
  }));
}

function setE1rm(set: SessionSummarySet): number | null {
  if (set.weightLbs === null || set.weightLbs <= 0 || set.repCount <= 0) return null;
  return Math.round(estimateE1RMFromReps(set.weightLbs, set.repCount).e1RM * 10) / 10;
}

/**
 * The set with this session's best e1RM, first on a tie. Null with fewer than
 * two estimates: one set has nothing to be best against. It never claims an
 * all-time best, since the page sees one session.
 */
export function bestE1rmIndex(exercise: SessionSummaryExercise): number | null {
  const scored = e1rmBySet(exercise).filter(
    (s): s is { index: number; e1rm: number } => s.e1rm !== null,
  );
  if (scored.length < 2) return null;
  return scored.reduce((best, s) => (s.e1rm > best.e1rm ? s : best)).index;
}

export interface HeaderTotals extends SessionRollup {
  /** Sets with reps but no load, which the volume total leaves out. */
  unloadedSetCount: number;
  /** The "excl. N unloaded sets" label, or null when every set had a load. */
  unloadedLabel: string | null;
}

export function headerTotals(summary: SessionSummaryView): HeaderTotals {
  const unloadedSetCount = summary.exercises
    .flatMap((exercise) => exercise.sets)
    .filter((set) => isRealSummarySet(set) && set.weightLbs === null).length;
  return {
    ...sessionRollup(summary),
    unloadedSetCount,
    unloadedLabel: unloadedLabel(unloadedSetCount),
  };
}

function unloadedLabel(count: number): string | null {
  if (count === 0) return null;
  const line = count === 1 ? LINES.unloadedSetsOneLabel : LINES.unloadedSetsManyLabel;
  return fillSlots(line.text, { count: `${count}` });
}

/**
 * The lifter's usual rep range at this exercise's load, read off the heaviest
 * working set that has one. Null below the history the range needs.
 */
export function usualRange(exercise: SessionSummaryExercise): RepsToThresholdRange | null {
  let heaviest: SessionSummarySet | null = null;
  for (const set of selectWorkingSets(exercise.sets)) {
    if (set.expectedRepRange === null) continue;
    if (heaviest === null || (set.weightLbs ?? 0) > (heaviest.weightLbs ?? 0)) heaviest = set;
  }
  return heaviest?.expectedRepRange ?? null;
}

/** "WORST SET #5 · VL23%": the set the verdict read. Null without a verdict. */
export function verdictKicker(exercise: SessionSummaryExercise): string | null {
  const { verdict, verdictSetIndex, maxVelocityLossPct } = exercise;
  if (verdict === null || verdictSetIndex === null || maxVelocityLossPct === null) return null;
  return fillSlots(LINES.verdictSetKickerLabel.text, {
    set: `${verdictSetIndex}`,
    lossPct: `${Math.round(maxVelocityLossPct)}`,
  });
}

export type AbsentReason = 'not-scored' | 'no-bar-speed' | 'no-verdict';

/** Why the verdict column is empty, or null when there is a verdict to show. */
export function absentReason(exercise: SessionSummaryExercise): AbsentReason | null {
  if (exercise.verdict !== null) return null;
  const working = selectWorkingSets(exercise.sets);
  if (working.length === 0) return 'not-scored';
  if (working.every((set) => set.velocityLossPct === null)) return 'no-bar-speed';
  return 'no-verdict';
}

const MINUS = '−';

/** "3×10–12", unspaced per the design floor; null without a planned rep band. */
export function repScheme(exercise: SessionSummaryExercise): string | null {
  const progression = exercise.progression;
  if (progression === null || progression.targetRepsLow === null) return null;
  const { targetSets, targetRepsLow: low, targetRepsHigh: high } = progression;
  const reps = high === null || high === low ? `${low}` : `${low}–${high}`;
  return `${targetSets}×${reps}`;
}

/** "Add 5 lb", "Hold" or "Back off 3 kg", worded from the displayed loads. */
export function nextTimeChip(exercise: SessionSummaryExercise, unit: MassUnit): string | null {
  const progression = exercise.progression;
  if (progression === null) return null;
  if (progression.delta === 0) return 'Hold';
  const shown = displayDelta(exercise, unit);
  const amount = Math.abs(shown ?? formatMass(progression.delta, unit).value);
  const label = `${amount} ${unitLabel(unit)}`;
  return progression.delta > 0 ? `Add ${label}` : `Back off ${label}`;
}

function unitLabel(unit: MassUnit): string {
  return unit === 'kg' ? 'kg' : 'lb';
}

/**
 * Server prose quotes its loads in lb. Until it carries structured fields the
 * page shows it verbatim, tagged in kg mode so its numbers never read as kg.
 */
export function serverProse(text: string, unit: MassUnit): string {
  return unit === 'kg' ? `${text} (in lb)` : text;
}

/** "VL 14%→23%", first working set to last; null without two readings. */
export function fatigueFact(exercise: SessionSummaryExercise): string | null {
  const losses = trendSets(exercise)
    .map((set) => set.velocityLossPct)
    .filter((loss): loss is number => loss !== null);
  const first = losses[0];
  const last = losses[losses.length - 1];
  if (first === undefined || last === undefined || losses.length < 2) return null;
  return `VL ${Math.round(first)}%→${Math.round(last)}%`;
}

/**
 * The working sets a first-to-last fact reads: one side only when the sets are
 * sided, the side that finished, so a left/right asymmetry never reads as a
 * change within the session (VW-951).
 */
function trendSets(exercise: SessionSummaryExercise): SessionSummarySet[] {
  const working = selectWorkingSets(exercise.sets);
  const side = working.at(-1)?.side ?? null;
  return side === null ? working : working.filter((set) => set.side === side);
}

/** "e1RM 168→156 · −7%" in the display unit; null without two estimates. */
export function strengthFact(exercise: SessionSummaryExercise, unit: MassUnit): string | null {
  const series = e1rmSeries({ ...exercise, sets: trendSets(exercise) });
  const changePct = e1rmChangePct(series);
  const first = series[0];
  const last = series[series.length - 1];
  if (changePct === null || first === undefined || last === undefined) return null;
  const from = formatMass(first.e1rm, unit).value;
  const to = formatMass(last.e1rm, unit).value;
  const rounded = Math.round(changePct);
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '';
  return ['e1RM', `${from}→${to}`, '·', `${sign}${Math.abs(rounded)}%`].join(' ');
}

/** `#3`, or `#3 L` / `#4 R` for one side of a bilateral pair. */
export function setLabel(set: SessionSummarySet): string {
  if (set.side === 'left') return `#${set.index} L`;
  if (set.side === 'right') return `#${set.index} R`;
  return `#${set.index}`;
}

/**
 * What a set counted as. A working-purpose set the scoring dropped (lighter
 * than the top load, or unloaded beside a loaded one) is named for what
 * happened to it, not for the purpose it was started with.
 */
export function setKind(set: SessionSummarySet, scored: boolean): string {
  if (scored) return 'working';
  if (set.setPurpose === 'warmup') return 'warm-up';
  return set.setPurpose === 'working' ? 'not scored' : set.setPurpose;
}
