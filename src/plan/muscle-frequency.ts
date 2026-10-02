// Per-muscle weekly frequency against a recovery-tier band (VW-623, B28). ADVISORY ONLY: every
// band is a planning prior, a warning never blocks a write, and the split may look irregular.
//
// Frequency is the landmark read: a day counts 1 toward a muscle only when an exercise that
// day targets it (dayFrequencyCredit credit 1, VW-561 R14). No per-person recovery window is
// computed here; muscle-recovery.ts forbids one.
//
// Sources: rp-s2-sra-frequency-codex, rp-s6-muscle-recovery-tier-frequency.

import { dayFrequencyCredit, type SlugAttribution } from '../exercises/muscle-attribution.js';
import type { TitanMuscleGroup } from '../exercises/muscle-map.js';
import type { Tier, TierConfidence } from '../tools/tier-signal.js';
import {
  isRestTemplate,
  trainingDayKey,
  type LintOffDayTemplate,
  type PlanWarning,
} from './lint-plan.js';

export interface FrequencyBand {
  low: number;
  high: number;
}

const SOURCE_RP_IDS = 'rp-s2-sra-frequency-codex, rp-s6-muscle-recovery-tier-frequency';

/** A beginner trains whole-body, 2-4 days a week for every muscle (rp-s2-sra-frequency-codex). */
const BEGINNER_BAND: FrequencyBand = { low: 2, high: 4 };

// The source notes state these bands for the advanced tier (rp-s6-muscle-recovery-tier-frequency).
// ENGINEERING DEFAULT: an intermediate gets the same bands, a reading the notes do not state.
// Front and rear delts, abs and obliques have no stated band, so they are never linted.
const NON_BEGINNER_BANDS: Partial<Record<TitanMuscleGroup, FrequencyBand>> = {
  quads: { low: 2, high: 2 },
  hamstrings: { low: 2, high: 2 },
  glutes: { low: 2, high: 2 },
  lats: { low: 2, high: 3 },
  upper_back: { low: 2, high: 3 },
  chest: { low: 2, high: 3 },
  triceps: { low: 2, high: 3 },
  biceps: { low: 3, high: 5 },
  forearms: { low: 3, high: 5 },
  side_delts: { low: 3, high: 5 },
  calves: { low: 3, high: 5 },
};

/** The band a muscle is judged against at a clamped tier, or `null` when no source states one. */
export function frequencyBand(muscle: TitanMuscleGroup, tier: Tier): FrequencyBand | null {
  if (tier === 'beginner') return BEGINNER_BAND;
  return NON_BEGINNER_BANDS[muscle] ?? null;
}

/** Days per muscle at landmark credit: each day's exercises go through dayFrequencyCredit. */
export function weeklyFrequency(
  days: Iterable<readonly (readonly SlugAttribution[])[]>,
): Map<TitanMuscleGroup, number> {
  const frequency = new Map<TitanMuscleGroup, number>();
  for (const exercises of days) {
    for (const [muscle, credit] of dayFrequencyCredit(exercises)) {
      if (credit === 1) frequency.set(muscle, (frequency.get(muscle) ?? 0) + 1);
    }
  }
  return frequency;
}

/** One week's template: its day, and the target slugs of each exercise it plans. */
export interface FrequencyTemplate extends LintOffDayTemplate {
  exercises: readonly { muscleGroups: readonly string[] }[];
}

/** Training days in one week: templates on one weekday are one day, and a rest template is none. */
export function trainingDaysOf(templates: readonly LintOffDayTemplate[]): number {
  const days = templates.flatMap((t, i) => (isRestTemplate(t) ? [] : [trainingDayKey(t, i)]));
  return new Set(days).size;
}

/** Planned days per muscle, with training days counted as {@link trainingDaysOf} counts them. */
export function plannedWeeklyFrequency(
  templates: readonly FrequencyTemplate[],
): Map<TitanMuscleGroup, number> {
  const days = new Map<string, SlugAttribution[][]>();
  templates.forEach((template, i) => {
    if (isRestTemplate(template)) return;
    const key = trainingDayKey(template, i);
    const rows = template.exercises.map((e) => e.muscleGroups.map(targetRow));
    days.set(key, [...(days.get(key) ?? []), ...rows]);
  });
  return weeklyFrequency(days.values());
}

function targetRow(muscle: string): SlugAttribution {
  return { muscle: muscle as TitanMuscleGroup, weight: 1, target: true };
}

export interface LintMuscleFrequencyInput {
  templates: readonly FrequencyTemplate[];
  tier: Tier;
  confidence: TierConfidence;
}

const PROVISIONAL_SUFFIX =
  ' (tier is provisional; set `profile.set_training_background` to confirm)';

/**
 * A warning per muscle the week trains on more days than its band, or on fewer when the week
 * already has enough filled days (days with an exercise) to reach the band: a week with fewer is
 * still being built, or its day count is the thing to raise, not this muscle.
 */
export function lintMuscleFrequency(input: LintMuscleFrequencyInput): PlanWarning[] {
  const filledDays = trainingDaysOf(input.templates.filter((t) => t.exercises.length > 0));
  const warnings: PlanWarning[] = [];
  for (const [muscle, days] of plannedWeeklyFrequency(input.templates)) {
    const band = frequencyBand(muscle, input.tier);
    if (band !== null && isOutsideBand(days, band, filledDays)) {
      warnings.push(frequencyWarning(muscle, days, band, input.tier));
    }
  }
  if (input.confidence !== 'provisional') return warnings;
  return warnings.map((w) => ({ ...w, message: w.message + PROVISIONAL_SUFFIX }));
}

export interface LintMuscleFrequencyChangeInput extends LintMuscleFrequencyInput {
  /** The same week before the write being linted. */
  before: readonly FrequencyTemplate[];
}

/**
 * The frequency warnings a write caused: those on the week after it whose muscle, direction and
 * day count were not already warned before it, so an unchanged muscle is not warned again.
 */
export function lintMuscleFrequencyChange(input: LintMuscleFrequencyChangeInput): PlanWarning[] {
  const before = new Set(
    lintMuscleFrequency({ ...input, templates: input.before }).map(warningKey),
  );
  return lintMuscleFrequency(input).filter((w) => !before.has(warningKey(w)));
}

function warningKey(warning: PlanWarning): string {
  return `${warning.code} ${warning.muscleGroup} ${warning.observed}`;
}

function isOutsideBand(days: number, band: FrequencyBand, filledDays: number): boolean {
  return days > band.high || (days < band.low && filledDays >= band.low);
}

function frequencyWarning(
  muscle: TitanMuscleGroup,
  days: number,
  band: FrequencyBand,
  tier: Tier,
): PlanWarning {
  const below = days < band.low;
  return {
    code: below ? 'muscle_frequency_below_band' : 'muscle_frequency_above_band',
    message: frequencyMessage(muscle, days, band, tier),
    muscleGroup: muscle,
    observed: days,
    ...(below ? { floor: band.low } : { ceiling: band.high }),
    tier,
  };
}

function frequencyMessage(
  muscle: TitanMuscleGroup,
  days: number,
  band: FrequencyBand,
  tier: Tier,
): string {
  const dayWord = days === 1 ? 'day' : 'days';
  const range = band.low === band.high ? `about ${band.low}` : `${band.low}-${band.high}`;
  const basis =
    tier === 'beginner'
      ? 'a beginner trains every muscle whole-body'
      : tier === 'intermediate'
        ? 'the source states this band for advanced lifters, applied to an intermediate as a default'
        : "it is the advanced tier's band for this muscle";
  return (
    `This week trains ${muscle.replaceAll('_', ' ')} on ${days} ${dayWord}, outside the band of ` +
    `${range} days a week (${basis}; ${SOURCE_RP_IDS}). The band is a planning prior, not a ` +
    'rule: an irregular split is fine when recovery and performance hold, and a week still ' +
    'being built may not have its last days yet.'
  );
}
