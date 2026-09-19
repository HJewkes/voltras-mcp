// `profile.*` tool handlers — the training-background write/read path
// (VW-96 Wave 3).
//
// `training_profile` has existed as inert DDL since v6 (schema-only, no
// writer, deliberately cheap to add ahead of any consumer — see
// `sqlite-store.ts`). This module gives it its first read/write call sites.
//
// Storage only. These handlers capture the user's self-reported answers
// verbatim and hand them to the store; they never compute or infer a tier.
// Tier derivation is VW-92's job, against this table, with a different owner.
//
// `profile.set_training_background` merges each call onto the existing row
// (read-modify-write) rather than overwriting the whole row, because the
// design doc (tier-signal design, data-layer-migration-plan.md §6a) expects
// onboarding to ask its handful of questions across separate turns — a
// naive full-row `INSERT ... ON CONFLICT DO UPDATE` with unset fields bound
// to NULL would wipe out an earlier answer on every subsequent call.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
  BODY_FAT_SOURCE_TIERS,
  sameDeviceDelta,
  type BodyFatReading,
  type BodyFatSource,
  type BodyFatTier,
  type SameDeviceDelta,
} from '../analytics/body-fat-sources.js';
import { onboardingGaps, type OnboardingGaps } from '../profile/onboarding-gaps.js';
import {
  startingPrescription,
  type StartingPrescription,
} from '../profile/starting-prescription.js';
import {
  ProfileGetBodyMetricsInput,
  ProfileRespondRecompAdvisoryInput,
  ProfileGetOnboardingGapsInput,
  ProfileGetStartingPrescriptionInput,
  ProfileGetTierSignalInput,
  ProfileGetTrainingBackgroundInput,
  ProfileGetWeeklyCheckinInput,
  ProfileLogBodyweightInput,
  ProfileLogBodyweightInputRefined,
  ProfileLogWeeklyCheckinInput,
  ProfileSetDietPhaseInput,
  ProfileSetDietPhaseInputRefined,
  ProfileSetTrainingBackgroundInput,
  WEEKLY_CHECKIN_CODES,
  WEEKLY_CHECKIN_KIND,
} from '../schemas/profile.js';
import type { CheckinScaleValue } from '../schemas/session.js';
import type { ServerState } from '../state/server-state.js';
import type { LeannessBand } from '../store/leanness-band.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredBodyMetric,
  type StoredDietPhase,
  type StoredTrainingProfile,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { resolveDefaultProgram } from './plan-tools.js';
import { buildRecompDegradation, recordRecompResponse } from './recomp-degradation.js';
import type { RecompDegradationResult } from '../analytics/recomp-degradation.js';
import { getTierSignal, type TierSignal } from './tier-signal.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap the `profile.*` placeholders with their real handlers. Mirrors the
 * install pattern used by the other tool registries (see `plan-tools.ts`).
 */
const SET_TRAINING_BACKGROUND_DESCRIPTION =
  "Record the user's self-reported onboarding/training-background answers: declaredTier, " +
  'yearsTraining, historyConsistent, everPlateaued (a real plateau event — the honest signal ' +
  'for graduating beginner->intermediate, more reliable than years trained or a physique ' +
  'read), reportedSetsPerMuscle, goal, daysAvailable (days per week they WANT), ' +
  'daysReliable (days per week they can DEFINITELY make — the number to actually program ' +
  'against, distinct from daysAvailable), currentBaseline (where they are NOW, free text), ' +
  'effortTolerance (low/moderate/high — how hard they are willing to be pushed) and target ' +
  '(where they want to END UP, free text). Those last three stay DISTINCT from each other ' +
  'and from goal on purpose: collapsing them is how intake ends up reading a target as a ' +
  'baseline. Also lastBreakMonths (how many months the most recent break from consistent ' +
  'training lasted, 0 if none: the length of the break, not the time since it ended) and ' +
  'namedProgramHistory (WHICH named program reportedSetsPerMuscle came from — ' +
  '5/3/1 and German Volume Training imply very different starting volumes for the same set ' +
  'count, so a raw set report without it is uninterpretable) and injuries (self-reported ' +
  'limitations: area, kind, optional note, and cardioLimitation for a CARDIOVASCULAR one). ' +
  'Set cardioLimitation only when the lifter reports a cardiovascular limitation; it is a ' +
  'hard gate to a doctor, not a severity marker for an ache. Call is a merge onto the ' +
  'existing row, not an overwrite — pass only the fields you have an answer for; earlier ' +
  'answers are preserved across multiple onboarding turns. injuries is the one exception: it ' +
  'REPLACES the stored list, so send every injury still standing, and send [] for "asked, ' +
  'none" (which is a different answer from never having asked). This tool only stores ' +
  'verbatim self-report; it never infers or computes an experience tier (see ' +
  'profile.get_tier_signal for that), and it never interprets an injury clinically.';

const GET_TRAINING_BACKGROUND_DESCRIPTION =
  'Read back the stored training-background/onboarding profile for the user. Returns ' +
  '`profile: null` if nothing has been captured yet.';

const GET_TIER_SIGNAL_DESCRIPTION =
  'Read a crude experience-tier signal derived from the stored training profile and the logged ' +
  'history: a coarse ceiling on the declared tier, not a validated classification. Read-only. ' +
  '`confidence` is `confident` only once 24 training days span 12 weeks; `trainingDaysLogged` ' +
  'counts distinct days trained, so a visit logged as one session per exercise is one day. The ' +
  'ceiling reaches intermediate on a reported plateau plus either that logged history ' +
  '(`ceilingBasis: logged_history`) or the returner path (`ceilingBasis: returner`): at least ' +
  'a year of declared training, a last break under 12 months (`lastBreakMonths`), and no logged ' +
  'gap of a year or more. A returner keeps the declared tier while `confidence` stays ' +
  '`provisional`; say so, and say which path applied. The ceiling only ever lowers the declared ' +
  'tier and never derives `advanced`. Check `confidence` and `source` before a tier-gated ' +
  'decision.';

const GET_STARTING_PRESCRIPTION_DESCRIPTION =
  'Seed a conservative starting point for a new lifter or a new exercise instead of ' +
  'inventing one: sessions/week, sets/exercise and an RIR target, keyed off the tier signal. ' +
  'Read-only — it writes nothing and applies nothing. Every seed is a SUGGESTION: offer it, ' +
  'accept or decline it with the lifter, and never re-apply it after a decline. RP seeds LOW ' +
  'on purpose — under-dosing week 1 is free to correct next week, while over-dosing leaves ' +
  'fatigue debt that carries forward — so do not "round up" these numbers to look ambitious. ' +
  '`assumesBeginner: true` means no tier was ever declared and the seeds are the default; ' +
  'say so out loud rather than presenting them as personalised. `setsPerExercise` may come ' +
  'back as the string `reported_minus_one`, which is an instruction to ASK the lifter what ' +
  'they currently run per muscle and seed one set below it — not a number to guess. ' +
  '`rirTarget: null` at the beginner tier is correct: beginners should not track RIR at all. ' +
  '`effortTolerance` moves only how aggressively the RIR note reads; it never changes a set ' +
  'count. `reasons[]` carries one line per seed — read them out, they are the argument.';

const GET_ONBOARDING_GAPS_DESCRIPTION =
  'List which session-0 onboarding answers are still missing, in the order RP asks them, so ' +
  'the next question is the right one instead of a re-ask. Read-only; it stores nothing and ' +
  'invents no questions — `missing[]` is exactly the unanswered ' +
  '`profile.set_training_background` fields. `medicalClearanceRequired: true` means the lifter ' +
  'reported a CARDIOVASCULAR limitation: read `medicalClearanceNote` out as written and route ' +
  'them to a doctor. Do not interpret, grade or program around a cardiovascular flag — that is ' +
  'a liability boundary, and nothing in this server reasons about it further. ' +
  'Non-cardiovascular injuries are not a gate and never set that flag. `goalRealism` is the ' +
  "stored goal and target plus RP's rule for checking commitment against them; it is PROSE TO " +
  'APPLY WITH THE LIFTER, never a verdict this tool computed. `goalRealism: null` means no ' +
  'goal or target has been captured yet. `lastBreakMonths` is listed only for a lifter who ' +
  'declared above beginner while their logged history is still short; `lastBreakQuestion` is ' +
  'then the question to ask, as written.';

const SET_DIET_PHASE_DESCRIPTION =
  'Record the ACTUAL diet phase the lifter is in — fat-loss, gain, maintenance or ' +
  'recomposition (a maintenance-calorie strategy run by its own name) — as a ' +
  'time range starting now, or at `startedAt` for a phase that began earlier. Declaring a ' +
  'phase closes the previous one at the same instant, so the timeline never has two phases ' +
  'covering one day; a `startedAt` in the past REWRITES the timeline from there forward, ' +
  'which is the supported way to correct a phase you logged late or mislabelled. Returns the ' +
  'declared range plus the whole timeline, oldest-first — read it back to the lifter to ' +
  'confirm the correction landed where they meant. This is the OBSERVED phase (what they ' +
  'actually ate), which is a different claim from the prescribed phase_type on a plan week, ' +
  'and this tool never touches that. A recomposition REQUIRES recompMode, the bodyweight ' +
  'target it is run against: hold (stay inside the maintenance corridor) or slow-loss (a slow, ' +
  'deliberate drop while training hard). ASK THE LIFTER WHICH and pass their answer — never ' +
  'infer it from the scale, and never pass it for any other phase, which is refused. It is the ' +
  'one input that moves this phase’s bodyweight goal band. Recording a phase changes NO other ' +
  'analysis: it does not ' +
  'suppress a plateau verdict, weight a comparison or move any threshold. It makes the phase ' +
  'visible so a reader can discount a flat stretch themselves — a fat-loss phase can look ' +
  'identical to a real plateau, and only the reader can tell which they are looking at.';

const LOG_BODYWEIGHT_DESCRIPTION =
  'Record a self-reported bodyweight reading: bodyweightLbs (required), measuredAt (optional, ' +
  'defaults to now) and note (optional). A second call at the same measuredAt UPDATES that ' +
  'reading rather than duplicating it — the supported way to correct one logged in error, and ' +
  'the update REPLACES every optional field, so restate the whole reading. Storage only: this ' +
  'tool computes no trend, rate or verdict. Four optional leanness fields ride on the same ' +
  'reading. leannessBand is a self-reported visual band — high, moderate, lean or very-lean — ' +
  'and is the primary leanness input; never infer it from a photo, a weight or a percentage. ' +
  'waistIn is a waist tape in inches, kept as a RAW trend and never converted to a body-fat ' +
  'percentage by this server or by you. bodyFatPct is an absolute percentage and requires ' +
  'bodyFatSource naming where it came from (dexa, consumer_bia, mf_bia, navy_tape, bodpod, ' +
  'hydrostatic_measured_rv, hydrostatic_predicted_rv, skinfold_7site, skinfold_3_4_site, ' +
  'scan_3d, ultrasound, mri, ct, other); it is stored for DISPLAY only. measurementProtocol is ' +
  'free text for how a scan was actually run, which matters because two readings taken under ' +
  'different protocols are not comparable. NEVER ask the lifter to go and get measured, and ' +
  'never propose a schedule for doing so: log what they volunteer and nothing more.';

const GET_BODY_METRICS_DESCRIPTION =
  'Read back logged bodyweight readings, newest-first. sinceDays optionally limits how far ' +
  'back the returned series goes; omitted returns the whole history. ' +
  'sevenDayMeanBodyweightLbs is the mean of readings from the last 7 days, reported only when ' +
  'there are at least 3 such readings (null otherwise) — advisory context, never a rate-of-' +
  'change verdict. leannessSeries and waistSeries come back RAW, newest-first: a waist ' +
  'measurement is a trend leg and has no percentage conversion anywhere in this server. ' +
  'bodyFatReadings grades each body-fat reading by its source — tier (reference/high/moderate/' +
  'low), absoluteSeePctPoints, citationIds and sourceNote — and every entry carries ' +
  'displayOnly: true with displayOnlyReason. Read the absolute number out as a display value ' +
  'only, never as a measurement and never as evidence for a training decision. ' +
  'bodyFatChanges holds one entry per consecutive pair of body-fat readings: a pair from the ' +
  'SAME source gets delta with deltaPctPoints, bandPctPoints (the change-error band for that ' +
  'source) and a verdict of increase, decrease or "no measurable change" — a movement inside ' +
  'the band IS "no measurable change" and must never be read out as a direction. A pair whose ' +
  'sources differ gets delta: null and a reason; render the reason, not a comparison.';

const LOG_WEEKLY_CHECKIN_DESCRIPTION =
  "Record the lifter's Sunday weekly check-in: three independently optional 3-point ratings " +
  '(low/medium/high, the same coarse scale session.checkin uses) — hunger, dietPlanAdherence ' +
  'and sleepQuality. Anchored to weekOf (an ISO date, defaults to the most recent Sunday), ' +
  'not to any session, so it is answered once a week regardless of whether a session runs ' +
  'that day. Calling it with every field omitted is legal and still stores a row for the ' +
  'week, distinct from never checking in at all — the downstream rate advisory (VW-367 §2d) ' +
  'degrades to observed-only (bodyweight trend alone) when a week has no answers, rather than ' +
  'treating a silent week the same as one where the lifter reported nothing wrong. A second ' +
  'call for the same weekOf adds new rows rather than deleting the first — ' +
  'profile.get_weekly_checkin reads back the most recently recorded answer per field, so a ' +
  'later call still acts as a correction. ' +
  'hunger is the lever-choice input: it is what tells the advisory whether an unexpected ' +
  'rate looks like an intake problem or an activity one, so weight it accordingly. ' +
  'dietPlanAdherence corroborates hunger — it does not drive anything on its own. ' +
  'sleepQuality is a CONFOUNDER LINE ONLY: read it out alongside a rate observation as context, ' +
  'never as a trigger for changing the plan (VW-367 §2d — the corpus never treats sleep as a ' +
  'tracked autoregulation input).';

const GET_WEEKLY_CHECKIN_DESCRIPTION =
  'Read back the weekly check-in for one week (weekOf, an ISO date; defaults to the most ' +
  'recent Sunday). Returns `checkin: null` if that week has no recorded entry at all. Once a ' +
  'week has an entry, each of hunger/dietPlanAdherence/sleepQuality reads back as the answer ' +
  'given or null if that particular field was left blank — the two are different states, see ' +
  'profile.log_weekly_checkin.';

const RESPOND_RECOMP_ADVISORY_DESCRIPTION =
  'Answer the recomposition re-ask that plan.complete_workout and plan.next_workout report as ' +
  'the `recompReAsk` field of their `blockBoundary`: response is "accepted" or "declined". The ' +
  're-ask fires when a ' +
  'recomposition reaches its second block boundary, when cumulative bodyweight loss ' +
  'since the phase started reaches the diet-fatigue proxy bands RP calls noticeable (7%) or ' +
  'significant (10%), or when the self-reported leanness band moves a rung toward lean. ' +
  'ANSWERING IT IS WHAT CLOSES IT. The block-boundary question opens at the second boundary ' +
  'and comes back at every boundary after that until the lifter accepts or declines it, ' +
  'because a phase with no natural end is exactly the one a skipped question keeps running. ' +
  'NEITHER ANSWER CHANGES THE PHASE. The declared phase is an observed record and ' +
  'profile.set_diet_phase is its only writer, so accepting records that the lifter agreed and ' +
  'nothing else — call profile.set_diet_phase yourself only if they ask for the switch. ' +
  'Declining files the proposal with the inputs and thresholds it fired on, and the same ' +
  'evidence is not offered again until a later block boundary or a stronger band. Call this ' +
  'only when a proposal is actually open; with none open it records nothing and says why.';

export function registerProfileTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'profile.set_training_background',
    ProfileSetTrainingBackgroundInput,
    wrapHandler(ProfileSetTrainingBackgroundInput, (input) => setTrainingBackground(state, input)),
    SET_TRAINING_BACKGROUND_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_training_background',
    ProfileGetTrainingBackgroundInput,
    wrapHandler(ProfileGetTrainingBackgroundInput, () => getTrainingBackground(state)),
    GET_TRAINING_BACKGROUND_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_tier_signal',
    ProfileGetTierSignalInput,
    wrapHandler(ProfileGetTierSignalInput, () => getTierSignalTool(state)),
    GET_TIER_SIGNAL_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_starting_prescription',
    ProfileGetStartingPrescriptionInput,
    wrapHandler(ProfileGetStartingPrescriptionInput, () => getStartingPrescription(state)),
    GET_STARTING_PRESCRIPTION_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_onboarding_gaps',
    ProfileGetOnboardingGapsInput,
    wrapHandler(ProfileGetOnboardingGapsInput, () => getOnboardingGaps(state)),
    GET_ONBOARDING_GAPS_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.set_diet_phase',
    ProfileSetDietPhaseInput,
    wrapHandler(ProfileSetDietPhaseInputRefined, (input) => setDietPhase(state, input)),
    SET_DIET_PHASE_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.log_bodyweight',
    ProfileLogBodyweightInput,
    wrapHandler(ProfileLogBodyweightInputRefined, (input) => logBodyweight(state, input)),
    LOG_BODYWEIGHT_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.respond_recomp_advisory',
    ProfileRespondRecompAdvisoryInput,
    wrapHandler(ProfileRespondRecompAdvisoryInput, (input) => respondRecompAdvisory(state, input)),
    RESPOND_RECOMP_ADVISORY_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_body_metrics',
    ProfileGetBodyMetricsInput,
    wrapHandler(ProfileGetBodyMetricsInput, (input) => getBodyMetrics(state, input)),
    GET_BODY_METRICS_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.log_weekly_checkin',
    ProfileLogWeeklyCheckinInput,
    wrapHandler(ProfileLogWeeklyCheckinInput, (input) => logWeeklyCheckin(state, input)),
    LOG_WEEKLY_CHECKIN_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_weekly_checkin',
    ProfileGetWeeklyCheckinInput,
    wrapHandler(ProfileGetWeeklyCheckinInput, (input) => getWeeklyCheckin(state, input)),
    GET_WEEKLY_CHECKIN_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

/**
 * Every field that merges by simple copy. `declaredTier` and `goal` are absent
 * because each also refreshes its own timestamp, and `userId`/`onboardedAt`/
 * `updatedAt` are the handler's to set, never the caller's.
 */
const PLAIN_MERGE_FIELDS = [
  'yearsTraining',
  'historyConsistent',
  'everPlateaued',
  'reportedSetsPerMuscle',
  'daysAvailable',
  'daysReliable',
  'currentBaseline',
  'effortTolerance',
  'target',
  'namedProgramHistory',
  'lastBreakMonths',
  // `injuries` copies wholesale like the rest, but the value it copies is the
  // WHOLE list: a caller re-sends every injury still standing, so a resolved
  // one can actually disappear. `[]` is a real answer ("asked, none").
  'injuries',
] as const satisfies ReadonlyArray<keyof z.infer<typeof ProfileSetTrainingBackgroundInput>>;

/**
 * Merge the caller-supplied fields onto the existing `training_profile` row
 * (or start a fresh one), stamp per-field provenance as `'user'` for whatever
 * was just supplied, and upsert. `declaredAt`/`goalSetAt` are refreshed only
 * when the corresponding value changes this call; `onboardedAt` is stamped
 * once, the first time any field is written.
 */
async function setTrainingBackground(
  state: ServerState,
  input: z.infer<typeof ProfileSetTrainingBackgroundInput>,
): Promise<{ profile: StoredTrainingProfile }> {
  const existing = await state.store.getTrainingProfile(LOCAL_USER_ID);
  const now = new Date().toISOString();
  const provenance: Record<string, 'user' | 'llm' | 'default'> = { ...existing?.provenance };

  const merged: StoredTrainingProfile = {
    ...existing,
    userId: LOCAL_USER_ID,
    onboardedAt: existing?.onboardedAt ?? now,
    updatedAt: now,
  };

  if (input.declaredTier !== undefined) {
    merged.declaredTier = input.declaredTier;
    merged.declaredAt = now;
    provenance.declaredTier = 'user';
  }
  if (input.goal !== undefined) {
    merged.goal = input.goal;
    merged.goalSetAt = now;
    provenance.goal = 'user';
  }
  for (const field of PLAIN_MERGE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    Object.assign(merged, { [field]: value });
    provenance[field] = 'user';
  }
  if (Object.keys(provenance).length > 0) {
    merged.provenance = provenance;
  }

  await state.store.putTrainingProfile(merged);
  return { profile: merged };
}

async function getTrainingBackground(
  state: ServerState,
): Promise<{ profile: StoredTrainingProfile | null }> {
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  return { profile: profile ?? null };
}

/**
 * `profile.get_tier_signal` (VW-92 MVP) — the crude ceiling only, see
 * `tier-signal.ts`. Read-only; derives nothing new here and writes nothing.
 */
async function getTierSignalTool(state: ServerState): Promise<{ tierSignal: TierSignal }> {
  const tierSignal = await getTierSignal(state, LOCAL_USER_ID);
  return { tierSignal };
}

/**
 * `profile.get_starting_prescription` (VMCP-06.04) — the tier signal and the
 * lifter's own reports, turned into a conservative seed. Read-only: the seeds
 * are returned for the agent to offer, and nothing here applies any of them.
 */
async function getStartingPrescription(
  state: ServerState,
): Promise<{ prescription: StartingPrescription }> {
  const { tier, confidence, source } = await getTierSignal(state, LOCAL_USER_ID);
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  const prescription = startingPrescription({
    tier,
    confidence,
    source,
    ...(profile?.reportedSetsPerMuscle !== undefined
      ? { reportedSetsPerMuscle: profile.reportedSetsPerMuscle }
      : {}),
    ...(profile?.daysReliable !== undefined ? { daysReliable: profile.daysReliable } : {}),
    ...(profile?.effortTolerance !== undefined ? { effortTolerance: profile.effortTolerance } : {}),
  });
  return { prescription };
}

/**
 * `profile.get_onboarding_gaps` (VW-148) — which session-0 answers are still
 * missing, plus the two pieces of RP prose that govern what to do about the
 * cardiovascular flag and the goal/commitment check. Read-only; see
 * `profile/onboarding-gaps.ts` for why neither piece of prose is computed.
 */
async function getOnboardingGaps(state: ServerState): Promise<{ gaps: OnboardingGaps }> {
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  const signal = await getTierSignal(state, LOCAL_USER_ID);
  return { gaps: onboardingGaps(profile, { loggedHistoryMet: signal.evidence.loggedHistoryMet }) };
}

/**
 * `profile.set_diet_phase` (VW-149 / VW-150) — the first writer of
 * `diet_phases`. Storage only, in the same posture as the rest of this module:
 * it records what the lifter says they are doing and derives nothing from it.
 *
 * The whole timeline comes back with the declaration because the correction
 * path is the reason this tool takes a `startedAt` at all — a caller fixing a
 * mislabelled phase needs to see where the boundaries actually landed, not
 * just that a write succeeded. Overlap-freedom is the store's guarantee (see
 * `declareDietPhase`), so the timeline is a readout, never a re-check.
 *
 * VW-378 gives a recomposition one more declared field, `recompMode`, and it
 * is the single exception to "derives nothing": the goal band reads it. This
 * tool still only records it — `goal.propose_targets` is what reads it back.
 */
async function setDietPhase(
  state: ServerState,
  input: z.infer<typeof ProfileSetDietPhaseInput>,
): Promise<{ declared: StoredDietPhase; timeline: StoredDietPhase[] }> {
  const now = new Date().toISOString();
  const declared = await state.store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: input.phase,
    startedAt: input.startedAt ?? now,
    declaredAt: now,
    ...(input.recompMode === undefined ? {} : { recompMode: input.recompMode }),
  });
  return { declared, timeline: await state.store.listDietPhases(LOCAL_USER_ID) };
}

/**
 * `profile.respond_recomp_advisory` (VW-369) — files an accept or a decline
 * against the recomposition re-ask, and writes nothing else.
 *
 * The proposal is RE-DERIVED here rather than passed in, so an answer can only
 * ever be filed against evidence that is still true. A caller holding a stale
 * proposal gets `recorded: false` and the reason it went quiet.
 */
async function respondRecompAdvisory(
  state: ServerState,
  input: z.infer<typeof ProfileRespondRecompAdvisoryInput>,
): Promise<{ recorded: boolean; reason: string; advisory: RecompDegradationResult }> {
  const program = await resolveDefaultProgram(state, undefined);
  const blocks = await state.store.getTrainingBlocksForProgram(program.id);
  const advisory = await buildRecompDegradation(state, blocks, false);
  return { ...(await recordRecompResponse(state, advisory, input.response)), advisory };
}

/**
 * `profile.log_bodyweight` (VW-327) — the first writer of `body_metrics`.
 * Upserts on `measuredAt`, so a re-log for the same instant corrects rather
 * than duplicates (see `SqliteSessionStore.putBodyMetric`).
 */
async function logBodyweight(
  state: ServerState,
  input: z.infer<typeof ProfileLogBodyweightInputRefined>,
): Promise<{ entry: StoredBodyMetric }> {
  const entry = await state.store.putBodyMetric({
    userId: LOCAL_USER_ID,
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    bodyweightLbs: input.bodyweightLbs,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.leannessBand !== undefined ? { leannessBand: input.leannessBand } : {}),
    ...(input.waistIn !== undefined ? { waistIn: input.waistIn } : {}),
    ...(input.bodyFatPct !== undefined ? { bodyFatPct: input.bodyFatPct } : {}),
    ...(input.bodyFatSource !== undefined ? { bodyFatSource: input.bodyFatSource } : {}),
    ...(input.measurementProtocol !== undefined
      ? { measurementProtocol: input.measurementProtocol }
      : {}),
  });
  return { entry };
}

/** Days a reading must fall within to count toward the 7-day mean. */
const SEVEN_DAY_MEAN_WINDOW_DAYS = 7;
/** Minimum reading count before the 7-day mean is reported at all. */
const SEVEN_DAY_MEAN_MIN_READINGS = 3;

/**
 * Why a body-fat percentage never reads as a measurement here. One line,
 * returned beside every absolute value so the caveat cannot be separated from
 * the number it qualifies.
 */
const BODY_FAT_DISPLAY_ONLY_REASON =
  'Display only: an absolute body-fat percentage carries several points of ' +
  'individual error on every source, and nothing in this server reads it (VW-370).';

/** One stored body-fat reading with what its source is worth attached. */
interface GradedBodyFatReading {
  measuredAt: string;
  bodyFatPct: number;
  bodyFatSource: BodyFatSource;
  tier: BodyFatTier;
  absoluteSeePctPoints: number | null;
  citationIds: readonly string[];
  sourceNote: string;
  displayOnly: true;
  displayOnlyReason: string;
}

/** One consecutive pair of body-fat readings, banded or refused with a reason. */
interface BodyFatChange {
  fromMeasuredAt: string;
  toMeasuredAt: string;
  fromSource: BodyFatSource;
  toSource: BodyFatSource;
  delta: SameDeviceDelta | null;
  reason: string | null;
}

/**
 * `profile.get_body_metrics` (VW-327, extended by VW-364) — read-only.
 * `sevenDayMeanBodyweightLbs` is computed over the trailing 7 days regardless
 * of `sinceDays`, so a caller asking for a longer series still gets a
 * meaningful recent mean.
 *
 * THE THREE LEANNESS LEGS COME BACK IN THREE DIFFERENT SHAPES, on purpose.
 * The band and the waist tape are raw series and nothing is derived from
 * either — in particular no circumference here ever becomes a percentage.
 * Body fat is the one that needs framing, so it comes back graded by source,
 * flagged display-only, and with a banded change per consecutive same-source
 * pair.
 */
async function getBodyMetrics(
  state: ServerState,
  input: z.infer<typeof ProfileGetBodyMetricsInput>,
): Promise<{
  series: StoredBodyMetric[];
  sevenDayMeanBodyweightLbs: number | null;
  leannessSeries: { measuredAt: string; leannessBand: LeannessBand }[];
  waistSeries: { measuredAt: string; waistIn: number }[];
  bodyFatReadings: GradedBodyFatReading[];
  bodyFatChanges: BodyFatChange[];
}> {
  const series = await state.store.listBodyMetrics(LOCAL_USER_ID, {
    ...(input.sinceDays !== undefined ? { sinceDays: input.sinceDays } : {}),
  });
  const recent = await state.store.listBodyMetrics(LOCAL_USER_ID, {
    sinceDays: SEVEN_DAY_MEAN_WINDOW_DAYS,
  });
  const sevenDayMeanBodyweightLbs =
    recent.length >= SEVEN_DAY_MEAN_MIN_READINGS
      ? recent.reduce((sum, m) => sum + m.bodyweightLbs, 0) / recent.length
      : null;
  return {
    series,
    sevenDayMeanBodyweightLbs,
    leannessSeries: series.flatMap((m) =>
      m.leannessBand === undefined
        ? []
        : [{ measuredAt: m.measuredAt, leannessBand: m.leannessBand }],
    ),
    waistSeries: series.flatMap((m) =>
      m.waistIn === undefined ? [] : [{ measuredAt: m.measuredAt, waistIn: m.waistIn }],
    ),
    bodyFatReadings: gradedBodyFatReadings(series),
    bodyFatChanges: bodyFatChanges(series),
  };
}

/** The body-fat readings in `series`, oldest first. */
function bodyFatReadingsAscending(series: readonly StoredBodyMetric[]): BodyFatReading[] {
  return series
    .flatMap((m) =>
      m.bodyFatPct === undefined || m.bodyFatSource === undefined
        ? []
        : [{ measuredAt: m.measuredAt, bodyFatPct: m.bodyFatPct, source: m.bodyFatSource }],
    )
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}

function gradedBodyFatReadings(series: readonly StoredBodyMetric[]): GradedBodyFatReading[] {
  return bodyFatReadingsAscending(series).map((reading) => {
    const row = BODY_FAT_SOURCE_TIERS[reading.source];
    return {
      measuredAt: reading.measuredAt,
      bodyFatPct: reading.bodyFatPct,
      bodyFatSource: reading.source,
      tier: row.tier,
      absoluteSeePctPoints: row.absoluteSeePctPoints,
      citationIds: row.citationIds,
      sourceNote: row.note,
      displayOnly: true,
      displayOnlyReason: BODY_FAT_DISPLAY_ONLY_REASON,
    };
  });
}

/**
 * Consecutive pairs only. A delta between two readings with something else
 * logged in between is still a same-device delta; a delta that skips a reading
 * would quietly pick the flattering endpoints.
 */
function bodyFatChanges(series: readonly StoredBodyMetric[]): BodyFatChange[] {
  const readings = bodyFatReadingsAscending(series);
  const changes: BodyFatChange[] = [];
  for (let i = 1; i < readings.length; i += 1) {
    const earlier = readings[i - 1];
    const later = readings[i];
    if (earlier === undefined || later === undefined) continue;
    const { delta, reason } = sameDeviceDelta([earlier, later]);
    changes.push({
      fromMeasuredAt: earlier.measuredAt,
      toMeasuredAt: later.measuredAt,
      fromSource: earlier.source,
      toSource: later.source,
      delta,
      reason,
    });
  }
  return changes;
}

type WeeklyCheckinScale = z.infer<typeof CheckinScaleValue>;

/** Question codes written by `profile.log_weekly_checkin`, in result order. */
const WEEKLY_CHECKIN_FIELDS = [
  { code: WEEKLY_CHECKIN_CODES[0], key: 'hunger' },
  { code: WEEKLY_CHECKIN_CODES[1], key: 'dietPlanAdherence' },
  { code: WEEKLY_CHECKIN_CODES[2], key: 'sleepQuality' },
] as const satisfies ReadonlyArray<{
  code: (typeof WEEKLY_CHECKIN_CODES)[number];
  key: 'hunger' | 'dietPlanAdherence' | 'sleepQuality';
}>;

export interface WeeklyCheckin {
  hunger: WeeklyCheckinScale | null;
  dietPlanAdherence: WeeklyCheckinScale | null;
  sleepQuality: WeeklyCheckinScale | null;
}

/** The one store read `readWeeklyCheckin` needs, as a slice (VW-376). */
export interface WeeklyCheckinReadState {
  store: Pick<SessionStore, 'getSelfReportsForUser'>;
}

/**
 * The most recent Sunday on or before `now`, as an ISO date (`YYYY-MM-DD`).
 * UTC-based and deterministic: `now`'s own day-of-week (`getUTCDay()`, 0 for
 * Sunday) is how far back to walk.
 */
export function mostRecentSundayIso(now: Date): string {
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - now.getUTCDay());
  return sunday.toISOString().slice(0, 10);
}

/** The row `recordedAt` every field of one `weekOf` shares — midnight UTC on that date. */
function weekOfRecordedAt(weekOf: string): string {
  return `${weekOf}T00:00:00.000Z`;
}

/**
 * `profile.log_weekly_checkin` (VW-374) — the second `self_reports` writer
 * after `session.checkin`, under its own `kind` so the two never mix on read.
 *
 * Writes one row per field, ALWAYS, whether or not that field was answered:
 * an omitted field still gets a row with no value, which is what makes an
 * all-null submission distinguishable from "this week was never checked in
 * at all" on read (see `getWeeklyCheckin`). `session_id` is never set — this
 * check-in is anchored to the calendar week, not to any session.
 */
async function logWeeklyCheckin(
  state: ServerState,
  input: z.infer<typeof ProfileLogWeeklyCheckinInput>,
): Promise<{ weekOf: string } & WeeklyCheckin> {
  const weekOf = input.weekOf ?? mostRecentSundayIso(new Date());
  const recordedAt = weekOfRecordedAt(weekOf);
  const answers: Record<string, WeeklyCheckinScale | undefined> = {
    hunger: input.hunger,
    dietPlanAdherence: input.dietPlanAdherence,
    sleepQuality: input.sleepQuality,
  };
  for (const field of WEEKLY_CHECKIN_FIELDS) {
    const value = answers[field.key];
    await state.store.putSelfReport({
      id: randomUUID(),
      userId: LOCAL_USER_ID,
      kind: WEEKLY_CHECKIN_KIND,
      questionCode: field.code,
      ...(value !== undefined ? { valueText: value } : {}),
      recordedAt,
    });
  }
  return {
    weekOf,
    hunger: input.hunger ?? null,
    dietPlanAdherence: input.dietPlanAdherence ?? null,
    sleepQuality: input.sleepQuality ?? null,
  };
}

/**
 * `profile.get_weekly_checkin` (VW-374) — read-only. Extends
 * `getSelfReportsForUser` (already shared with `report.weekly`) with the
 * `kind` filter added alongside it, rather than adding a new store query.
 *
 * Rows for one `weekOf` come back oldest-first; the last row per question
 * code wins, so a correcting second `profile.log_weekly_checkin` call (which
 * adds rows rather than updating them) is still read back as the correction.
 */
async function getWeeklyCheckin(
  state: ServerState,
  input: z.infer<typeof ProfileGetWeeklyCheckinInput>,
): Promise<{ weekOf: string; checkin: WeeklyCheckin | null }> {
  const weekOf = input.weekOf ?? mostRecentSundayIso(new Date());
  return { weekOf, checkin: await readWeeklyCheckin(state, weekOf) };
}

/**
 * One week's answers, or `null` when that week was never checked in at all.
 *
 * Exported for VW-376's Sunday review, which assembles the same three answers
 * into the rate advisory's input. Shared rather than re-read there so the
 * last-row-per-code rule above has one implementation.
 */
export async function readWeeklyCheckin(
  state: WeeklyCheckinReadState,
  weekOf: string,
): Promise<WeeklyCheckin | null> {
  const recordedAt = weekOfRecordedAt(weekOf);
  const rows = await state.store.getSelfReportsForUser({
    userId: LOCAL_USER_ID,
    kind: WEEKLY_CHECKIN_KIND,
    from: recordedAt,
    to: recordedAt,
  });
  if (rows.length === 0) return null;
  const latestByCode = new Map<string, WeeklyCheckinScale | null>();
  for (const row of rows) {
    if (row.questionCode === undefined) continue;
    latestByCode.set(row.questionCode, (row.valueText as WeeklyCheckinScale | undefined) ?? null);
  }
  return {
    hunger: latestByCode.get(WEEKLY_CHECKIN_CODES[0]) ?? null,
    dietPlanAdherence: latestByCode.get(WEEKLY_CHECKIN_CODES[1]) ?? null,
    sleepQuality: latestByCode.get(WEEKLY_CHECKIN_CODES[2]) ?? null,
  };
}
