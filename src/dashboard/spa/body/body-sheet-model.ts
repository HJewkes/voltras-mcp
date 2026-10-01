/**
 * The `#/body` muscle sheet's props (VW-712, VW-339 slice S2).
 *
 * `muscleSheetProps` maps the four payloads `BodyPage` already polls onto
 * titan's `BodyMapDetailPanel`, docked as the wall side-sheet. Pure, like
 * `body-model.ts`: no fetch, no clock, no React. Opening the sheet is S3.
 *
 * Two owner questions are answered with the plan's default, each behind one
 * function so a different answer is a local change: `recoveryLine` (recovery is
 * composed into the panel's "Last trained" line, as titan has no recovery
 * section) and `planSection` (remaining rows only, since B4 emits no done list).
 */
import type {
  BodyMapDetailPanelProps,
  MusclePlanSection,
  MuscleStrengthSection,
} from '@titan-design/react-ui/bodymap';

import type {
  MusclePlanMuscleView,
  MuscleRecoveryMuscleView,
  MuscleStrengthMuscle,
} from '../../read-models/index.js';
import { muscleGroupOf, muscleLabel, statusOf, type BodyPageData } from './body-model.js';

/** Every panel prop the page data decides; S3 adds `isOpen` and `onClose`. */
export type MuscleSheetProps = Pick<
  BodyMapDetailPanelProps,
  | 'muscleGroup'
  | 'displayName'
  | 'weeklySets'
  | 'landmarks'
  | 'volumeStatus'
  | 'lastTrained'
  | 'strength'
  | 'plan'
  | 'placement'
>;

/**
 * Below this, an entry-depression read is too weak to state. Engineering
 * default: nothing on the wall gates this axis on confidence yet to reuse.
 */
export const ENTRY_DEPRESSION_MIN_CONFIDENCE = 0.5;

function daysAgoText(days: number): string {
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function entryDepressionText(row: MuscleRecoveryMuscleView): string | null {
  const read = row.lastEntryDepression;
  if (read === null || read.confidence < ENTRY_DEPRESSION_MIN_CONFIDENCE) return null;
  const pct = Math.round(Math.abs(read.pct));
  return `entry ${pct}% ${read.pct < 0 ? 'above' : 'below'} prior`;
}

/** The benchmark clause, or the read model's own reason verbatim; the reasons never merge. */
function benchmarkText(row: MuscleRecoveryMuscleView): string | null {
  if (row.lastSessionMatchedPrior === null) return row.reason;
  return row.lastSessionMatchedPrior ? 'matched last session' : 'below last session';
}

/**
 * The value after the panel's "Last trained" label, or undefined for a muscle
 * never trained. States what happened, never a recovery verdict or countdown.
 */
export function recoveryLine(row: MuscleRecoveryMuscleView | undefined): string | undefined {
  if (row === undefined || row.lastTrainedAt === null || row.daysSince === null) return undefined;
  const clauses = [daysAgoText(row.daysSince), entryDepressionText(row), benchmarkText(row)];
  return clauses.filter((clause): clause is string => clause !== null).join(' · ');
}

/** The plan section: remaining rows only, because B4 lists no trained ones. */
export function planSection(row: MusclePlanMuscleView): MusclePlanSection {
  return {
    plannedSetsThisWeek: row.plannedSetsThisWeek,
    doneSetsThisWeek: row.doneSetsThisWeek,
    exercises: row.plannedRemaining.map((exercise) => ({ ...exercise, done: false })),
  };
}

/** Per-side rows pass through untouched: a bilateral muscle keeps one row per limb. */
function strengthSection(row: MuscleStrengthMuscle): MuscleStrengthSection {
  return { exercises: row.exercises, agreement: row.agreement, earlyPhase: row.earlyPhase };
}

function rowFor<T extends { muscle: string }>(
  rows: readonly T[] | undefined,
  slug: string,
): T | undefined {
  return rows?.find((row) => row.muscle === slug);
}

/** The sheet for one muscle, or null for a slug titan does not draw or the week does not carry. */
export function muscleSheetProps(slug: string, data: BodyPageData): MuscleSheetProps | null {
  const muscleGroup = muscleGroupOf(slug);
  const week = rowFor(data.week.muscles, slug);
  if (muscleGroup === null || week === undefined) return null;
  const strength = rowFor(data.strength.muscles, slug);
  const plan = rowFor(data.plan?.muscles, slug);
  const lastTrained = recoveryLine(rowFor(data.recovery?.muscles, slug));
  return {
    muscleGroup,
    displayName: muscleLabel(slug),
    weeklySets: week.sets,
    landmarks: week.landmarks,
    volumeStatus: statusOf(week),
    placement: 'right',
    ...(lastTrained === undefined ? {} : { lastTrained }),
    ...(strength === undefined ? {} : { strength: strengthSection(strength) }),
    ...(plan === undefined ? {} : { plan: planSection(plan) }),
  };
}
