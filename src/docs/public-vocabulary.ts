// The public half of the confidentiality guard: every identifier that is
// already part of this project's published surface, so the guard can treat
// anything else identifier-shaped as protocol detail.
//
// Derived, not typed. The bulk comes from the live tool schemas and from the
// markdown this repo already publishes, so documenting a field is what makes it
// pass — there is no separate list to remember to update.
//
// Accepted trade: README.md and docs/ ship in a public repo, so their
// vocabulary is public by definition. A register name written into one of them
// would be allowlisted here, but it would also already be published; that is a
// source problem (VW-213), not something a site generator can repair.
//
// A source that is ALSO rendered into a page is a different and worse problem:
// one edit both copies the token onto the public page and tells the guard the
// token is public, with no review gate in between. Every source below was
// audited against that:
//
//   - tool names, schema property names, enum members — rendered, but they are
//     the call contract. `tools/list` hands them to every client whatever this
//     site does, and a page that redacted them could not be used to call the
//     tool. Schema `description` prose, which is where a register would
//     realistically be written, is NOT harvested and IS redacted.
//   - resource URIs — rendered, same reasoning: the URI is the contract.
//   - push-event names — harvested from `event_type` literals under
//     `src/state/`, not from the doc that renders them. Poisoning this needs a
//     second edit, in code, through review.
//   - published markdown — `docs/push-events.md` is excluded by the generator
//     because it is the one file whose text is rendered. README.md and every
//     other `docs/*.md` are harvest-only; the generator reads no text from them.
//   - the explicit lists below — not rendered, and editing one is itself the
//     review gate.

import { normalizeIdentifier } from './protocol-guard.js';

/** Identifier-shaped tokens, however spelled, for vocabulary harvesting. */
const IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*\b/g;

export interface ToolLike {
  readonly name: string;
  readonly inputSchema?: unknown;
}

export interface VocabularySources {
  readonly tools: readonly ToolLike[];
  readonly resourceUris: readonly string[];
  /**
   * Push-event names read from their publish sites in `src/state/`. This is the
   * list `docs/push-events.md` itself calls authoritative, and taking it from
   * code rather than from that doc is the point: the doc is rendered into a
   * page, so harvesting it would let one edit both leak a token and allowlist
   * it. An event named in the table with no publish site stays flagged.
   */
  readonly publishedEventNames: readonly string[];
  /** Raw markdown of pages this repo publishes and this generator does not render. */
  readonly publishedMarkdown: readonly string[];
}

function harvest(text: string, into: Set<string>): void {
  for (const match of text.matchAll(IDENTIFIER)) into.add(normalizeIdentifier(match[0]));
}

/**
 * Property names, enum members and consts anywhere in a JSON Schema, including
 * through `anyOf` / `oneOf` / `items`. Deliberately NOT `description` text: a
 * description is server prose, and letting it seed the vocabulary would let a
 * register name allowlist itself just by being mentioned.
 */
function harvestSchema(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) harvestSchema(item, into);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const schema = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue;
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const name of Object.keys(value)) into.add(normalizeIdentifier(name));
    }
    if (key === 'enum' && Array.isArray(value)) {
      for (const member of value) into.add(normalizeIdentifier(String(member)));
    }
    if (key === 'const') into.add(normalizeIdentifier(String(value)));
    harvestSchema(value, into);
  }
}

function addToolVocabulary(tool: ToolLike, into: Set<string>): void {
  into.add(normalizeIdentifier(tool.name));
  for (const segment of tool.name.split('.')) into.add(normalizeIdentifier(segment));
  harvestSchema(tool.inputSchema, into);
}

/**
 * Response field names that tool descriptions cite but no schema declares —
 * this server returns text, so its output shape is documented in prose only.
 * Each entry is a field a caller reads off a result. Adding a field to a
 * description costs one line here, and that line is the review gate: someone
 * has to look at the token and call it public.
 */
export const DOCUMENTED_RESULT_FIELDS: readonly string[] = [
  'active_mode',
  'adoptedReps',
  'analytics_count',
  'anchorSelection',
  'assumesBeginner',
  'atRomFraction',
  'autoArm',
  'auto_armed',
  // VW-310: which curve answered a `vbt.rir` reading — the lifter's own
  // fitted RIR-velocity model (VW-298) or the general-profile fallback.
  'basis',
  'blockBoundary',
  'bounceCount',
  'byMuscleGroup',
  'cardioLimitation',
  'chainSettingLbs',
  'channelsLastConfirmedAt',
  'comparedTo',
  'connection_state_change',
  'cuesMidSet',
  'currentPair',
  'dashboardAvailable',
  'dashboardDisabledReason',
  'dashboardUrl',
  'disconnect_notice',
  'diveBomb',
  'diveBombCount',
  'dwellLengthenedMs',
  'dwellShortenedMs',
  'eccentricPeakOverConcentricPeak',
  'eccentricPercentTenths',
  'echoedAfterMs',
  // VW-294: the warm-up ramp's own field, on `isometric.measure_max`'s `warmup`.
  'effortLevel',
  'event_type',
  // VW-296: the joint-angle gate on `isometric.measure_hold`'s `jointAngleGate`.
  'jointAngleGate',
  'exercisePeakAngleDeg',
  'deltaDeg',
  'angle_mismatch',
  'angle_unverified',
  'feelSetOnly',
  'firmware_count',
  // VW-267: the e1RM error band's own fields, on `metrics.compute`'s
  // `strength.e1rm` and `history.trend` results.
  'biasLbs',
  'biasPct',
  'fitFor',
  'highLbs',
  'lowLbs',
  'seeLbs',
  'seePct',
  'seePctCi',
  // VW-298: the RIR-velocity curve's own fields, on `rir_velocity.target` and
  // on `coaching.explain`'s `rirVelocityTarget`. The velocity is not readable
  // without knowing whether it extrapolates, and the fit's error is quoted in
  // reps because that is the unit the source paper reports.
  'rirErrorReps',
  'rirVelocityTarget',
  'velocityTargetMps',
  'withinFittedRange',
  // VW-270: the asymmetry verdict's own fields, on
  // `isometric.measure_imbalance`. The percentage is meaningless without the
  // CVs it was judged against, so the description names all of them and every
  // one is a number a caller reads off the result.
  'asymmetryPct',
  'intraLimbCvPct',
  'noiseFloorCvPct',
  'directionHistory',
  'testsCompared',
  'agreementPct',
  // VW-299: the fitted MVT on a `baselines.*` row, and the provenance label
  // `metrics.compute strength.e1rm` reports beside its estimate. All five are
  // numbers or labels a caller reads straight off a result.
  'optimalMvt',
  'optimalMvtErrorPct',
  'optimalMvtSampleSize',
  'optimalMvtObservedV1rm',
  'mvtBasis',
  // VW-271: peak force as the isometric headline, RFD/impulse as
  // diagnostic-only, and the per-athlete peak-force baseline / adjusted-SEM
  // change check on `isometric.measure_max` and `isometric.measure_imbalance`.
  'meanPeakForceLbs',
  'diagnostic',
  'rfdLbPerS',
  'impulseLbS',
  'plateauForceLbs',
  'peakForceBaseline',
  'changeFromBaseline',
  'sampleSize',
  'meanLbs',
  'semLbs',
  'cvPct',
  'thresholdLbs',
  'deltaLbs',
  'changed',
  // VW-280: stored assessments now carry a lifter / exercise / session key, so
  // the runs that predate it are excluded from both series and counted.
  'legacyUnkeyed',
  // VW-295: the equation a stored assessment's asymmetry math was computed
  // under, fixed per test type, and the exclusion count for a stored
  // occasion whose equation does not match this run's.
  'asymmetryEquation',
  'otherEquation',
  // VW-274: the mount-load envelope check on `isometric.measure_hold`,
  // `isometric.measure_max`, `isometric.measure_imbalance` and
  // `device.set_eccentric`.
  'mountLoadWarning',
  // VW-277: the diet-phase tolerance context and the two verdicts it produces,
  // on `plan.suggest_progression`, `metrics.compute` `history.trend` and
  // `session.readiness`.
  'dietPhaseContext',
  'weeksInPhase',
  'toleranceApplied',
  'zoneVerdict',
  'as-read',
  'plateau.verdict',
  'plateau.dietPhaseContext',
  // Cited alongside the two new verdicts, because the point of both sentences
  // is that the upstream field is left alone.
  'isPlateau',
  'plateau.isPlateau',
  // VW-452: the flatline run behind a load metric's plateau verdict.
  'plateau.flatline',
  'slopeLbsPerWeek',
  'flatBelowLbsPerWeek',
  'readiness.zone',
  // VW-286: `accountability.state`'s result — the persisted protocol row plus
  // the dry-run decision. `action` is `send` or `silent`; `kind` names an
  // entry in the composer's copy pack, never a state.
  'protocolState',
  // The `protocolState` value and the `kind` values, which are snake_case and
  // so read as protocol-shaped tokens to the guard until they are named here.
  'realign_needed',
  'sunday_anchor',
  'miss_recovery',
  'ghost_nudge',
  'realign_opener',
  'enteredAt',
  'evaluatedAt',
  'tick',
  'reason',
  'kind',
  'consecutiveMisses',
  'lastInboundAt',
  'holdingUntil',
  'ghostSendsThisEpisode',
  'proactiveSendsInWindow',
  'persisted',
  'adherenceTrend',
  'decision',
  'action',
  // VW-291: `accountability.preview`'s own result field — the live values a
  // rendered message read, alongside `accountability.state`'s fields above.
  'inputsUsed',
  'goalRealism',
  'guided_load_state',
  'hesitatedCount',
  'idle_timeout_ms',
  'inactivityTimeoutMs',
  'inactivity_timeout',
  'lastOverFirstEligible',
  // VW-269: `session.readiness`'s `probeLoad` option — the loose params shape
  // declares it as a bare string (see `registerMetricsTools`), so its
  // `'legacyFirstRep'` value isn't harvested from an enum the way a real
  // `z.enum` would be.
  'legacyFirstRep',
  'load_state',
  'lossPct',
  'matchedProbe',
  'measurementId',
  'medicalClearanceNote',
  'medicalClearanceRequired',
  'meso_length_grew_mid_block',
  'modeConfirmation',
  'modeEcho',
  'mode_revert_latched',
  'movementClassKnown',
  'noValidComparison',
  'no_active_set',
  'notifyOn',
  // VW-290: `session.get`'s plan-derived pace estimate and its own fields, also
  // carried on the dashboard snapshot the wall rail reads.
  'sessionPace',
  'plannedMinutes',
  'elapsedMinutes',
  'plannedSetsRemaining',
  'projectedEndAt',
  'perRep',
  'pauseBottom',
  'pauseTop',
  'peakForceLbs',
  'phase_type',
  'pooledFallback',
  'pre_summary',
  'priorPair',
  'raw_frame',
  // VW-378: the declared recomposition bodyweight target, echoed back on every
  // `profile.set_diet_phase` range it was declared on.
  'recompMode',
  'repCount',
  'run_in_background',
  'repCountDisagreement',
  'repDelta',
  'rep_boundary',
  'reported_minus_one',
  'requested_mode',
  'rirTarget',
  'romFractionOfSetMedian',
  'romVsBaselinePct',
  'setsByMuscle',
  'setsByTargetMuscle',
  'setsPerExercise',
  // VW-327: `profile.get_body_metrics`'s trailing 7-day bodyweight mean.
  'sevenDayMeanBodyweightLbs',
  // VW-364: the leanness legs on `profile.get_body_metrics`. `leannessSeries`
  // and `waistSeries` are raw; the body-fat side comes back graded by source,
  // flagged display-only, and with a banded change per same-source pair.
  'leannessSeries',
  'waistSeries',
  'bodyFatReadings',
  'bodyFatChanges',
  'absoluteSeePctPoints',
  'bandPctPoints',
  'deltaPctPoints',
  'displayOnly',
  'displayOnlyReason',
  'sourceNote',
  'citationIds',
  'setsUnlocked',
  // VW-170: `system.speak`'s report that a queued line was dropped by a later
  // `interrupt: true` call rather than spoken, and `device.set_weight`'s
  // warning that the firmware will hold the old load until the cable slackens.
  'spoken',
  'weightChangeWarning',
  'set_boundary',
  // A documented variant of the `set_ended` event, distinguished by a
  // `meta.closed_by` discriminator rather than by its own `event_type`, so the
  // publish-site scan does not reach it.
  'set_ended_by_device',
  'setting_coerced',
  'settings_update',
  'sideSplit',
  // VW-272: the cable-geometry gate on `progression.get_for_exercise`'s
  // `sideSplit`, and the two verdicts it can carry.
  'setupComparability',
  'setupReason',
  'setupSignatures',
  'setup_confounded',
  'setup_unverified',
  // VW-275: the declared setup card (anchor/mountHole/cableLengthSetting/mode)
  // on `exercise.confirm_setup` and the card gate on
  // `progression.get_for_exercise`'s `setupCard`.
  'setupCard',
  'mountHole',
  'cableLengthSetting',
  'setup_card_mismatch',
  'setup_card_unverified',
  // VW-304: which metric a per-side comparison actually used, and why.
  'comparisonMetric',
  'comparisonBasis',
  'lastSessionPeakForceLbs',
  'peak_force',
  'mean_velocity',
  'top_weight',
  'state_dump',
  'stopOn',
  'targetReps',
  'target_hit',
  'tonnageLbs',
  'topLoad',
  'unknown_slot',
  'velocityFractionOfPeak',
  'velocityLoss',
  'voiceReady',
  'whisperCli',
  // Dotted paths into a result object, cited the way a caller would read them.
  'band.fitFor',
  'band.note',
  'baseline.note',
  'decay.lastOverFirstEligible',
  'guided_load.phase',
  'nearest.reasons',
  'sideSplit.setupComparability',
  'sideSplit.setupReason',
  'sideSplit.setupSignatures',
  'sideSplit.comparisonMetric',
  'sideSplit.comparisonBasis',
  'variance.cv',
  'voiceReady.model',
  'voiceReady.whisperCli',
  'watch.inactivityTimeoutMs',
  'watch.velocityLoss.force',
  // VW-297: `timer.start`'s rest-duration basis, when no explicit `durationMs`
  // was given.
  'restBasis',
  // VW-441: a coach-set plan rest, taken as-is.
  'explicit_plan',
  'intent_default',
  'intent_default_extended',
  'prevRepsToThreshold',
  'currRepsToThreshold',
  'extensionSeconds',
  // VW-306: the two fatigue axes, on `metrics.compute`'s
  // `session.perturbation` and `session.fatigue` results.
  'fatigueAxes',
  'entryDepression',
  'lateSessionDecay',
  // VW-307: the self-reported pre-session carb context, on `session.start`,
  // `session.checkin` and `report.weekly`'s per-session entries.
  'preSessionCarbs',
  'hoursSinceLastMeal',
  // VW-314: the shared e1RM-PR verdict on `metrics.compute`'s `strength.e1rm`
  // result.
  'isPR',
  'priorBest',
  // VW-326: the prescribed-phase fields on a `training_weeks` row, returned
  // by `plan.week.create` and `plan.week.list_for_block` and carried on the
  // dashboard plan-tree's week view.
  'phaseType',
  'isDeload',
  'weekIndex',
  // VW-350: the `goal.*` results. A declared priority and its stored row
  // (`mesosHeld`, `tierUsed`), the four advisory codes `goal.declare_priorities`
  // can return, the derived band a proposal carries, and the three refusal
  // codes `goal.accept_target` enforces the fixed-target rule with.
  'mesosHeld',
  'tierUsed',
  'specialize_cap_exceeded',
  'priority_changed_mid_block',
  'priority_persistence_nudge',
  'fat_loss_specialize_beginner_exception',
  'declineFatLossDowngrade',
  'anchorReps',
  'anchorLoad',
  'startValue',
  'startMeasuredAt',
  'matchedSessionCount',
  'bandLowPctPerWeek',
  'bandHighPctPerWeek',
  'committedValue',
  'stretchValue',
  'infoLevel',
  'tierProvisional',
  'dietPhaseAtDerivation',
  'acceptedBy',
  'acknowledgedStretch',
  'acknowledgeStretch',
  'bandUnchanged',
  'newChapterAt',
  'rpIds',
  // VW-361: the exercise-chapter boundary and the two fields that report it.
  // `windowStartedAt` has been on `progression.get_for_exercise`'s response
  // since v1 and only now appears in a description, which is what brings it
  // through this gate.
  'chapterStartedAt',
  'chapterId',
  'newChapter',
  'sessionsSince',
  'windowStartedAt',
  'GOAL_TARGET_FIXED',
  'GOAL_TARGET_BELOW_BAND',
  'GOAL_TARGET_ABOVE_BAND',
  // VW-399: the anchor load a `reps_at_load` target is counted at, and its refusal code.
  'reps_at_load',
  'GOAL_ANCHOR_LOAD_NOT_APPLICABLE',
  // VW-444: the starting-ramp notice on a cold lift target in
  // `goal.propose_targets` and `goal.accept_target`.
  'startingRamp',
  'sessionsNeeded',
  'blockedBy',
  'baselineState',
  'reProposeAfterCalibration',
  // VW-444 part 2: the recalibration offer on `goal.propose_targets`,
  // `goal.weekly_review`, `goal.accept_target` and `goal.retire`.
  'recalibrationOffers',
  'offerTargetId',
  'acceptedCommittedValue',
  'recalibration',
  'supersededTargetId',
  'decisionId',
  'declinedOffer',
  'GOAL_RECALIBRATION_WITHDRAWN',
  // VW-459: `goal.declare_priorities` refuses a second whole-body priority for one ref.
  'GOAL_WHOLE_BODY_PRIORITY_EXISTS',
  // VW-359: the block-boundary re-ask on `blockBoundary`.
  'realignment',
  'warningsIfChanged',
  'mesosHeld',
  // VW-376: `goal.weekly_review`'s result. The observation the rate loop read,
  // the vetoes and off-cadence conditions that held or released a proposal,
  // the proposal row it recorded, and the assertion that the committed line
  // was only read. The internal urgency rank is NOT here: it ranks RP's own
  // calorie-adjustment bands, this server prescribes none, and no result field
  // carries it.
  'offCadenceConditions',
  'lowConfidence',
  'suppressedByDecline',
  'committedUnchanged',
  'readingCount',
  'reviewedAt',
  // VW-369: the recomposition re-ask, also on `blockBoundary`. `proposal` is
  // null whenever `silentReason` says why nothing was offered.
  'recompReAsk',
  'silentReason',
  // VW-462: session counts read in training days, one per local day trained.
  'rolling28DayTrainingDays',
  'trainingDaysCompleted',
  'trainingDaysLogged',
  // VW-462 returner path: which gate raised the tier ceiling, and the evidence behind it.
  'ceilingBasis',
  'logged_history',
  'returner',
  'loggedHistoryMet',
  'longestLoggedGapDays',
  'lastBreakQuestion',
  // VW-474: dated blocks. `plan.block.calendar`'s per-week template count and
  // local training days, and the schedule-row kind a missed week records.
  'sessionDays',
  'templateCount',
  'week_skipped',
];

/**
 * The `pipeline` selector on `metrics.compute`. Its schema declares a bare
 * string — the seventeen accepted literals exist only in the description — so
 * these cannot be harvested and are listed instead.
 *
 * All seventeen, pinned against the dispatch in `src/tools/metrics-tools.ts` by
 * `src/__tests__/docs/check-docs.test.ts`. Nine were missing, which mattered
 * once `scripts/check-docs.mjs` started reading this list: seven of the
 * sixteen open with a tool namespace (`session.`), so a partial list makes a
 * pipeline name look like a tool that was never registered.
 */
export const ANALYTICS_PIPELINE_IDS: readonly string[] = [
  'fatigue.set',
  'fatigue.verdict',
  'history.trend',
  'history.weekly_volume',
  'quality.bounce',
  'quality.hesitation',
  'quality.rep',
  'quality.rom',
  'session.fatigue',
  'session.junk_volume',
  'session.perturbation',
  'session.readiness',
  'session.strength',
  'session.volume',
  'vbt.profile',
  'vbt.rir',
  'vbt.set',
];

/**
 * Names from outside this project that descriptions cite: SDK entry points,
 * analytics helpers, and platform names. Public by virtue of belonging to a
 * published API or product, not to the device protocol.
 *
 * A DOTTED name is not derivable from its owner: `TrainingMode` here does not
 * make `TrainingMode.Isokinetic` public, because normalization collapses the
 * whole token to one form. So every member a description could reasonably cite
 * is listed, not just the one a description happens to cite today — an
 * allowlist that is complete only in the direction someone looked is this
 * campaign's recurring failure, and it fails by silently redacting a public
 * name, which reads to a reader as detail somebody chose to hide.
 */
export const EXTERNAL_NAMES: readonly string[] = [
  'analyzeTrend',
  'checkDriftGuard',
  'checkMrvGuard',
  'classifyWeeklyVolume',
  'detectPlateau',
  'e1RM',
  'evaluateE1RMPr',
  'exitWorkout',
  'FatigueIndex',
  'getVolumeByMuscleGroup',
  'getWeeklySummaries',
  'iPad',
  'KNOWN-ISSUES',
  'macOS',
  'MockBLEAdapter',
  'MockBLEAdapter.configure',
  'MockBLEAdapter.injectError',
  'onPerRep',
  'TrainingMode',
  'TrainingMode.CustomCurves',
  'TrainingMode.Damper',
  'TrainingMode.Idle',
  'TrainingMode.Isokinetic',
  'TrainingMode.ResistanceBand',
  'TrainingMode.Rowing',
  'TrainingMode.WeightTraining',
  'TrainingModeNames',
  'Workout.GO',
  'Workout.STOP',
];

/** Every identifier the published surface already contains, normalized. */
export function derivePublicVocabulary(sources: VocabularySources): Set<string> {
  const vocabulary = new Set<string>();
  for (const tool of sources.tools) addToolVocabulary(tool, vocabulary);
  for (const uri of sources.resourceUris) harvest(uri, vocabulary);
  for (const name of sources.publishedEventNames) vocabulary.add(normalizeIdentifier(name));
  for (const markdown of sources.publishedMarkdown) harvest(markdown, vocabulary);
  for (const name of DOCUMENTED_RESULT_FIELDS) vocabulary.add(normalizeIdentifier(name));
  for (const name of ANALYTICS_PIPELINE_IDS) vocabulary.add(normalizeIdentifier(name));
  for (const name of EXTERNAL_NAMES) vocabulary.add(normalizeIdentifier(name));
  return vocabulary;
}
