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

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { ReportSessionResultsInput } from '../schemas/report.js';
import type { ServerState } from '../state/server-state.js';
import { scopeSetsToLifter } from '../store/set-scope.js';
import { isWarmupSet, selectWorkingSets } from '../store/working-sets.js';
import type { StoredPlannedExercise, StoredSession, StoredSet } from '../store/types.js';
import { wrapHandler } from './helpers.js';

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

/** `170 lb x 12`, or a bare `12 reps` for a set that recorded no load. */
function renderLoadAndReps(set: StoredSet): string {
  const reps = repCount(set);
  if (set.weightLbs === undefined) return `${reps} reps`;
  return `${formatLoad(set.weightLbs)} lb x ${reps}`;
}

/** Whole loads render whole; a half-pound step keeps its decimal. */
function formatLoad(lbs: number): string {
  return Number.isInteger(lbs) ? String(lbs) : String(Number(lbs.toFixed(1)));
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
  if (low === undefined) return undefined;
  const missed = working.filter((set) => repCount(set) < low).length;
  if (missed === 0) return undefined;
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
