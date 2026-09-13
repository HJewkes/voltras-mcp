// `report.session_results` — one free-text result string per exercise, in the
// idiom a coach already reads.
//
// SCOPE, and nothing beyond it: this renders sets that are already recorded.
// No weekly summary, no check-in, no velocity, no RIR, no derived analytics,
// and no network. TrueCoach's per-exercise "Result" is a single free-text
// field (there is no structured per-set or per-rep target), so the deliverable
// is a string like `170 lb x 12\n170 lb x 10\nwarm-up: 3 sets`.
//
// The set list is narrowed the same way every other analysis path narrows it:
// the owner's sets only (VW-169 — a guest working in is not the owner's
// result), real sets only (a mock-adapter row never reports as work), and the
// working sets picked by the shared `selectWorkingSets` rule so a ramp-up does
// not read as a light top set.

import { getRepPeakVelocity, getSetVelocitySummary } from '@voltras/workout-analytics';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import type { RirVelocityModel } from '../analytics/rir-velocity.js';
import { countMissed } from '../analytics/target-verdict.js';
import { ReportSessionResultsInput, ReportWeeklyInput } from '../schemas/report.js';
import { selectEligibleReps } from '../state/rep-eligibility.js';
import { describeLoad } from '../state/set-capture.js';
import type { ServerState } from '../state/server-state.js';
import { evaluateWeightImplied } from '../state/weight-implied-watch.js';
import { checkFeatureGate } from '../store/baseline-gate.js';
import { scopeSetsToLifter } from '../store/set-scope.js';
import {
  LOCAL_USER_ID,
  type StoredPlannedExercise,
  type StoredSelfReport,
  type StoredSession,
  type StoredSet,
  type StoredTrainingProgram,
} from '../store/types.js';
import { normaliseVelocityToMps } from '../store/velocity-units.js';
import { isWarmupSet, selectWorkingSets } from '../store/working-sets.js';
import { wrapHandler } from './helpers.js';
import { estimateRepRir } from './rir-velocity-tools.js';
import {
  computeProgressionDelta,
  resolveDefaultProgram,
  type ProgressionGates,
  type ProgressionSuggestion,
} from './plan-tools.js';
import { getTierSignal, type Tier } from './tier-signal.js';

export const REPORT_SESSION_RESULTS_DESCRIPTION =
  'Render one completed session as a per-exercise result string in the free-text idiom a coach ' +
  'reads (`170 lb x 12` per working set, `L 30 lb x 13` / `R 30 lb x 12` for a bilateral pair, ' +
  'plus a `warm-up: 3 sets` count and a `missed: 1 of 3 sets below 8 reps` line when a planned ' +
  'rep band was attached). Working sets only, by the same warm-up-then-top-load rule ' +
  "`plan.suggest_progression` uses; a guest lifter's sets, mock-adapter sets and zero-rep sets " +
  'are excluded, and an exercise with no working set is omitted. Read-only and local: it queries ' +
  'the store and makes no network call. The session must already be ended.';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

export interface ExerciseResult {
  exerciseId: string;
  exerciseName: string;
  result: string;
}

export interface SessionResults {
  sessionId: string;
  endedAt: string;
  /** Local calendar date of `endedAt` — the day the coach logs against. */
  date: string;
  exercises: ExerciseResult[];
}

export function registerReportTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('report.session_results');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: report.session_results');
  }
  tool.update({
    paramsSchema: ReportSessionResultsInput.shape,
    callback: wrapHandler(
      ReportSessionResultsInput,
      (input: z.infer<typeof ReportSessionResultsInput>) =>
        buildSessionResults(state, input.sessionId),
    ) as never,
    description: REPORT_SESSION_RESULTS_DESCRIPTION,
  } as never);

  const weeklyTool = placeholders.get('report.weekly');
  if (weeklyTool === undefined) {
    throw new Error('tool placeholder not registered: report.weekly');
  }
  weeklyTool.update({
    paramsSchema: ReportWeeklyInput.shape,
    callback: wrapHandler(ReportWeeklyInput, (input: z.infer<typeof ReportWeeklyInput>) =>
      buildWeeklyReportResult(state, input),
    ) as never,
    description: REPORT_WEEKLY_DESCRIPTION,
  } as never);
}

/**
 * The one function that renders a session's results. The tool calls it and so
 * does the outbox writer — a second rendering path would let the file on disk
 * and the tool response disagree about the same session.
 */
export async function buildSessionResults(
  state: ServerState,
  sessionId: string,
): Promise<SessionResults> {
  const session = await state.store.getSession(sessionId);
  if (session === undefined) {
    throw new ToolError('NOT_FOUND', `No session with id "${sessionId}" exists.`);
  }
  const endedAt = session.endedAt;
  if (endedAt === undefined) {
    throw new ToolError('SESSION_NOT_ENDED', `Session "${sessionId}" has not ended yet.`);
  }
  const sets = reportableSets(await state.store.getSetsForSession(sessionId), state.config.adapter);
  const planned = await loadPlannedExercises(state, sessionId);
  const exercises = [...groupByExercise(sets, session)]
    .map(([exerciseId, group]) => renderExercise(state, exerciseId, group, planned.get(exerciseId)))
    .filter((entry): entry is ExerciseResult => entry !== undefined);
  return { sessionId, endedAt, date: localDate(endedAt), exercises };
}

/**
 * Sets that count as this session's reported work. A guest's set is the
 * guest's result, a mock-adapter row is synthetic unless the whole process is
 * running on the mock adapter, and a set that recorded no rep is not a set the
 * lifter performed.
 */
function reportableSets(sets: StoredSet[], adapter: string): StoredSet[] {
  return scopeSetsToLifter(sets, undefined).filter(
    (set) => repCount(set) > 0 && (adapter === 'mock' || set.source !== 'mock'),
  );
}

/** The device counts; the derived array is the fallback when it did not. */
function repCount(set: StoredSet): number {
  return set.firmwareRepCount ?? set.reps.length;
}

/**
 * Sets keyed by exercise, in the order each exercise was first trained. A set
 * with no exercise of its own inherits the session's, and one that resolves to
 * no exercise at all is dropped — a result row with no exercise cannot be
 * written back against anything.
 */
function groupByExercise(sets: StoredSet[], session: StoredSession): Map<string, StoredSet[]> {
  const groups = new Map<string, StoredSet[]>();
  for (const set of sets) {
    const exerciseId = set.exerciseId ?? session.exerciseId;
    if (exerciseId === undefined) continue;
    const group = groups.get(exerciseId);
    if (group === undefined) groups.set(exerciseId, [set]);
    else group.push(set);
  }
  return groups;
}

/** An exercise with no working set is not a result, so it is omitted entirely. */
function renderExercise(
  state: ServerState,
  exerciseId: string,
  sets: StoredSet[],
  planned: StoredPlannedExercise | undefined,
): ExerciseResult | undefined {
  const working = selectWorkingSets(sets);
  if (working.length === 0) return undefined;
  const lines = renderWorkingSetLines(working);
  const warmups = sets.filter(isWarmupSet).length;
  if (warmups > 0) lines.push(`warm-up: ${warmups} ${pluralSets(warmups)}`);
  const missed = renderMissedLine(working, planned);
  if (missed !== undefined) lines.push(missed);
  return {
    exerciseId,
    exerciseName: state.exercises.getById(exerciseId)?.name ?? exerciseId,
    result: lines.join('\n'),
  };
}

/**
 * One line per working set, except that the two sides of a bilateral effort
 * render as an `L` / `R` pair at the position of whichever side came first.
 */
function renderWorkingSetLines(working: StoredSet[]): string[] {
  const lines: string[] = [];
  const done = new Set<string>();
  for (const set of working) {
    const groupId = set.bilateralGroupId;
    if (groupId === undefined) {
      lines.push(renderLoadAndReps(set));
      continue;
    }
    if (done.has(groupId)) continue;
    done.add(groupId);
    const pair = working.filter((other) => other.bilateralGroupId === groupId);
    lines.push(...orderBySide(pair).map((sided) => renderSidedLine(sided)));
  }
  return lines;
}

/** Left before right; a side-unknown row of the pair sorts last. */
function orderBySide(pair: StoredSet[]): StoredSet[] {
  const rank = (set: StoredSet): number => (set.side === 'left' ? 0 : set.side === 'right' ? 1 : 2);
  return [...pair].sort((a, b) => rank(a) - rank(b));
}

function renderSidedLine(set: StoredSet): string {
  const label = set.side === 'left' ? 'L ' : set.side === 'right' ? 'R ' : '';
  return `${label}${renderLoadAndReps(set)}`;
}

/**
 * `170 lb x 12`, `damper 6 x 12` (VMCP-02.74), or a bare `12 reps` for a set
 * whose mode and weight are both unknown.
 */
function renderLoadAndReps(set: StoredSet): string {
  const reps = repCount(set);
  const load = describeLoad(set);
  return load === '—' ? `${reps} reps` : `${load} x ${reps}`;
}

/**
 * `missed: 2 of 3 sets below 8 reps`, or nothing when no plan was attached or
 * every working set made the band's floor.
 */
function renderMissedLine(
  working: StoredSet[],
  planned: StoredPlannedExercise | undefined,
): string | undefined {
  const low = planned?.targetRepsLow;
  const missed = countMissed(working.map(repCount), low);
  if (missed === undefined || missed === 0) return undefined;
  return `missed: ${missed} of ${working.length} ${pluralSets(working.length)} below ${low} reps`;
}

/**
 * The rep bands this session was judged against, keyed by exercise. Both
 * assignment shapes `plan.*` writes are read: a whole template (the
 * `plan.complete_workout` / `plan.attach_to_session` template form) and a
 * single planned exercise.
 */
async function loadPlannedExercises(
  state: ServerState,
  sessionId: string,
): Promise<Map<string, StoredPlannedExercise>> {
  const assignments = await state.store.getAssignmentsForSession(sessionId);
  const rows = await Promise.all(assignments.map((a) => plannedExercisesFor(state, a)));
  return new Map(rows.flat().map((planned) => [planned.exerciseId, planned]));
}

async function plannedExercisesFor(
  state: ServerState,
  assignment: { plannedExerciseId?: string; workoutTemplateId?: string },
): Promise<StoredPlannedExercise[]> {
  if (assignment.workoutTemplateId !== undefined) {
    return await state.store.getPlannedExercisesForTemplate(assignment.workoutTemplateId);
  }
  if (assignment.plannedExerciseId === undefined) return [];
  const one = await state.store.getPlannedExercise(assignment.plannedExerciseId);
  return one === undefined ? [] : [one];
}

function pluralSets(count: number): string {
  return count === 1 ? 'set' : 'sets';
}

/**
 * The calendar date the lifter would call this workout, not the UTC one. A
 * 9pm session ends after midnight UTC, and logging it against the next day
 * puts it on the wrong row of the coach's week.
 */
function localDate(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// `report.weekly` — coach-readable weekly summary (w3-91).
//
// Everything below builds ONE data tree (`WeeklyReport`) and renders it two
// ways (`renderWeeklyMarkdown`, or the tree itself as JSON) so the two formats
// can never disagree about a number.
// ---------------------------------------------------------------------------

export const REPORT_WEEKLY_DESCRIPTION =
  'Coach-readable weekly summary over a date range (default: the last 7 days), in markdown ' +
  '(default) or JSON — both render from the same data tree, so the numbers always agree. ' +
  'Sections, each omitted when empty: a header (lifter, range, sessions completed, a rolling ' +
  '28-day completed-session count — never a streak — and adherence `planned N / done M` against ' +
  "the active program's touched week(s), plus a coarse trend vs the previous equal-length range); " +
  'one block per session (date, template name, the same `report.session_results` strings verbatim, ' +
  'plus an RIR line only when the rir-estimate baseline gate allows it — labelled `fitted` when ' +
  'the lifter has a fitted RIR-velocity curve (VW-298) for the exercise, or `general model, not ' +
  'a proximity-to-failure read` with no such curve (VW-310): Jukic et al. 2023, Eur J Appl ' +
  'Physiol, found velocity-loss-to-RIR agreement unacceptable at every load); one progression-suggestion ' +
  'line per exercise from the same heuristic `plan.suggest_progression` uses, labelled "suggestion ' +
  'for the coach, not applied"; flags (force-implied weight/header mismatches, sets closed by an ' +
  'inactivity timeout with reps recorded, and velocity-loss holds at the VL30 stop point — ' +
  '`setting_coerced` is never included: it is a live-only signal with no persisted record, so ' +
  'there is nothing to read back after the session ends); and a check-in section built from ' +
  'recorded self-reports, falling back to the `notes` input as a lifter note when none exist. ' +
  'Read-only and local: no network call, and it writes nothing.';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_DAYS = 28;
const DEFAULT_RANGE_DAYS = 7;
/** Generous ceiling for one report's worth of sessions; `listSessions` defaults to 50. */
const MAX_SESSIONS_IN_RANGE = 500;
/** `self_reports.question_code` for "this muscle felt off" (extension 3). */
const OFF_QUESTION_CODE = 'off';
/**
 * VL30 — the autoregulation "stop" band, identical to the 20/30 split used
 * throughout this codebase (`toAutoRegStatus` in the dashboard SPA, the
 * `velocity_loss_exceeded` trigger docs). `@voltras/workout-analytics` now
 * publishes an equivalent `velocityLossVerdict`, but adopting it in place of
 * this hand-rolled threshold is an open wiring decision (VW-64) elsewhere in
 * the codebase, not something this report should preempt.
 */
const VELOCITY_LOSS_STOP_PCT = 30;

export interface WeeklyAdherence {
  planned: number;
  done: number;
  trend: 'improving' | 'declining' | 'steady' | 'no-prior-data';
}

export interface WeeklyReportHeader {
  lifter: string | null;
  from: string;
  to: string;
  sessionsCompleted: number;
  rolling28DayCompletedSessions: number;
  adherence: WeeklyAdherence | null;
}

export interface WeeklySessionExercise {
  exerciseId: string;
  exerciseName: string;
  result: string;
  rir: string | null;
}

export interface WeeklySessionEntry {
  sessionId: string;
  date: string;
  templateName: string | null;
  exercises: WeeklySessionExercise[];
}

export interface WeeklyProgressionLine {
  exerciseId: string;
  exerciseName: string;
  delta: number;
  repDelta: number;
  gates: ProgressionGates;
  tier: Tier;
  text: string;
}

export interface WeeklyFlagSet {
  setId: string;
  sessionId: string;
  exerciseId: string | null;
}

/**
 * `settingCoerced` is always `null`, never an empty array: it is a live
 * comparison between a tool call's requested value and the device's async
 * echo (`state/coercion-watch.ts`), never persisted on a set, so there is
 * nothing to read back after the fact. `null` says "not measurable" so a
 * caller can tell that apart from "measured, found none" (an empty array).
 * The other three flags are all recomputed from durable `StoredSet`
 * fields/reps, which is why they can appear in a report generated after the
 * session ended.
 */
export interface WeeklyFlags {
  weightImpliedMismatch: (WeeklyFlagSet & { ratio: number })[];
  inactivityTimeout: (WeeklyFlagSet & { reps: number })[];
  velocityLossHold: (WeeklyFlagSet & { lossPct: number })[];
  settingCoerced: null;
}

export interface WeeklyCheckInEntry {
  recordedAt: string;
  muscleGroup: string | null;
  questionCode: string | null;
  valueText: string | null;
  valueNum: number | null;
}

export interface WeeklyCheckIn {
  source: 'self_reports' | 'notes';
  entries: WeeklyCheckInEntry[];
  /** Exact-text clustering of `value_text` (extension 3) — grouped, not summarized. */
  themes: { text: string; count: number }[];
  /** `muscle_group`s named more than once against the `'off'` question code (extension 3). */
  repeatedOffMuscleGroups: string[];
  notes: string | null;
}

export interface WeeklyReport {
  header: WeeklyReportHeader;
  sessions: WeeklySessionEntry[];
  progression: WeeklyProgressionLine[];
  flags: WeeklyFlags;
  checkIn: WeeklyCheckIn | null;
}

export async function buildWeeklyReport(
  state: ServerState,
  input: z.infer<typeof ReportWeeklyInput>,
): Promise<WeeklyReport> {
  const to = input.to ?? new Date().toISOString();
  const from =
    input.from ?? new Date(new Date(to).getTime() - DEFAULT_RANGE_DAYS * DAY_MS).toISOString();

  const sessions = await state.store.listSessions({
    from,
    to,
    sort: 'startedAt:asc',
    limit: MAX_SESSIONS_IN_RANGE,
    ...(input.lifter !== undefined ? { lifter: input.lifter } : {}),
  });
  const endedSessions = sessions.filter(
    (s): s is StoredSession & { endedAt: string } => s.endedAt !== undefined,
  );

  const sessionEntries: WeeklySessionEntry[] = [];
  for (const session of endedSessions) {
    sessionEntries.push(await buildWeeklySessionEntry(state, session));
  }

  return {
    header: {
      lifter: input.lifter ?? null,
      from,
      to,
      sessionsCompleted: endedSessions.length,
      rolling28DayCompletedSessions: await countCompletedSessionsInWindow(state, input.lifter, to),
      adherence: await computeAdherenceWithTrend(state, input.lifter, from, to, sessions),
    },
    sessions: sessionEntries,
    progression: await buildProgressionLines(state, endedSessions),
    flags: await buildFlags(state, endedSessions),
    checkIn: await buildCheckIn(state, input, from, to),
  };
}

async function buildWeeklyReportResult(
  state: ServerState,
  input: z.infer<typeof ReportWeeklyInput>,
): Promise<{ format: 'markdown'; markdown: string } | { format: 'json'; report: WeeklyReport }> {
  const report = await buildWeeklyReport(state, input);
  return input.format === 'json'
    ? { format: 'json', report }
    : { format: 'markdown', markdown: renderWeeklyMarkdown(report) };
}

async function buildWeeklySessionEntry(
  state: ServerState,
  session: StoredSession,
): Promise<WeeklySessionEntry> {
  const results = await buildSessionResults(state, session.id);
  const sets = reportableSets(
    await state.store.getSetsForSession(session.id),
    state.config.adapter,
  );
  const byExercise = groupByExercise(sets, session);
  const exercises: WeeklySessionExercise[] = [];
  for (const result of results.exercises) {
    exercises.push({
      ...result,
      rir: await rirLineForExercise(state, byExercise.get(result.exerciseId) ?? []),
    });
  }
  return {
    sessionId: session.id,
    date: results.date,
    templateName: await resolveTemplateName(state, session.id),
    exercises,
  };
}

async function resolveTemplateName(state: ServerState, sessionId: string): Promise<string | null> {
  const assignments = await state.store.getAssignmentsForSession(sessionId);
  const templateId = assignments.find((a) => a.workoutTemplateId !== undefined)?.workoutTemplateId;
  if (templateId === undefined) return null;
  const template = await state.store.getWorkoutTemplate(templateId);
  return template?.name ?? null;
}

/**
 * RIR for the exercise's last working set, final rep — the same estimator
 * `metrics.compute`'s `rir` pipeline runs (`estimateRepRir` +
 * `selectEligibleReps` for the baseline), gated the same way (`rir-estimate`
 * feature gate). Composed here rather than imported because the gating
 * composition itself is private to `metrics-tools.ts`; the primitives it
 * composes are not.
 *
 * Prefers the lifter's own fitted RIR-velocity curve (VW-298) when one exists
 * for this exercise; the label says which basis answered (VW-310), because a
 * general-model reading is NOT a proximity-to-failure claim (Jukic et al.
 * 2023, Eur J Appl Physiol — VL-to-RIR agreement unacceptable at every load).
 *
 * Returns `null` (line omitted) when there is no working set, no exercise, the
 * gate is withheld, or there is no velocity telemetry to estimate from.
 */
async function rirLineForExercise(state: ServerState, sets: StoredSet[]): Promise<string | null> {
  const working = selectWorkingSets(sets);
  const set = working[working.length - 1];
  if (set === undefined || set.exerciseId === undefined) return null;
  const gate = await checkFeatureGate(
    state.store,
    {
      userId: LOCAL_USER_ID,
      exerciseId: set.exerciseId,
      ...(set.side !== undefined ? { side: set.side } : {}),
    },
    'rir-estimate',
  );
  if (gate.activation === 'withheld') return null;

  const reps = normaliseVelocityToMps(set).reps;
  if (reps.length === 0) return null;
  const eligible = selectEligibleReps(reps);
  const baselineMax = Math.max(...eligible.map((rep) => getRepPeakVelocity(rep)));
  if (!(baselineMax > 0)) return null;
  const finalPeak = getRepPeakVelocity(reps[reps.length - 1]!);
  const velLossPct = Math.max(0, ((baselineMax - finalPeak) / baselineMax) * 100);
  const stored = await state.store.getRirVelocityModel(LOCAL_USER_ID, set.exerciseId);
  const model = stored === undefined ? undefined : (stored.model as unknown as RirVelocityModel);
  const estimateInput = {
    peakVelocity: finalPeak,
    baselineMaxVelocity: baselineMax,
    velLossPct,
    repIndex: reps.length,
    repsInSet: reps.length,
  };
  const estimate = estimateRepRir(model, estimateInput);
  const basisLabel =
    estimate.basis === 'fitted' ? 'fitted' : 'general model, not a proximity-to-failure read';
  return `RIR (final rep, ${basisLabel}): ${estimate.rir.toFixed(1)}`;
}

async function buildProgressionLines(
  state: ServerState,
  endedSessions: (StoredSession & { endedAt: string })[],
): Promise<WeeklyProgressionLine[]> {
  let program: StoredTrainingProgram;
  try {
    program = await resolveDefaultProgram(state, undefined);
  } catch {
    return [];
  }
  const tierSignal = await getTierSignal(state);

  // The last (most recent, by `startedAt`) session in range that trained each
  // exercise is that exercise's progression basis for this report.
  const basisByExercise = new Map<string, { sessionId: string; sets: StoredSet[] }>();
  for (const session of endedSessions) {
    const sets = reportableSets(
      await state.store.getSetsForSession(session.id),
      state.config.adapter,
    );
    for (const [exerciseId, exerciseSets] of groupByExercise(sets, session)) {
      basisByExercise.set(exerciseId, { sessionId: session.id, sets: exerciseSets });
    }
  }

  const lines: WeeklyProgressionLine[] = [];
  for (const [exerciseId, basis] of basisByExercise) {
    const planned = await findPlannedExerciseInProgram(state, program.id, exerciseId);
    if (planned === undefined) continue;
    const suggestion = computeProgressionDelta(planned, basis.sets, basis.sessionId, {
      tier: tierSignal.tier,
    });
    const exerciseName = state.exercises.getById(exerciseId)?.name ?? exerciseId;
    lines.push({
      exerciseId,
      exerciseName,
      delta: suggestion.delta,
      repDelta: suggestion.repDelta,
      gates: suggestion.gates,
      tier: tierSignal.tier,
      text: formatProgressionLine(exerciseName, suggestion, tierSignal.tier),
    });
  }
  return lines;
}

function formatProgressionLine(
  exerciseName: string,
  suggestion: ProgressionSuggestion,
  tier: Tier,
): string {
  const deltaSign = suggestion.delta > 0 ? '+' : '';
  const parts = [`${exerciseName}: ${deltaSign}${suggestion.delta} lb`];
  if (suggestion.repDelta !== 0) {
    const repSign = suggestion.repDelta > 0 ? '+' : '';
    parts.push(`${repSign}${suggestion.repDelta} reps`);
  }
  parts.push('(suggestion for the coach, not applied)');
  parts.push(
    `gates: technique=${suggestion.gates.technique}, effort=${suggestion.gates.effort}, ` +
      `setsUnlocked=${String(suggestion.gates.setsUnlocked)}`,
  );
  parts.push(`tier: ${tier}`);
  return parts.join(' - ');
}

/**
 * Walk a program's blocks -> weeks -> templates for the first planned row
 * naming `exerciseId`. Mirrors `findPlannedExerciseInProgram` in
 * `plan-tools.ts` (private there) over the same public store methods.
 */
async function findPlannedExerciseInProgram(
  state: ServerState,
  programId: string,
  exerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  for (const block of await state.store.getTrainingBlocksForProgram(programId)) {
    for (const week of await state.store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await state.store.getWorkoutTemplatesForWeek(week.id)) {
        const planned = await state.store.getPlannedExercisesForTemplate(template.id);
        const match = planned.find((p) => p.exerciseId === exerciseId);
        if (match !== undefined) return match;
      }
    }
  }
  return undefined;
}

async function buildFlags(
  state: ServerState,
  endedSessions: (StoredSession & { endedAt: string })[],
): Promise<WeeklyFlags> {
  const flags: WeeklyFlags = {
    weightImpliedMismatch: [],
    inactivityTimeout: [],
    velocityLossHold: [],
    settingCoerced: null,
  };
  for (const session of endedSessions) {
    const sets = reportableSets(
      await state.store.getSetsForSession(session.id),
      state.config.adapter,
    );
    for (const set of sets) {
      const exerciseId = set.exerciseId ?? session.exerciseId ?? null;
      const ref: WeeklyFlagSet = { setId: set.id, sessionId: session.id, exerciseId };

      if (set.partialReason === 'inactivity_timeout' && repCount(set) > 0) {
        flags.inactivityTimeout.push({ ...ref, reps: repCount(set) });
      }

      if (set.weightLbs !== undefined) {
        const implied = evaluateWeightImplied(set.weightLbs, normaliseVelocityToMps(set).reps);
        if (implied?.flagged === true) {
          flags.weightImpliedMismatch.push({ ...ref, ratio: implied.ratio });
        }
      }

      // Ratio consumer: deliberately NOT routed through `normaliseVelocityToMps`
      // first (matches `setVelocityLossPct` in `plan-tools.ts`) — both terms of
      // the loss percentage come from the same set, so a `device_native` row
      // already yields the right ratio.
      const lossPct = getSetVelocitySummary({ reps: set.reps }).lossPct;
      if (lossPct !== null && lossPct !== undefined && lossPct >= VELOCITY_LOSS_STOP_PCT) {
        flags.velocityLossHold.push({ ...ref, lossPct });
      }
    }
  }
  return flags;
}

async function buildCheckIn(
  state: ServerState,
  input: z.infer<typeof ReportWeeklyInput>,
  from: string,
  to: string,
): Promise<WeeklyCheckIn | null> {
  const rows = await state.store.getSelfReportsForUser({ userId: LOCAL_USER_ID, from, to });
  if (rows.length === 0) {
    return input.notes === undefined
      ? null
      : {
          source: 'notes',
          entries: [],
          themes: [],
          repeatedOffMuscleGroups: [],
          notes: input.notes,
        };
  }
  return {
    source: 'self_reports',
    entries: rows.map((r) => ({
      recordedAt: r.recordedAt,
      muscleGroup: r.muscleGroup ?? null,
      questionCode: r.questionCode ?? null,
      valueText: r.valueText ?? null,
      valueNum: r.valueNum ?? null,
    })),
    themes: clusterThemes(rows),
    repeatedOffMuscleGroups: repeatedOffCodeMuscleGroups(rows),
    notes: null,
  };
}

/** Exact-text clustering (case/whitespace-insensitive), most frequent first. Not semantic NLP. */
function clusterThemes(rows: StoredSelfReport[]): { text: string; count: number }[] {
  const counts = new Map<string, { text: string; count: number }>();
  for (const row of rows) {
    const text = row.valueText?.trim();
    if (text === undefined || text.length === 0) continue;
    const key = text.toLowerCase();
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { text, count: 1 });
    else existing.count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function repeatedOffCodeMuscleGroups(rows: StoredSelfReport[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.questionCode !== OFF_QUESTION_CODE || row.muscleGroup === undefined) continue;
    counts.set(row.muscleGroup, (counts.get(row.muscleGroup) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([group]) => group);
}

async function countCompletedSessionsInWindow(
  state: ServerState,
  lifter: string | undefined,
  to: string,
): Promise<number> {
  const from = new Date(new Date(to).getTime() - ROLLING_WINDOW_DAYS * DAY_MS).toISOString();
  return state.store.countSessions({
    from,
    to,
    endedOnly: true,
    ...(lifter !== undefined ? { lifter } : {}),
  });
}

interface AdherenceCount {
  planned: number;
  done: number;
}

async function computeAdherenceWithTrend(
  state: ServerState,
  lifter: string | undefined,
  from: string,
  to: string,
  sessions: StoredSession[],
): Promise<WeeklyAdherence | null> {
  const current = await computeAdherenceCount(state, sessions);
  if (current === null) return null;

  const rangeMs = new Date(to).getTime() - new Date(from).getTime();
  const previousFrom = new Date(new Date(from).getTime() - rangeMs).toISOString();
  const previousSessions = await state.store.listSessions({
    from: previousFrom,
    to: from,
    sort: 'startedAt:asc',
    limit: MAX_SESSIONS_IN_RANGE,
    ...(lifter !== undefined ? { lifter } : {}),
  });
  const previous = await computeAdherenceCount(state, previousSessions);

  return { ...current, trend: adherenceTrend(current, previous) };
}

/**
 * `planned` is every distinct workout template belonging to a week touched by
 * an assignment in `sessions`; `done` is however many of those templates got
 * an ENDED session attached, regardless of which calendar day that session
 * fell on.
 *
 * Extension 1 (a session on a template's named fallback day still counts as
 * completed): this design never matches on day-of-week in the first place —
 * "done" is assignment + completion, not a date comparison — so a fallback-day
 * session already counts as done with no new field. No `fallbackDayLabel` (or
 * similar) was added to `StoredWorkoutTemplate` because this adherence model
 * structurally has no "missed the exact day" failure mode to guard against.
 *
 * Returns `null` (adherence section omitted) when nothing in `sessions` was
 * ever assigned a template — there is no plan to measure adherence against.
 */
async function computeAdherenceCount(
  state: ServerState,
  sessions: StoredSession[],
): Promise<AdherenceCount | null> {
  const weekIds = new Set<string>();
  const templateBySession = new Map<string, string>();
  for (const session of sessions) {
    const assignments = await state.store.getAssignmentsForSession(session.id);
    const templateId = assignments.find(
      (a) => a.workoutTemplateId !== undefined,
    )?.workoutTemplateId;
    if (templateId === undefined) continue;
    templateBySession.set(session.id, templateId);
    const template = await state.store.getWorkoutTemplate(templateId);
    if (template !== undefined) weekIds.add(template.weekId);
  }
  if (weekIds.size === 0) return null;

  const planned = new Set<string>();
  for (const weekId of weekIds) {
    for (const template of await state.store.getWorkoutTemplatesForWeek(weekId)) {
      planned.add(template.id);
    }
  }
  const done = new Set<string>();
  for (const session of sessions) {
    if (session.endedAt === undefined) continue;
    const templateId = templateBySession.get(session.id);
    if (templateId !== undefined && planned.has(templateId)) done.add(templateId);
  }
  return { planned: planned.size, done: done.size };
}

function adherenceTrend(
  current: AdherenceCount,
  previous: AdherenceCount | null,
): WeeklyAdherence['trend'] {
  if (previous === null || previous.planned === 0) return 'no-prior-data';
  const currentRatio = current.planned === 0 ? 0 : current.done / current.planned;
  const previousRatio = previous.done / previous.planned;
  if (currentRatio > previousRatio) return 'improving';
  if (currentRatio < previousRatio) return 'declining';
  return 'steady';
}

/**
 * Renders `report`. No tables (the paste-safety rule caps table width at 4
 * columns; headings + lists sidestep the question entirely), no HTML, no
 * emoji — plain text and Markdown headings/lists only.
 */
export function renderWeeklyMarkdown(report: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`# Weekly Report${report.header.lifter !== null ? ` - ${report.header.lifter}` : ''}`);
  lines.push(`Range: ${report.header.from} to ${report.header.to}`);
  lines.push('');
  lines.push(`Sessions completed: ${report.header.sessionsCompleted}`);
  lines.push(`Last 28 days: ${report.header.rolling28DayCompletedSessions} sessions completed`);
  if (report.header.adherence !== null) {
    const a = report.header.adherence;
    lines.push(`Adherence: planned ${a.planned} / done ${a.done} (trend: ${a.trend})`);
  }

  if (report.sessions.length > 0) {
    lines.push('', '## Sessions');
    for (const session of report.sessions) {
      lines.push(
        '',
        `### ${session.date}${session.templateName !== null ? ` - ${session.templateName}` : ''}`,
      );
      for (const exercise of session.exercises) {
        lines.push(exercise.exerciseName, exercise.result);
        if (exercise.rir !== null) lines.push(exercise.rir);
      }
    }
  }

  if (report.progression.length > 0) {
    lines.push('', '## Progression suggestions');
    for (const line of report.progression) lines.push(`- ${line.text}`);
  }

  const flagLines = renderFlagLines(report.flags);
  if (flagLines.length > 0) lines.push('', '## Flags', ...flagLines);

  if (report.checkIn !== null) lines.push('', '## Check-in', ...renderCheckInLines(report.checkIn));

  return lines.join('\n');
}

function renderFlagLines(flags: WeeklyFlags): string[] {
  // `settingCoerced` renders unconditionally (it is always `null`, never
  // an empty array) — a caller must be able to tell "checked, found none"
  // apart from "not measurable at all".
  const lines: string[] = [];
  if (flags.settingCoerced === null) {
    lines.push('- setting_coerced: not persisted; live-only signal');
  }
  if (flags.weightImpliedMismatch.length > 0) {
    const ids = flags.weightImpliedMismatch.map((f) => f.setId).join(', ');
    lines.push(`- weight_implied_mismatch: ${flags.weightImpliedMismatch.length} set(s) (${ids})`);
  }
  if (flags.inactivityTimeout.length > 0) {
    const ids = flags.inactivityTimeout.map((f) => f.setId).join(', ');
    lines.push(
      `- inactivity_timeout with reps recorded: ${flags.inactivityTimeout.length} set(s) (${ids})`,
    );
  }
  if (flags.velocityLossHold.length > 0) {
    const ids = flags.velocityLossHold.map((f) => f.setId).join(', ');
    lines.push(`- velocity-loss holds: ${flags.velocityLossHold.length} set(s) (${ids})`);
  }
  return lines;
}

function renderCheckInLines(checkIn: WeeklyCheckIn): string[] {
  if (checkIn.source === 'notes') return [checkIn.notes ?? ''];
  const lines: string[] = [];
  for (const entry of checkIn.entries) {
    const label = [entry.muscleGroup, entry.questionCode].filter((v): v is string => v !== null);
    const value = entry.valueText ?? (entry.valueNum !== null ? String(entry.valueNum) : '');
    lines.push(`- ${entry.recordedAt}${label.length > 0 ? ` (${label.join(' ')})` : ''}: ${value}`);
  }
  if (checkIn.themes.length > 0) {
    lines.push('Themes:');
    for (const theme of checkIn.themes) lines.push(`- ${theme.text} (${theme.count})`);
  }
  if (checkIn.repeatedOffMuscleGroups.length > 0) {
    lines.push(`Repeated 'off' muscle groups: ${checkIn.repeatedOffMuscleGroups.join(', ')}`);
  }
  return lines;
}
