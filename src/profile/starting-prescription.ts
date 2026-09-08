// The conservative tier-seeded starting prescription (VMCP-06.04 / B39).
//
// There was no starting prescription for a new lifter or a new exercise, so the
// agent invented one every time. RP's rule is to seed at a conservative
// tier-appropriate baseline and let autoregulation converge, rather than
// lengthening intake to guess better: week-1 under-dosing is free to correct
// next week, while over-dosing leaves fatigue debt that carries forward even
// after the number is fixed (rp-s5-volume-err-low-first-week).
//
// The seeds are the corpus's, and the same ones `coaching.explain` reads out:
//
//   sessions/week   beginner 2-3, intermediate 3-4, advanced 4-6
//                   (rp-s1-sessions-per-week-default-beginner,
//                    rp-s5-days-per-week-negotiation)
//   sets/exercise   beginner 2, intermediate 2-4 attractor, advanced the
//                   REPORTED sets per muscle minus one
//                   (rp-s5-set-addition-not-progression-tool,
//                    rp-s5-volume-history-calibration-conversation)
//   RIR             beginner none — technique-led; intermediate about 3 in
//                   week 1; advanced 2-3
//                   (rp-s7-rir-self-report-accuracy-by-tier,
//                    rp-s4-beginner-rir-floor-progression)
//
// NO SEX-SEEDED VALUE anywhere, and no field for one (backlog B01 risk note,
// B53 rejected). Pure: the caller reads the tier signal and the profile and
// passes them in.

import type { EffortTolerance } from '../store/types.js';
import type { Tier, TierConfidence, TierSource } from '../tools/tier-signal.js';

/** Inclusive `[lo, hi]`. `lo === hi` is a single number, not an empty range. */
export type SeedRange = [number, number];

/**
 * `'reported_minus_one'` is the advanced sets/exercise seed when the lifter has
 * NOT reported their current sets per muscle. It is a literal instruction to go
 * ask, not a number — an advanced lifter's own history is the only honest input,
 * and inventing one here is exactly the over-dosing this seed exists to avoid.
 */
export type SetsPerExerciseSeed = SeedRange | 'reported_minus_one';

export interface PrescriptionSeeds {
  sessionsPerWeek: SeedRange;
  setsPerExercise: SetsPerExerciseSeed;
  /** `null` at the beginner tier, which should not track RIR at all. */
  rirTarget: number | null;
  rirNote: string;
}

export interface StartingPrescription {
  tier: Tier;
  confidence: TierConfidence;
  source: TierSource;
  /** True when no tier was ever declared, so these seeds are the default. */
  assumesBeginner: boolean;
  seeds: PrescriptionSeeds;
  /** One line per seed, in the order the seeds are listed. */
  reasons: string[];
}

export interface StartingPrescriptionInput {
  tier: Tier;
  confidence: TierConfidence;
  source: TierSource;
  /** The lifter's own reported sets per muscle; seeds the advanced set count. */
  reportedSetsPerMuscle?: number;
  /** Days per week they can DEFINITELY make — caps the session seed. */
  daysReliable?: number;
  effortTolerance?: EffortTolerance;
}

const SESSIONS_PER_WEEK: Record<Tier, SeedRange> = {
  beginner: [2, 3],
  intermediate: [3, 4],
  advanced: [4, 6],
};

/** Advanced is absent on purpose: its seed comes from the lifter's own report. */
const SETS_PER_EXERCISE: Record<Exclude<Tier, 'advanced'>, SeedRange> = {
  beginner: [2, 2],
  intermediate: [2, 4],
};

const RIR_TARGET: Record<Tier, number | null> = {
  beginner: null,
  intermediate: 3,
  advanced: 2,
};

const RIR_NOTE: Record<Tier, string> = {
  beginner:
    'Do not track RIR at this tier — beginner self-report runs 5-10 reps off. Progress on ' +
    'technique instead, with a floor of never closer than 1-2 RIR.',
  intermediate: 'Start around 3 RIR in week 1, trending toward 0 by the last pre-deload session.',
  advanced: '2-3 RIR generally; 1-2 RIR for a prioritized small muscle.',
};

const LOW_TOLERANCE_NOTE =
  ' They reported a low tolerance for hard effort, so stay at the conservative end of that ' +
  'RIR target and earn the aggressive end rather than opening there. Set counts are unchanged ' +
  'by effort tolerance.';

/**
 * Seed a starting prescription from the tier signal alone, with the lifter's
 * own reports narrowing it where they exist. Advisory: every field is a
 * suggestion to offer, and none of it is applied to anything by this function.
 */
export function startingPrescription(input: StartingPrescriptionInput): StartingPrescription {
  const { tier } = input;
  const sessionsPerWeek = capSessions(SESSIONS_PER_WEEK[tier], input.daysReliable);
  const setsPerExercise = seedSetsPerExercise(tier, input.reportedSetsPerMuscle);
  return {
    tier,
    confidence: input.confidence,
    source: input.source,
    assumesBeginner: input.source === 'default',
    seeds: {
      sessionsPerWeek,
      setsPerExercise,
      rirTarget: RIR_TARGET[tier],
      rirNote: rirNote(tier, input.effortTolerance),
    },
    reasons: reasonsFor(input, sessionsPerWeek, setsPerExercise),
  };
}

/**
 * `daysReliable` — days they can DEFINITELY make — not `daysAvailable`, which
 * is what they WANT. Programming against the aspirational number is how a plan
 * gets abandoned in week 3.
 */
function capSessions(seed: SeedRange, daysReliable: number | undefined): SeedRange {
  if (daysReliable === undefined) return seed;
  const hi = Math.min(seed[1], daysReliable);
  return [Math.min(seed[0], hi), hi];
}

function seedSetsPerExercise(
  tier: Tier,
  reportedSetsPerMuscle: number | undefined,
): SetsPerExerciseSeed {
  if (tier !== 'advanced') return SETS_PER_EXERCISE[tier];
  if (reportedSetsPerMuscle === undefined) return 'reported_minus_one';
  const pulled = Math.max(1, Math.round(reportedSetsPerMuscle) - 1);
  return [pulled, pulled];
}

function rirNote(tier: Tier, effortTolerance: EffortTolerance | undefined): string {
  if (effortTolerance !== 'low') return RIR_NOTE[tier];
  return RIR_NOTE[tier] + LOW_TOLERANCE_NOTE;
}

function reasonsFor(
  input: StartingPrescriptionInput,
  sessionsPerWeek: SeedRange,
  setsPerExercise: SetsPerExerciseSeed,
): string[] {
  const reasons = [
    sessionsReason(input, sessionsPerWeek),
    setsReason(input.tier, setsPerExercise),
    `RIR: ${RIR_NOTE[input.tier]}`,
  ];
  if (input.source === 'default') {
    reasons.push(
      'No tier has been declared, so these seeds assume a beginner — the safe direction to be ' +
        'wrong. Call `profile.set_training_background` to replace the assumption.',
    );
  }
  return reasons;
}

function sessionsReason(input: StartingPrescriptionInput, seed: SeedRange): string {
  const base = `Sessions/week ${rangeText(seed)}: the ${input.tier} default.`;
  if (input.daysReliable === undefined) return base;
  return (
    `${base} Capped by the ${input.daysReliable} day(s)/week they said they can DEFINITELY ` +
    'make — that is the number to program against, not the number they want.'
  );
}

function setsReason(tier: Tier, seed: SetsPerExerciseSeed): string {
  if (seed === 'reported_minus_one') {
    return (
      'Sets/exercise: ask what they are currently running per muscle and seed ONE SET BELOW ' +
      'it. An advanced lifter often adds zero or one set across a whole mesocycle, so their ' +
      'own history is the only honest starting number.'
    );
  }
  if (tier === 'beginner') {
    return (
      `Sets/exercise ${rangeText(seed)}: err low in week 1. Under-dosing is free to correct ` +
      'next week; over-dosing leaves fatigue debt that carries forward.'
    );
  }
  if (tier === 'intermediate') {
    return `Sets/exercise ${rangeText(seed)}: the intermediate attractor, added to one at a time on recovery evidence.`;
  }
  return `Sets/exercise ${rangeText(seed)}: one set below what they reported running per muscle.`;
}

function rangeText(seed: SeedRange): string {
  return seed[0] === seed[1] ? `${seed[0]}` : `${seed[0]}-${seed[1]}`;
}
