// The first session back after a break: a short, light "baseline session" (VW-982).
//
// It takes up to three lifts the lifter has trained before, from today's template or, with no
// planned workout, from the last training day before today (VW-983). Each gets one working set at
// the re-entry rule's load, and the sets are ordered so relative load falls across the session and
// the last working set is the lightest. When the rule allows a single set per lift, that last set
// is a back-off set of the first lift at 80% of its working load; it is the one set the session
// adds past one per lift. Rests are the plan's or the intent default, and lifts are added only
// while the estimate fits the minutes the caller offers.
//
// A lift with no logged load has nothing to scale, and a rule with no load factor (the long
// band) scales nothing: with no lift left the result is `null`, and the caller points the
// lifter at the starting prescription instead.
//
// Pure: the caller passes the lifts, each lift's last working load and the rule.

import type { SourcedValue } from '../coach-copy/fragments.js';
import type { TrainingIntent } from '../schemas/set.js';
import { RE_ENTRY_LOAD_STEP_LBS, scaleReEntryLoad, type ReEntryRule } from './re-entry.js';
import { defaultRestSeconds } from './rest-defaults.js';

export const BASELINE_SESSION_LABEL = 'baseline session';

const ENJOYMENT_SOURCE =
  'Zenko 2016, https://doi.org/10.1123/jsep.2015-0286; ' +
  'Hutchinson 2020, https://doi.org/10.1123/jsep.2019-0089';

/** The most lifts a baseline session holds. */
export const BASELINE_MAX_LIFTS: SourcedValue<number> = {
  value: 3,
  sourceKind: 'paper',
  sourceRef: ENJOYMENT_SOURCE,
};

/** Relative load falls across the session, so it ends on its lightest set. */
export const BASELINE_DESCENDING_ORDER: SourcedValue<true> = {
  value: true,
  sourceKind: 'paper',
  sourceRef: ENJOYMENT_SOURCE,
};

/** The back-off set's load as a share of the session's first working load. */
export const BASELINE_BACK_OFF_FACTOR: SourcedValue<number> = {
  value: 0.8,
  sourceKind: 'engineering-default',
  sourceRef:
    'Neither paper sizes the lighter final set; 80% matches the short-break cut and sits ' +
    'clearly under the set before it.',
};

/** Seconds one rep takes when the time budget is estimated. */
export const BASELINE_SECONDS_PER_REP: SourcedValue<number> = {
  value: 3,
  sourceKind: 'engineering-default',
  sourceRef: 'A plain estimate of one controlled rep, used only to fit the time budget.',
};

/** Reps assumed for a set whose plan states no rep target. */
const FALLBACK_REPS = 10;

/** The lift fields the baseline reads; a template row carries them all. */
export interface BaselineTemplateExercise {
  readonly exerciseId: string;
  readonly targetRepsLow?: number;
  readonly targetRepsHigh?: number;
  readonly restSec?: number;
  readonly trainingIntent?: TrainingIntent;
}

/** One lift's last working load before the break. */
export interface BaselineHistory {
  readonly topLoadLbs: number;
}

export interface BaselineSet {
  readonly exerciseId: string;
  readonly role: 'working' | 'back_off';
  readonly loadLbs: number;
  /** `loadLbs` over that lift's last working load, to two decimals. */
  readonly relativeLoad: number;
  readonly repsLow?: number;
  readonly repsHigh?: number;
  /** Rest after this set; 0 on the last. */
  readonly restSeconds: number;
}

export interface BaselineSession {
  readonly label: typeof BASELINE_SESSION_LABEL;
  readonly sets: readonly BaselineSet[];
  readonly estimatedMinutes: number;
  readonly minutes: number;
}

interface Lift {
  readonly row: BaselineTemplateExercise;
  readonly topLoadLbs: number;
  readonly loadLbs: number;
  readonly relative: number;
}

/** The baseline session for the offered lifts, or `null` when none has a load to scale. */
export function selectBaselineSession(
  template: readonly BaselineTemplateExercise[],
  historyByExercise: ReadonlyMap<string, BaselineHistory>,
  rule: ReEntryRule,
  minutes: number,
): BaselineSession | null {
  const { loadFactor } = rule;
  if (loadFactor === null) return null;
  const lifts = liftsWithHistory(template, historyByExercise, loadFactor);
  if (lifts.length === 0) return null;
  let session = buildSession(lifts.slice(0, 1), rule, minutes);
  for (let count = 2; count <= Math.min(BASELINE_MAX_LIFTS.value, lifts.length); count += 1) {
    const larger = buildSession(lifts.slice(0, count), rule, minutes);
    if (larger.estimatedMinutes > minutes) break;
    session = larger;
  }
  return session;
}

function liftsWithHistory(
  template: readonly BaselineTemplateExercise[],
  historyByExercise: ReadonlyMap<string, BaselineHistory>,
  loadFactor: number,
): Lift[] {
  const seen = new Set<string>();
  const lifts: Lift[] = [];
  for (const row of template) {
    const history = historyByExercise.get(row.exerciseId);
    if (history === undefined || !(history.topLoadLbs > 0) || seen.has(row.exerciseId)) continue;
    seen.add(row.exerciseId);
    const loadLbs = scaleReEntryLoad(history.topLoadLbs, loadFactor);
    lifts.push({
      row,
      topLoadLbs: history.topLoadLbs,
      loadLbs,
      relative: loadLbs / history.topLoadLbs,
    });
  }
  return lifts;
}

function buildSession(lifts: readonly Lift[], rule: ReEntryRule, minutes: number): BaselineSession {
  const ordered = [...lifts].sort((a, b) => b.relative - a.relative);
  const planned: { lift: Lift; loadLbs: number; role: BaselineSet['role'] }[] = ordered.map(
    (lift) => ({ lift, loadLbs: lift.loadLbs, role: 'working' }),
  );
  const backOff = backOffLoad(ordered[0], ordered[ordered.length - 1].relative);
  if (backOff !== null) planned.push({ lift: ordered[0], loadLbs: backOff, role: 'back_off' });
  const sets = planned.map(({ lift, loadLbs, role }, index) =>
    toSet(lift, loadLbs, role, rule, index === planned.length - 1),
  );
  return { label: BASELINE_SESSION_LABEL, sets, estimatedMinutes: estimateMinutes(sets), minutes };
}

/**
 * 80% of the first working load, stepped down further when rounding leaves it no lighter, in
 * relative terms, than the lightest working set. `null` when even one step is not lighter.
 */
function backOffLoad(first: Lift, lightestRelative: number): number | null {
  let loadLbs = scaleReEntryLoad(first.loadLbs, BASELINE_BACK_OFF_FACTOR.value);
  while (loadLbs / first.topLoadLbs >= lightestRelative && loadLbs > RE_ENTRY_LOAD_STEP_LBS) {
    loadLbs -= RE_ENTRY_LOAD_STEP_LBS;
  }
  return loadLbs / first.topLoadLbs < lightestRelative ? loadLbs : null;
}

function toSet(
  lift: Lift,
  loadLbs: number,
  role: BaselineSet['role'],
  rule: ReEntryRule,
  last: boolean,
): BaselineSet {
  const repsLow = rule.repsLow ?? lift.row.targetRepsLow;
  const repsHigh = rule.repsHigh ?? lift.row.targetRepsHigh;
  return {
    exerciseId: lift.row.exerciseId,
    role,
    loadLbs,
    relativeLoad: Math.round((loadLbs / lift.topLoadLbs) * 100) / 100,
    ...(repsLow !== undefined && { repsLow }),
    ...(repsHigh !== undefined && { repsHigh }),
    restSeconds: last ? 0 : (lift.row.restSec ?? defaultRestSeconds(lift.row.trainingIntent)),
  };
}

function estimateMinutes(sets: readonly BaselineSet[]): number {
  const seconds = sets.reduce((total, set) => {
    const reps = set.repsHigh ?? set.repsLow ?? FALLBACK_REPS;
    return total + reps * BASELINE_SECONDS_PER_REP.value + set.restSeconds;
  }, 0);
  return Math.ceil(seconds / 60);
}
