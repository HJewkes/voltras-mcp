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
  'assumesBeginner',
  'atRomFraction',
  'autoArm',
  'auto_armed',
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
  'event_type',
  'feelSetOnly',
  'firmware_count',
  'goalRealism',
  'guided_load_state',
  'hesitatedCount',
  'idle_timeout_ms',
  'inactivityTimeoutMs',
  'inactivity_timeout',
  'lastOverFirstEligible',
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
  'perRep',
  'pauseBottom',
  'pauseTop',
  'peakForceLbs',
  'phase_type',
  'pre_summary',
  'priorPair',
  'raw_frame',
  'repCount',
  'run_in_background',
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
  'setsUnlocked',
  'set_boundary',
  // A documented variant of the `set_ended` event, distinguished by a
  // `meta.closed_by` discriminator rather than by its own `event_type`, so the
  // publish-site scan does not reach it.
  'set_ended_by_device',
  'setting_coerced',
  'settings_update',
  'sideSplit',
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
  'baseline.note',
  'decay.lastOverFirstEligible',
  'guided_load.phase',
  'nearest.reasons',
  'variance.cv',
  'voiceReady.model',
  'voiceReady.whisperCli',
  'watch.inactivityTimeoutMs',
  'watch.velocityLoss.force',
];

/**
 * The `pipeline` selector on `metrics.compute`. Its schema declares a bare
 * string — the sixteen accepted literals exist only in the description — so
 * these cannot be harvested and are listed instead.
 */
export const ANALYTICS_PIPELINE_IDS: readonly string[] = [
  'fatigue.set',
  'quality.rep',
  'session.fatigue',
  'session.junk_volume',
  'session.perturbation',
  'vbt.profile',
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
  'exitWorkout',
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
