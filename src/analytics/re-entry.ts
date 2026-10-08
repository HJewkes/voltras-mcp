// The re-entry rule after a break from training (VW-851, slice VW-905).
//
// A break is the whole calendar days since the last training day (the VW-462 rule in
// `training-days.ts`), across every lift. Its band says how the first days back are loaded:
//
// - `none`, 14 days or fewer: nothing changes.
// - `short`, 15 to 28 days: the first week back at 0.8 x the last working load, then the plan
//   resumes.
// - `medium`, 29 to 182 days: two weeks at a fixed load of one third of the last working load,
//   20 to 30 reps, one working set per muscle.
// - `long`, over 182 days: no scaled load; the lifter re-enters through the starting
//   prescription's feeler set.
//
// The owner ruled on the blend of the two layoff sources on 2026-09-26: the short band is the
// Stronger By Science cut unchanged, and the medium band takes its one-third load with the RP
// layoff video's rep range and single working set. One third of a working load always sits under
// 45% of that lift's e1RM, the other ceiling the medium rule names, so no e1RM is read here.
//
// Pure: the caller passes the training days and today's local date. Bump RE_ENTRY_VERSION on
// any change to a band edge or a rule.

import type { SourcedValue } from '../coach-copy/fragments.js';

export const RE_ENTRY_VERSION = 1;

export type BreakBand = 'none' | 'short' | 'medium' | 'long';

export type ReEntryPhase = 'training' | 'in_gap' | 'returning' | 'no_history';

/** How the first days back are loaded; `loadFactor` scales the last working load. */
export interface ReEntryRule {
  /** `null` when no old load is scaled at all (the `long` band). */
  readonly loadFactor: number | null;
  readonly repsLow?: number;
  readonly repsHigh?: number;
  readonly setsPerMuscle?: number;
  /** Length of the re-entry window from the first session back; 0 when there is none. */
  readonly weeks: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SHORT_BREAK_SOURCE = 'Nuckols 2022, https://www.strongerbyscience.com/detraining/';

const MEDIUM_BREAK_SOURCE =
  `${SHORT_BREAK_SOURCE}; ` +
  'Renaissance Periodization 2021, https://www.youtube.com/watch?v=8vLOHvpwZbo';

/** The last day count each band still holds; a longer break falls in the next band. */
export const BREAK_BAND_MAX_DAYS: Readonly<
  Record<Exclude<BreakBand, 'long'>, SourcedValue<number>>
> = {
  none: {
    value: 14,
    sourceKind: 'paper',
    sourceRef:
      'Hwang 2017, https://pubmed.ncbi.nlm.nih.gov/28328712/; ' +
      'Ogasawara 2011, https://pubmed.ncbi.nlm.nih.gov/21771261/',
  },
  short: { value: 28, sourceKind: 'paper', sourceRef: SHORT_BREAK_SOURCE },
  medium: { value: 182, sourceKind: 'paper', sourceRef: MEDIUM_BREAK_SOURCE },
};

/** The rule for each band that changes anything. */
export const RE_ENTRY_RULES: Readonly<
  Record<Exclude<BreakBand, 'none'>, SourcedValue<ReEntryRule>>
> = {
  short: {
    value: { loadFactor: 0.8, weeks: 1 },
    sourceKind: 'paper',
    sourceRef: SHORT_BREAK_SOURCE,
  },
  medium: {
    value: { loadFactor: 1 / 3, repsLow: 20, repsHigh: 30, setsPerMuscle: 1, weeks: 2 },
    sourceKind: 'paper',
    sourceRef: MEDIUM_BREAK_SOURCE,
  },
  long: {
    value: { loadFactor: null, weeks: 0 },
    sourceKind: 'engineering-default',
    sourceRef:
      'After more than six months off an old working load says little about today, so the ' +
      'lifter re-enters through the feeler set; shaped by Nuckols 2022 treating a long layoff ' +
      'as untrained and by the ACSM definition of an untrained lifter.',
  },
};

export interface ReEntryRead {
  readonly lastTrainingDay: string | null;
  readonly daysSinceLastTrainingDay: number | null;
  readonly phase: ReEntryPhase;
  readonly band: BreakBand;
  /** The break the band was read from: the open one, or the last one a returning lifter closed. */
  readonly gapDays: number | null;
  /** The last day of the re-entry window, inclusive; `null` when the band has no window. */
  readonly windowEndsOn: string | null;
  readonly rule: SourcedValue<ReEntryRule> | null;
  readonly reasoning: string;
}

export interface ReEntryInput {
  /** Distinct local training days, oldest first, as `training-days.ts` returns them. */
  readonly trainingDays: readonly string[];
  /** Today's local calendar date, 'YYYY-MM-DD'. */
  readonly today: string;
}

/** The band a break of `days` whole days falls in. */
export function classifyBreak(days: number): BreakBand {
  if (days <= BREAK_BAND_MAX_DAYS.none.value) return 'none';
  if (days <= BREAK_BAND_MAX_DAYS.short.value) return 'short';
  if (days <= BREAK_BAND_MAX_DAYS.medium.value) return 'medium';
  return 'long';
}

/** Local dates parse as UTC midnight, so the difference is whole days with no DST drift. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function ruleFor(band: BreakBand): SourcedValue<ReEntryRule> | null {
  return band === 'none' ? null : RE_ENTRY_RULES[band];
}

/** The inclusive last day of a window opened on `firstDayBack`, or `null` when there is none. */
function windowEnd(band: BreakBand, firstDayBack: string): string | null {
  const weeks = ruleFor(band)?.value.weeks ?? 0;
  return weeks === 0 ? null : addDays(firstDayBack, weeks * 7 - 1);
}

/** The most recent break that changed anything, and the training day that ended it. */
function lastClosedBreak(days: readonly string[]): { gapDays: number; endsOn: string } | null {
  for (let index = days.length - 1; index > 0; index -= 1) {
    const gapDays = daysBetween(days[index - 1], days[index]);
    if (classifyBreak(gapDays) !== 'none') return { gapDays, endsOn: days[index] };
  }
  return null;
}

/**
 * What today's session should do about the latest break. An open break of 15+ days is `in_gap`,
 * with the window it would open if the lifter trains today. After the first session back the
 * days-since drops to 0, but the window that break opened still holds: that is `returning`.
 */
export function selectReEntry({ trainingDays, today }: ReEntryInput): ReEntryRead {
  const lastTrainingDay = trainingDays.at(-1);
  if (lastTrainingDay === undefined) return noHistory();
  const daysSince = daysBetween(lastTrainingDay, today);
  const last = { lastTrainingDay, daysSinceLastTrainingDay: daysSince };
  if (classifyBreak(daysSince) !== 'none') return breakRead(last, 'in_gap', daysSince, today);
  const closed = lastClosedBreak(trainingDays);
  if (closed) {
    const read = breakRead(last, 'returning', closed.gapDays, closed.endsOn);
    if (read.windowEndsOn !== null && today <= read.windowEndsOn) return read;
  }
  return {
    ...last,
    phase: 'training',
    band: 'none',
    gapDays: null,
    windowEndsOn: null,
    rule: null,
    reasoning: `${daysSince} days since the last training day, inside the ${BREAK_BAND_MAX_DAYS.none.value}-day edge: nothing changes.`,
  };
}

/** A read of the break of `gapDays`, with its window opening on `firstDayBack`. */
function breakRead(
  last: { lastTrainingDay: string; daysSinceLastTrainingDay: number },
  phase: 'in_gap' | 'returning',
  gapDays: number,
  firstDayBack: string,
): ReEntryRead {
  const band = classifyBreak(gapDays);
  const windowEndsOn = windowEnd(band, firstDayBack);
  const reasoning =
    phase === 'in_gap'
      ? `${gapDays} days since the last training day, a ${band} break: ${bandSentence(band)}.`
      : `Back after a ${band} break of ${gapDays} days; through ${windowEndsOn}, ${bandSentence(band)}.`;
  return { ...last, phase, band, gapDays, windowEndsOn, rule: ruleFor(band), reasoning };
}

function noHistory(): ReEntryRead {
  return {
    lastTrainingDay: null,
    daysSinceLastTrainingDay: null,
    phase: 'no_history',
    band: 'none',
    gapDays: null,
    windowEndsOn: null,
    rule: null,
    reasoning:
      'No training day is logged yet, so there is no last load to scale; start from the starting prescription.',
  };
}

function bandSentence(band: BreakBand): string {
  switch (band) {
    case 'short':
      return 'the first week back is at 0.8 x the last working load, then the plan resumes';
    case 'medium':
      return 'the first two weeks are at one third of the last working load, 20 to 30 reps, one working set per muscle';
    case 'long':
      return 'no old load is scaled; re-enter through the starting prescription and its feeler set';
    case 'none':
      return 'nothing changes';
  }
}
