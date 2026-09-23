// Stage 3 (VW-516, design s.10.4): run the production rules over the lifter's
// OWN recorded sets and report how much evidence they would actually find.
//
// SAFETY, and it is the whole design of this file:
//
//   * It opens a plain FILE COPY of the store, never the live file. The copy is
//     made by the caller into a gitignored scratch directory and deleted after.
//   * It opens that copy READ-ONLY, with `node:sqlite` directly rather than
//     through `SessionStore`, so nothing can migrate it. The live store is on
//     an older schema than this checkout and opening it through the store would
//     rewrite it.
//   * It emits COUNTS ONLY. No load, no velocity, no date, no exercise name or
//     id, no per-key figure. Everything returned is an aggregate over the whole
//     corpus, because a count cannot leak a training history and a per-exercise
//     row can.
//
// It imports the production functions and re-implements none of them.

import { DatabaseSync } from 'node:sqlite';

import {
  ADAPTIVE_REST_POLICY,
  arrivals,
  evaluateExerciseDay,
  nextState,
  pairsForExerciseDay,
  signalForIntent,
  sortPair,
  stepDirections,
  type EvidencePair,
  type LearnedRestState,
  type RestSetInput,
  type RestStep,
  type StepDecision,
  type StepDirection,
} from '../../src/analytics/adaptive-rest.js';
import { setPurposeOf } from '../../src/store/set-purpose.js';
import type { Rep } from '@voltras/workout-analytics';

/** Everything the replay reports. Counts only, by construction. */
export interface ReplayCounts {
  readonly schemaVersion: number;
  readonly setsInStore: number;
  readonly setsUsable: number;
  readonly exerciseKeys: number;
  /**
   * Why a set never became a pair candidate, counted over the whole corpus.
   * A bare zero for "valid pairs" is unreadable without this.
   */
  readonly setsExcluded: Readonly<Record<string, number>>;
  readonly keysWithEnoughHistory: number;
  readonly exerciseDaysEvaluated: number;
  readonly candidatePairs: number;
  readonly validPairs: number;
  readonly rejectedPairs: Readonly<Record<string, number>>;
  readonly pairsByVerdict: Readonly<Record<string, number>>;
  readonly pairsInWindow: number;
  readonly pairsOutOfWindow: number;
  readonly decisions: Readonly<Record<string, number>>;
  readonly stepsByDirection: Readonly<Record<StepDirection, number>>;
  readonly keysReachingAnArrival: number;
  readonly keysReadingLearned: number;
  readonly policyVersion: string;
  /** True when the corpus is too thin for any of the above to mean anything. */
  readonly tooThinToJudge: boolean;
}

interface SetRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly exercise_id: string | null;
  readonly started_at: string;
  readonly ended_at: string;
  readonly weight_lbs: number | null;
  readonly set_purpose: string | null;
  readonly slot: string | null;
  readonly lifter: string | null;
  readonly kind: string | null;
  readonly source: string | null;
  readonly training_mode: string | null;
  readonly chains_lbs: number | null;
  readonly eccentric_pct: number | null;
  readonly damper_level: number | null;
}

/** A set is constant-load only when nothing was layered on top of the weight. */
function isConstantLoad(row: SetRow): boolean {
  const mode = (row.training_mode ?? '').toLowerCase();
  if (mode.includes('isokinetic') || mode.includes('damper')) return false;
  return !(row.chains_lbs ?? 0) && !(row.eccentric_pct ?? 0) && !(row.damper_level ?? 0);
}

const MIN_DAYS_FOR_HISTORY = ADAPTIVE_REST_POLICY.learnedMinDaysEvaluated.value;

function toSetInput(row: SetRow, reps: readonly Rep[]): RestSetInput {
  return {
    id: row.id,
    exerciseId: row.exercise_id ?? 'unknown',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    reps,
    ...(row.weight_lbs !== null ? { weightLbs: row.weight_lbs } : {}),
    ...(row.set_purpose !== null
      ? { setPurpose: row.set_purpose as NonNullable<RestSetInput['setPurpose']> }
      : {}),
    ...(row.slot !== null ? { slot: row.slot } : {}),
    ...(row.lifter !== null ? { lifter: row.lifter } : {}),
    ...(row.kind !== null ? { kind: row.kind as NonNullable<RestSetInput['kind']> } : {}),
    ...(row.source !== null ? { source: row.source as NonNullable<RestSetInput['source']> } : {}),
    constantLoad: isConstantLoad(row),
    velocitySignalValid: reps.length > 0,
  };
}

/**
 * Why this set can never be half of a pair, or `null` when it can.
 *
 * Ordered so the first answer is the most informative one: an unreviewed row is
 * excluded by VW-489 whatever else is true of it, and on a store where nothing
 * has been marked that is the ONLY thing worth reporting.
 */
function exclusionReason(set: RestSetInput): string | null {
  if (set.kind === undefined) return 'unreviewed';
  if (set.kind !== 'training') return 'test_session';
  if (set.lifter !== undefined) return 'guest';
  if (set.source === 'mock') return 'mock';
  if (setPurposeOf(set) !== 'working') return 'not_working';
  if (set.reps.length === 0) return 'no_reps';
  if (!set.constantLoad) return 'not_constant_load';
  return null;
}

/** The local date of an instant, which is how an exercise-day is keyed. */
function localDateOf(instant: string): string {
  return new Date(instant).toISOString().slice(0, 10);
}

interface KeyState {
  valueSec: number;
  state: LearnedRestState;
  history: RestStep[];
  evidence: EvidencePair[];
  pendingDirection: StepDirection | null;
  daysEvaluated: number;
  informativePairs: number;
  runStartedOn: string;
  learnedOn?: string;
}

/** Read every set the replay may look at, newest last, with its reps. */
function readSets(db: DatabaseSync): { rows: SetRow[]; reps: Map<string, Rep[]> } {
  const rows = db
    .prepare(
      `SELECT id, user_id, exercise_id, started_at, ended_at, weight_lbs, set_purpose, slot,
              lifter, kind, source, training_mode, chains_lbs, eccentric_pct, damper_level
         FROM sets ORDER BY started_at ASC`,
    )
    .all() as unknown as SetRow[];
  const reps = new Map<string, Rep[]>();
  const repRows = db
    .prepare(`SELECT set_id, payload FROM reps ORDER BY set_id, rep_index ASC`)
    .all() as unknown as { set_id: string; payload: string }[];
  for (const rep of repRows) {
    const list = reps.get(rep.set_id) ?? [];
    list.push(JSON.parse(rep.payload) as Rep);
    reps.set(rep.set_id, list);
  }
  return { rows, reps };
}

/** Group the day's sets by exercise key and local date. */
function groupByKeyAndDay(inputs: readonly RestSetInput[]): Map<string, RestSetInput[]> {
  const days = new Map<string, RestSetInput[]>();
  for (const set of inputs) {
    const key = `${set.exerciseId}\u0000${localDateOf(set.startedAt)}`;
    days.set(key, [...(days.get(key) ?? []), set]);
  }
  return days;
}

interface Totals {
  candidatePairs: number;
  validPairs: number;
  rejected: Record<string, number>;
  verdicts: Record<string, number>;
  inWindow: number;
  outOfWindow: number;
  decisions: Record<string, number>;
  steps: Record<StepDirection, number>;
  daysEvaluated: number;
}

function newTotals(): Totals {
  return {
    candidatePairs: 0,
    validPairs: 0,
    rejected: {},
    verdicts: {},
    inWindow: 0,
    outOfWindow: 0,
    decisions: {},
    steps: { down: 0, up: 0 },
    daysEvaluated: 0,
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** Judge one exercise-day for one key, folding its counts into `totals`. */
function replayDay(
  state: KeyState,
  exerciseId: string,
  on: string,
  daySets: readonly RestSetInput[],
  totals: Totals,
): void {
  const { valid, rejected } = pairsForExerciseDay({ exerciseId, daySets });
  totals.candidatePairs += valid.length + rejected.length;
  totals.validPairs += valid.length;
  for (const pair of rejected) bump(totals.rejected, pair.reason);
  for (const pair of valid) {
    const sort = sortPair(pair, state.valueSec, signalForIntent('none'));
    bump(totals.verdicts, sort.verdict);
    if (sort.r === null) continue;
    if (sort.inWindow) totals.inWindow += 1;
    else totals.outOfWindow += 1;
    state.evidence.push({
      on,
      r: sort.r,
      weight: sort.weight,
      verdict: sort.verdict,
      inWindow: sort.inWindow,
    });
    if (sort.informative) state.informativePairs += 1;
  }
  applyDay(state, on, totals);
}

function applyDay(state: KeyState, on: string, totals: Totals): void {
  const evaluation = evaluateExerciseDay({
    on,
    valueSec: state.valueSec,
    state: state.state,
    signal: signalForIntent('none'),
    runStartedOn: state.runStartedOn,
    pendingDirection: state.pendingDirection,
    evidence: state.evidence,
    ignoredPairs: { rushed: 0, long: 0, invalid: 0 },
  });
  const { step } = evaluation;
  state.history.push(step);
  state.valueSec = step.toSec;
  state.pendingDirection = evaluation.pendingDirection;
  state.daysEvaluated += 1;
  totals.daysEvaluated += 1;
  bump(totals.decisions, step.decision);
  if (step.decision === 'down' || step.decision === 'up') totals.steps[step.decision] += 1;
  if (evaluation.clearsWindow) state.evidence = [];
  const wasLearned = state.state === 'learned';
  state.state = nextState({
    current: state.state,
    daysEvaluated: state.daysEvaluated,
    informativePairs: state.informativePairs,
    arrivals: arrivals(state.history),
    stepsSinceLearned: stepDirections(state.history, state.learnedOn ?? on),
  });
  if (!wasLearned && state.state === 'learned') state.learnedOn = on;
}

const SEED_SEC = 120;

/**
 * Replay the staircase over a COPY of the store and report counts.
 *
 * `dbPath` must be a copy. This never writes, and opens read-only so it cannot.
 */
export function replayStore(dbPath: string): ReplayCounts {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const version = (db.prepare('PRAGMA user_version').get() ?? {}) as { user_version?: number };
    const { rows, reps } = readSets(db);
    const inputs = rows.map((row) => toSetInput(row, reps.get(row.id) ?? []));
    return countOver(inputs, rows.length, version.user_version ?? 0);
  } finally {
    db.close();
  }
}

function countOver(
  inputs: readonly RestSetInput[],
  setsInStore: number,
  schemaVersion: number,
): ReplayCounts {
  const totals = newTotals();
  const excluded: Record<string, number> = {};
  for (const set of inputs) {
    const reason = exclusionReason(set);
    if (reason !== null) bump(excluded, reason);
  }
  const days = groupByKeyAndDay(inputs);
  const states = new Map<string, KeyState>();
  const daysPerKey = new Map<string, number>();
  for (const key of [...days.keys()].sort()) {
    const [exerciseId, on] = key.split('\u0000');
    const daySets = days.get(key) ?? [];
    const state = states.get(exerciseId) ?? newKeyState(on);
    states.set(exerciseId, state);
    daysPerKey.set(exerciseId, (daysPerKey.get(exerciseId) ?? 0) + 1);
    replayDay(state, exerciseId, on, daySets, totals);
  }
  return summarise({ totals, states, daysPerKey, inputs, setsInStore, schemaVersion, excluded });
}

function newKeyState(on: string): KeyState {
  return {
    valueSec: SEED_SEC,
    state: 'calibrating',
    history: [],
    evidence: [],
    pendingDirection: null,
    daysEvaluated: 0,
    informativePairs: 0,
    runStartedOn: on,
  };
}

/** Too thin to judge: no key ever had enough exercise-days to evaluate. */
const MIN_VALID_PAIRS_TO_JUDGE = 10;

interface SummaryInput {
  readonly totals: Totals;
  readonly states: Map<string, KeyState>;
  readonly daysPerKey: Map<string, number>;
  readonly inputs: readonly RestSetInput[];
  readonly setsInStore: number;
  readonly schemaVersion: number;
  readonly excluded: Record<string, number>;
}

function summarise(input: SummaryInput): ReplayCounts {
  const { totals, states, daysPerKey, inputs, setsInStore, schemaVersion, excluded } = input;
  const withHistory = [...daysPerKey.values()].filter((n) => n >= MIN_DAYS_FOR_HISTORY).length;
  const all = [...states.values()];
  return {
    schemaVersion,
    setsInStore,
    setsExcluded: excluded,
    setsUsable: inputs.filter((set) => set.reps.length > 0).length,
    exerciseKeys: states.size,
    keysWithEnoughHistory: withHistory,
    exerciseDaysEvaluated: totals.daysEvaluated,
    candidatePairs: totals.candidatePairs,
    validPairs: totals.validPairs,
    rejectedPairs: totals.rejected,
    pairsByVerdict: totals.verdicts,
    pairsInWindow: totals.inWindow,
    pairsOutOfWindow: totals.outOfWindow,
    decisions: totals.decisions as Readonly<Record<StepDecision, number>>,
    stepsByDirection: totals.steps,
    keysReachingAnArrival: all.filter((s) => arrivals(s.history).length > 0).length,
    keysReadingLearned: all.filter((s) => s.state === 'learned').length,
    policyVersion: ADAPTIVE_REST_POLICY.policyVersion,
    tooThinToJudge: totals.validPairs < MIN_VALID_PAIRS_TO_JUDGE,
  };
}
