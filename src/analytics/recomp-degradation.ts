// VW-369 (research VW-346 R6): the recomposition re-ask — does the lifter's
// own phase LABEL still describe what is happening to them?
//
// PURE. No store, no clock, no tool surface: every input is assembled by the
// caller (`src/tools/recomp-degradation.ts`) and the same input always yields
// the same result. This module decides WHETHER to offer a re-ask and what it
// says; it never writes, and in particular it never writes `diet_phases`.
//
// THE PHASE IS AN OBSERVED RECORD, SO THE ANSWER IS ALWAYS THE LIFTER'S. The
// proposal offers a switch to a declared direction (fat-loss or gain) or
// keeping the recomposition on its declared mode, with accept / decline. The
// server never picks one (VW-346 §2d).
//
// SILENCE IS NOT AN ANSWER. The block-boundary leg opens once, at
// `boundaryReAskIndex`, and then comes back at every later boundary until the
// lifter accepts or declines it. Asking once and going quiet is the shape that
// produces VW-346 §3's "recomp forever": the one question that exists to end an
// open-ended phase would be closed by ignoring it.
//
// THE BANDS ARE NOT RESTATED HERE. `cumulative-loss.ts` owns the 7% / 10%
// diet-fatigue proxy; this module imports `classifyCumulativeLossPct`'s verdict
// and reads the thresholds off `CUMULATIVE_LOSS_CONSTANTS`. Two copies of those
// numbers would drift (VW-367 §4).
//
// EVERY MAGNITUDE NAMES ITS SOURCE, in `diet-phase-tolerance.ts`'s convention:
// `rp:<id>` for a mined RP University note, ENGINEERING DEFAULT for a number
// the corpus does not state, HUMAN DECISION for a call made on a date.

import {
  CUMULATIVE_LOSS_CONSTANTS,
  CUMULATIVE_LOSS_SOURCE_ID,
  type CumulativeLossFacts,
} from './cumulative-loss.js';
import type { DietPhase, RecompMode } from '../store/diet-phase.js';
import { LEANNESS_BANDS, type LeannessBand } from '../store/leanness-band.js';

/** The `advisory_decisions.code` every proposal and decline here is filed under. */
export const RECOMP_DEGRADATION_CODE = 'recomp_lean_degradation';

/** Bumped when a threshold or the suppression rule below changes. */
export const RECOMP_DEGRADATION_VERSION = 'vw369.1';

export const RECOMP_DEGRADATION_CONSTANTS = {
  /**
   * Which block boundary since the phase started carries the re-ask.
   *
   * HUMAN DECISION 2026-09-13 (VW-346 §5 Q3). Not the first, because a single
   * mesocycle is inside the cited 4-8 week maintenance bridge and nothing has
   * had time to happen (rp:rp-s11-fat-loss-recovery-phase). Not every block,
   * because a re-ask the lifter answers every eight weeks stops being a
   * question. The corpus states no recomposition duration at all, so this
   * number is the human's; its two bracketing facts are that bridge and the
   * ~12-month horizon a large recomposition is given.
   */
  boundaryReAskIndex: 2,
  /** Percent lost at which the re-ask first opens. rp:rp-s11-diet-fatigue-pct-weight-lost-proxy */
  noticeableBandFloorPct: CUMULATIVE_LOSS_CONSTANTS.noticeableBandFloorPct,
  /** Percent lost RP calls significant diet fatigue. rp:rp-s11-diet-fatigue-pct-weight-lost-proxy */
  significantBandFloorPct: CUMULATIVE_LOSS_CONSTANTS.significantBandFloorPct,
  /**
   * How many rungs the declared leanness band must move toward lean before
   * the self-reported trigger fires.
   *
   * ENGINEERING DEFAULT. The corpus grades leanness visually and states no
   * step size, so one rung is the smallest move the four-band vocabulary can
   * express (VW-346 §2b).
   */
  leannessRungDrop: 1,
} as const;

/** Which observation opened the re-ask. */
export type RecompTriggerKind = 'block-boundary' | 'cumulative-loss' | 'leanness-rung';

/**
 * How strong the strongest trigger is, weakest first. A decline is filed
 * against a level, and only a HIGHER level re-opens it inside the same
 * boundary.
 *
 * ENGINEERING DEFAULT for the order of the first two against the last two:
 * the corpus quantifies only the observed pair, so the boundary re-ask and the
 * self-reported rung sit below both measured bands rather than interleaved
 * with them. The observed pair keeps `DIET_FATIGUE_BAND_ORDER`'s own order.
 */
export const RECOMP_ADVISORY_LEVELS = [
  'boundary',
  'leanness-rung',
  'noticeable',
  'significant',
] as const;

export type RecompAdvisoryLevel = (typeof RECOMP_ADVISORY_LEVELS)[number];

/** Where a level sits in {@link RECOMP_ADVISORY_LEVELS}. */
export function recompAdvisoryLevelRank(level: RecompAdvisoryLevel): number {
  return RECOMP_ADVISORY_LEVELS.indexOf(level);
}

export interface RecompDegradationTrigger {
  kind: RecompTriggerKind;
  level: RecompAdvisoryLevel;
  /** What fired, in the lifter's terms. Carries no device detail and no number the corpus lacks. */
  detail: string;
  rpIds: readonly string[];
}

/** One answer the lifter may give. Nothing here is applied by accepting it. */
export interface RecompProposalOption {
  action: 'switch-phase' | 'keep-recomposition';
  /** The phase to declare, or the recomposition mode to keep running. */
  target: DietPhase | RecompMode;
  detail: string;
}

/** One answered proposal, read back out of `advisory_decisions`. */
export interface RecompResponseRecord {
  level: RecompAdvisoryLevel;
  /** Boundaries since phase start at the instant the answer was filed. */
  boundaryCount: number;
  response: 'accepted' | 'declined';
  /**
   * Which triggers the answered proposal carried. A row written before this
   * field existed reads back empty, which closes no ask.
   */
  triggerKinds: readonly RecompTriggerKind[];
}

export interface RecompDegradationProposal {
  code: typeof RECOMP_DEGRADATION_CODE;
  algorithmVersion: string;
  level: RecompAdvisoryLevel;
  triggers: RecompDegradationTrigger[];
  options: RecompProposalOption[];
  message: string;
  /** Persisted verbatim as `advisory_decisions.inputs`. */
  inputs: Record<string, unknown>;
  /** Persisted verbatim as `advisory_decisions.thresholds`. */
  thresholds: Record<string, unknown>;
}

export interface RecompDegradationResult {
  /** `null` when nothing qualified, or when a decline still suppresses it. */
  proposal: RecompDegradationProposal | null;
  /** Why nothing was offered. `null` when a proposal was. */
  silentReason: string | null;
}

export interface RecompDegradationInput {
  /** The declared phase covering now. Anything but `'recomposition'` is silent. */
  phase: DietPhase | 'unknown';
  /** The declared bodyweight target, absent on a pre-VW-378 range. */
  recompMode?: RecompMode;
  /** Block boundaries crossed since the phase started, this one included. */
  boundariesSincePhaseStart: number;
  /** From `computeCumulativeLossFacts`; `null` when no series was logged. */
  cumulativeLoss: CumulativeLossFacts | null;
  /** The band declared nearest the phase start, absent when never declared. */
  phaseStartLeannessBand?: LeannessBand;
  /** The most recently declared band, absent when never declared. */
  currentLeannessBand?: LeannessBand;
  /** Every accepted or declined proposal on file for this phase. */
  responses: readonly RecompResponseRecord[];
}

const C = RECOMP_DEGRADATION_CONSTANTS;

const BOUNDARY_RP_IDS = [
  'rp:rp-s12-recomposition-requires-maintenance-calories',
  'rp:rp-s11-fat-loss-recovery-phase',
] as const;

const OBSERVED_RP_IDS = [`rp:${CUMULATIVE_LOSS_SOURCE_ID}`] as const;

/** One id, because the detail text quotes this note and no other. */
const LEANNESS_RP_IDS = ['rp:rp-s12-goal-magnitude-shrinks-each-phase'] as const;

function silent(reason: string): RecompDegradationResult {
  return { proposal: null, silentReason: reason };
}

/** Has the lifter ever answered a proposal carrying the boundary question? */
function boundaryAskAnswered(input: RecompDegradationInput): boolean {
  return input.responses.some((record) => record.triggerKinds.includes('block-boundary'));
}

/**
 * Opens at the nominated boundary and stays open until answered.
 *
 * NOT ONCE, AND NOT EVERY BLOCK EITHER. The first ask is at
 * `boundaryReAskIndex` and never before it, which is the human decision. After
 * that an UNANSWERED ask comes back at every later boundary: a question the
 * lifter scrolled past is exactly how VW-346 §3's "recomp forever" happens, and
 * silence is not an answer. Once they accept or decline, this leg goes quiet —
 * a decline then falls to `suppressingDecline`'s level rule, which is what lets
 * a stronger band re-open the conversation on its own evidence.
 */
function boundaryTrigger(input: RecompDegradationInput): RecompDegradationTrigger[] {
  if (input.boundariesSincePhaseStart < C.boundaryReAskIndex) return [];
  if (boundaryAskAnswered(input)) return [];
  return [
    {
      kind: 'block-boundary',
      level: 'boundary',
      detail:
        `This recomposition has now run through ${input.boundariesSincePhaseStart} block ` +
        'boundaries. RP holds that a recomposition runs on maintenance calories and that a ' +
        'non-beginner gets better absolute results from fat-loss and muscle-gain run as separate ' +
        'phases (rp:rp-s12-recomposition-requires-maintenance-calories).',
      rpIds: BOUNDARY_RP_IDS,
    },
  ];
}

/** The measured leg, and the primary one: the self-report drifts, the scale does not. */
function cumulativeLossTrigger(input: RecompDegradationInput): RecompDegradationTrigger[] {
  const facts = input.cumulativeLoss;
  if (facts === null || facts.band === null || facts.pctLostSincePhaseStart === null) return [];
  if (facts.band !== 'noticeable' && facts.band !== 'significant') return [];
  const lost = facts.pctLostSincePhaseStart.toFixed(1);
  const detail =
    facts.band === 'significant'
      ? `You are down ${lost}% of your starting weight since this phase began, past the ${C.significantBandFloorPct}% ` +
        'RP calls significant diet fatigue for a continuous phase. That is a fat-loss phase by any ' +
        'measure, whatever it is labelled.'
      : `You are down ${lost}% of your starting weight since this phase began, into the ` +
        `${C.noticeableBandFloorPct}% band RP calls noticeable diet fatigue. Is this a fat-loss phase now?`;
  return [{ kind: 'cumulative-loss', level: facts.band, detail, rpIds: OBSERVED_RP_IDS }];
}

/** The self-reported leg, and the secondary one (VW-346 §3: the band drifts with progress). */
function leannessTrigger(input: RecompDegradationInput): RecompDegradationTrigger[] {
  const { phaseStartLeannessBand: start, currentLeannessBand: current } = input;
  if (start === undefined || current === undefined) return [];
  const rungs = LEANNESS_BANDS.indexOf(current) - LEANNESS_BANDS.indexOf(start);
  if (rungs < C.leannessRungDrop) return [];
  return [
    {
      kind: 'leanness-rung',
      level: 'leanness-rung',
      detail:
        `You reported yourself at "${start}" when this phase started and "${current}" now. The same ` +
        'percentage of bodyweight costs more as you get leaner, because it is a larger fraction of ' +
        'what fat is left (rp:rp-s12-goal-magnitude-shrinks-each-phase).',
      rpIds: LEANNESS_RP_IDS,
    },
  ];
}

function strongestLevel(triggers: readonly RecompDegradationTrigger[]): RecompAdvisoryLevel {
  return triggers.reduce(
    (best, trigger) =>
      recompAdvisoryLevelRank(trigger.level) > recompAdvisoryLevelRank(best) ? trigger.level : best,
    triggers[0].level,
  );
}

/**
 * A decline holds until the phase crosses a LATER boundary or the strongest
 * trigger outranks the one that was declined (VW-346 §2d, audit:308 — a
 * declined proposal is never re-proposed on the same evidence).
 */
function suppressingDecline(
  input: RecompDegradationInput,
  level: RecompAdvisoryLevel,
): RecompResponseRecord | null {
  const blocking = input.responses.find(
    (record) =>
      record.response === 'declined' &&
      input.boundariesSincePhaseStart <= record.boundaryCount &&
      recompAdvisoryLevelRank(level) <= recompAdvisoryLevelRank(record.level),
  );
  return blocking ?? null;
}

function proposalOptions(recompMode: RecompMode | undefined): RecompProposalOption[] {
  const options: RecompProposalOption[] = [
    {
      action: 'switch-phase',
      target: 'fat-loss',
      detail:
        'Declare a fat-loss phase and take the fat-loss rules with it: specialization off, every ' +
        'muscle held at least at maintenance volume.',
    },
    {
      action: 'switch-phase',
      target: 'gain',
      detail: 'Declare a gain phase and run the muscle-gain half as its own block instead.',
    },
  ];
  if (recompMode === undefined) return options;
  options.push({
    action: 'keep-recomposition',
    target: recompMode,
    detail: `Keep the recomposition running on its declared "${recompMode}" bodyweight target.`,
  });
  return options;
}

function proposalMessage(triggers: readonly RecompDegradationTrigger[]): string {
  return (
    `${triggers.map((trigger) => trigger.detail).join(' ')} Nothing is changed by this question: ` +
    'declare the phase yourself if you want it switched, or keep the recomposition and be asked ' +
    'again at a later boundary.'
  );
}

function buildProposal(
  input: RecompDegradationInput,
  triggers: RecompDegradationTrigger[],
  level: RecompAdvisoryLevel,
): RecompDegradationProposal {
  return {
    code: RECOMP_DEGRADATION_CODE,
    algorithmVersion: RECOMP_DEGRADATION_VERSION,
    level,
    triggers,
    options: proposalOptions(input.recompMode),
    message: proposalMessage(triggers),
    inputs: {
      boundariesSincePhaseStart: input.boundariesSincePhaseStart,
      pctLostSincePhaseStart: input.cumulativeLoss?.pctLostSincePhaseStart ?? null,
      cumulativeLossBand: input.cumulativeLoss?.band ?? null,
      weeksInPhase: input.cumulativeLoss?.weeksInPhase ?? null,
      phaseStartLeannessBand: input.phaseStartLeannessBand ?? null,
      currentLeannessBand: input.currentLeannessBand ?? null,
      recompMode: input.recompMode ?? null,
      triggerKinds: triggers.map((trigger) => trigger.kind),
    },
    thresholds: { ...C },
  };
}

/** Which of the three legs failed, so silence is never ambiguous. */
function noTriggerReason(input: RecompDegradationInput): string {
  const boundaryLeg = boundaryAskAnswered(input)
    ? 'the block-boundary ask has already been answered'
    : `boundary ${input.boundariesSincePhaseStart} of ${C.boundaryReAskIndex}`;
  return (
    `no trigger crossed: ${boundaryLeg}, cumulative loss below ` +
    `${C.noticeableBandFloorPct}%, and the declared leanness band has not moved a rung`
  );
}

/**
 * Should the coach re-ask whether this recomposition is still the right label?
 * Silence is a legitimate answer and says why it was chosen.
 */
export function evaluateRecompDegradation(input: RecompDegradationInput): RecompDegradationResult {
  if (input.phase !== 'recomposition') {
    return silent(`the declared phase is "${input.phase}", so there is no recomposition to re-ask`);
  }
  const triggers = [
    ...boundaryTrigger(input),
    ...cumulativeLossTrigger(input),
    ...leannessTrigger(input),
  ];
  if (triggers.length === 0) return silent(noTriggerReason(input));
  const level = strongestLevel(triggers);
  const blocking = suppressingDecline(input, level);
  if (blocking !== null) {
    return silent(
      `declined at the "${blocking.level}" level on boundary ${blocking.boundaryCount}; not ` +
        're-offered until a later block boundary or a higher band',
    );
  }
  return { proposal: buildProposal(input, triggers, level), silentReason: null };
}
