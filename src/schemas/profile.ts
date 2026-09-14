// Input schemas for the `profile.*` training-background tools (VW-96 Wave 3).
//
// Storage only: every field here is a self-reported raw value captured
// verbatim into `training_profile`. There is no derivation or tier
// classification here — that is a separate, already-scoped effort (VW-92)
// that reads this table.
//
// `ProfileSetTrainingBackgroundInput` is `.strict()` with every field
// optional so a caller can set one answer at a time across several onboarding
// turns; the handler merges each call onto the existing row rather than
// overwriting it wholesale (see `profile-tools.ts`).

import { z } from 'zod';

import { BODY_FAT_SOURCES } from '../analytics/body-fat-sources.js';
import { DIET_PHASES, RECOMP_MODES } from '../store/diet-phase.js';
import { LEANNESS_BANDS } from '../store/leanness-band.js';
import { CheckinScaleValue } from './session.js';

/**
 * One self-reported injury or limitation (VW-148 / B42).
 *
 * `kind` deliberately does NOT encode the RP injury ladder's diagnosed vs.
 * undiagnosed split as a clinical judgement — it records what the lifter said
 * happened. `cardioLimitation` is the one hard gate: it is a flag the lifter
 * raises, and nothing in this codebase interprets it beyond deferring to a
 * doctor (see `onboarding.injury_intake` in `coaching-content.ts`).
 */
export const ProfileInjury = z
  .object({
    area: z.string().min(1),
    kind: z.enum(['sharp_in_set', 'lingering_joint', 'other']),
    note: z.string().min(1).optional(),
    cardioLimitation: z.boolean().optional(),
  })
  .strict();

export const ProfileSetTrainingBackgroundInput = z
  .object({
    declaredTier: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    yearsTraining: z.number().min(0).optional(),
    historyConsistent: z.boolean().optional(),
    everPlateaued: z.boolean().optional(),
    reportedSetsPerMuscle: z.number().min(0).optional(),
    goal: z.string().min(1).optional(),
    daysAvailable: z.number().int().min(0).max(7).optional(),
    daysReliable: z.number().int().min(0).max(7).optional(),
    // VMCP-06.04 / B39. RP keeps these three DISTINCT from each other and from
    // `goal`; collapsing them is what makes intake read a target as a baseline.
    currentBaseline: z.string().min(1).optional(),
    effortTolerance: z.enum(['low', 'moderate', 'high']).optional(),
    target: z.string().min(1).optional(),
    // VW-148 / B42. Replaces the whole list on every call, unlike the scalar
    // fields above: a merge would make removing a resolved injury impossible.
    injuries: z.array(ProfileInjury).optional(),
    // VW-148 / B36. The named program `reportedSetsPerMuscle` came from —
    // 5/3/1 and German Volume Training imply very different starting volumes
    // for the same reported set count.
    namedProgramHistory: z.string().min(1).optional(),
  })
  .strict();

export const ProfileGetTrainingBackgroundInput = z.object({}).strict();

// `profile.get_onboarding_gaps` (VW-148). Same single-user posture as the
// other profile reads: nothing for a caller to disambiguate.
export const ProfileGetOnboardingGapsInput = z.object({}).strict();

// `profile.get_tier_signal` (VW-92 MVP). No input today; this repo is
// effectively single-user in practice (see `tier-signal.ts`), so there is
// nothing for a caller to disambiguate yet.
export const ProfileGetTierSignalInput = z.object({}).strict();

// `profile.get_starting_prescription` (VMCP-06.04). Same single-user posture as
// the tier signal it reads: nothing to disambiguate, so nothing to pass.
export const ProfileGetStartingPrescriptionInput = z.object({}).strict();

// `profile.set_diet_phase` (VW-149 / VW-150) — the ACTUAL phase the lifter is
// eating in, which had DDL (`diet_phases`) and a comparability clause but no
// writer. Self-report like the rest of `profile.*`: it captures a declaration
// and derives nothing from it.
//
// The enum is exactly the three values `ComparabilitySubject.phase`'s docstring
// has named since B34. It is transcribed, not extended — a fourth value would
// be a new claim about training, and this ticket adds no claims.
export const ProfileSetDietPhaseInput = z
  .object({
    phase: z.enum(DIET_PHASES),
    // Omitted means "as of now". A past instant is the retroactive correction
    // the `diet_phases` DDL comment calls for, and rewrites the timeline from
    // there forward.
    startedAt: z.string().datetime().optional(),
    // VW-378: the bodyweight target a recomposition runs against. Declared,
    // never inferred — see `RECOMP_MODES`.
    recompMode: z.enum(RECOMP_MODES).optional(),
  })
  .strict();

/**
 * `recompMode` is REQUIRED for a recomposition and REFUSED for every other
 * phase (VW-378). Required, because the mode decides what the goal page calls
 * "on track" from week 1 and a default would be the server answering a
 * question only the lifter can (VW-346 §5 Q2). Refused elsewhere, because a
 * stored mode on a fat-loss range would be a declaration no reader consults.
 *
 * Registered the way `ProfileLogBodyweightInputRefined` is: the object schema
 * describes the parameters, the refined schema parses them.
 */
export const ProfileSetDietPhaseInputRefined = ProfileSetDietPhaseInput.refine(
  (input) => (input.phase === 'recomposition') === (input.recompMode !== undefined),
  {
    message:
      'recompMode is required when phase is recomposition, and must be omitted for every other phase',
    path: ['recompMode'],
  },
);

// `profile.log_bodyweight` (VW-327) — the first writer of `body_metrics`.
// Storage only, in the same posture as the rest of `profile.*`: it records a
// self-reported reading and computes no verdict on it.
//
// VW-364 ADDS THE LEANNESS LEGS HERE RATHER THAN AS A SIBLING TOOL. They are
// columns on the SAME row, keyed by the same `measuredAt`, and the table's
// unique index makes that instant the row identity — two tools writing one row
// would have to agree on an upsert key and would still race each other on it.
// A weigh-in is when a tape or a scan reading gets recorded anyway, so
// `bodyweightLbs` stays required and the rest ride along on it.
export const ProfileLogBodyweightInput = z
  .object({
    bodyweightLbs: z.number().positive(),
    // Omitted means "as of now". A second call for the same instant corrects
    // the earlier reading rather than duplicating it (see `putBodyMetric`) —
    // and the correction is TOTAL, so it must restate every field.
    measuredAt: z.string().datetime().optional(),
    note: z.string().min(1).optional(),
    // Self-reported against RP's visual descriptors, never inferred from any
    // other field here and never converted to a percentage.
    leannessBand: z.enum(LEANNESS_BANDS).optional(),
    // A RAW trend leg. Nothing in this server converts a circumference to a
    // body-fat percentage: every published conversion is off its fitted
    // population at this athlete's height (VW-346 §2b, VW-370 §5).
    waistIn: z.number().positive().optional(),
    // Display-only, always (VW-370 §9). `bodyFatSource` is required alongside
    // it because an unattributed percentage cannot be graded, and a delta
    // against a reading from a different source is never renderable.
    bodyFatPct: z.number().min(1).max(75).optional(),
    bodyFatSource: z.enum(BODY_FAT_SOURCES).optional(),
    // Free text, deliberately: at extreme height every scan runs a two-scan or
    // stitched protocol and the literature agrees on no taxonomy for them.
    measurementProtocol: z.string().min(1).optional(),
  })
  .strict();

/**
 * An unattributed body-fat percentage cannot be graded, banded or compared —
 * every figure in `BODY_FAT_SOURCE_TIERS` is keyed on the source, and a
 * reading with no source would render as a bare number with no caveat, which
 * is the one thing VW-370 §9 rules out. Registered the way
 * `IsometricMeasureImbalanceInputRefined` is: the object schema describes the
 * parameters, the refined schema parses them.
 */
export const ProfileLogBodyweightInputRefined = ProfileLogBodyweightInput.refine(
  (input) => input.bodyFatPct === undefined || input.bodyFatSource !== undefined,
  { message: 'bodyFatSource is required whenever bodyFatPct is given', path: ['bodyFatSource'] },
);

// `profile.get_body_metrics` (VW-327). Read-only; `sinceDays` limits the
// returned series and defaults to the whole history when omitted.
export const ProfileGetBodyMetricsInput = z
  .object({
    sinceDays: z.number().int().positive().optional(),
  })
  .strict();

// `profile.log_weekly_checkin` / `profile.get_weekly_checkin` (VW-374) — a
// second `self_reports` writer, alongside `session.checkin`. `kind` and the
// three question codes are its own, never `'checkin'`, so the two never mix
// on read.
//
// Reuses `CheckinScaleValue` (low/medium/high) rather than declaring a
// second 3-point enum: it is already the corpus's coarse rating scale
// (rp-s7-coarse-rating-scale-rationale, quoted on `CheckinScaleValue` itself),
// and a second enum with the same three values would just be the same
// convention spelled twice.
export const WEEKLY_CHECKIN_KIND = 'weekly_checkin';
export const WEEKLY_CHECKIN_CODES = ['hunger', 'diet_plan_adherence', 'sleep_quality'] as const;

/**
 * All three fields are optional and independently nullable — a lifter who
 * opens the Sunday sitting and answers nothing still gets a stored row (see
 * `logWeeklyCheckin`), which is what lets the downstream rate advisory (VW-367
 * §2d, W2) tell "asked, no answer" apart from "never asked". `weekOf` is a
 * date only (no time-of-day): omitted, it defaults to the most recent Sunday
 * relative to now; given, it anchors a late or corrected entry to the sitting
 * it actually answers.
 */
export const ProfileLogWeeklyCheckinInput = z
  .object({
    hunger: CheckinScaleValue.optional(),
    dietPlanAdherence: CheckinScaleValue.optional(),
    sleepQuality: CheckinScaleValue.optional(),
    weekOf: z.string().date().optional(),
  })
  .strict();

// `profile.get_weekly_checkin` (VW-374). Read-only; `weekOf` selects which
// Sunday's entry to read back and defaults the same way the write side does.
export const ProfileGetWeeklyCheckinInput = z
  .object({
    weekOf: z.string().date().optional(),
  })
  .strict();
