// VW-591 (VW-139 S1): which rung of RP's fatigue-reduction ladder, if any, a
// set of per-muscle performance states points at.
//
// PURE. No store, no clock, no tool surface: the caller assembles every input,
// including `now`, and the same input always yields the same advisory.
//
// ONLY MEASURED PERFORMANCE MOVES THE LADDER. The input admits per-muscle
// performance states and planning facts, and nothing else. Soreness, joint
// pain, motivation and recovery timing move next week's set count, which is a
// separate channel; the input type has no field that could carry them.
//
// OFF DAY AND ACTIVE REST ARE NEVER OUTPUTS. The first is weekly hygiene and
// the second is a calendar decision; neither answers a performance trigger.
//
// S1 SCOPE: rungs 2 and 3, plus watching, inconclusive and suppressed. Deload
// week escalation and the beginner cap arrive with VW-595; until then tier and
// prior decisions are accepted but do not change the rung.

import type { Tier, TierConfidence } from '../tools/tier-signal.js';

/** Bumped when a threshold or a rung rule below changes. */
export const DELOAD_LADDER_VERSION = 'vw591.1';

export const DELOAD_LADDER_CONSTANTS = {
  /** Width of the rolling window a confirmation must fall in to count, in days. */
  rollingWindowDays: 7,
  /** Confirmed muscles inside the window that lift the rung to a recovery half-week. */
  halfWeekMinConfirmedMuscles: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type MusclePerformanceState = 'confirmed' | 'provisional' | 'inconclusive' | 'clear';

export type DeloadRung = 'recovery_session' | 'recovery_half_week' | 'deload_week';

export type DeloadStatus = 'clear' | 'watching' | 'advise' | 'inconclusive' | 'suppressed';

/** One exercise's three-session comparison, reproducible with `mrvguard.check`. */
export interface DeloadEvidence {
  exerciseId: string;
  sessionIds: readonly [string, string, string];
  reasoning: string;
}

interface MuscleSignalBase {
  muscle: string;
  evidence: readonly DeloadEvidence[];
}

/** A confirmation carries the ISO instant of the session that confirmed it. */
export type DeloadMuscleSignal = MuscleSignalBase &
  (
    | { state: 'confirmed'; confirmedAt: string }
    | { state: Exclude<MusclePerformanceState, 'confirmed'> }
  );

/** One earlier ladder advisory and the lifter's answer, read back from the decision store. */
export interface PriorLadderDecision {
  rung: DeloadRung;
  advisedAt: string;
  response: 'accepted' | 'declined' | 'ignored' | null;
}

export interface DeloadLadderInput {
  muscles: readonly DeloadMuscleSignal[];
  tier: { tier: Tier; confidence: TierConfidence };
  currentWeekIsDeload: boolean;
  priorDecisions: readonly PriorLadderDecision[];
  now: Date;
}

export interface DeloadAdvisory {
  status: DeloadStatus;
  /** Non-null only when `status` is `advise`. */
  rung: DeloadRung | null;
  muscles: Array<{
    muscle: string;
    state: MusclePerformanceState;
    evidence: DeloadEvidence[];
  }>;
  /** Why this status, including why the advisory stayed silent. */
  reasoning: string;
  /** What the rung means; never an instruction. */
  userMessage: string;
  /** Non-null only when `status` is `advise`. */
  respondWith: 'plan.respond_deload_advisory' | null;
  thresholdsUsed: Record<string, number>;
  algorithmVersion: string;
}

type Verdict = Pick<DeloadAdvisory, 'status' | 'rung' | 'reasoning' | 'userMessage'>;

export function selectDeloadRung(input: DeloadLadderInput): DeloadAdvisory {
  const verdict = decide(input);
  return {
    ...verdict,
    muscles: input.muscles.map((signal) => ({
      muscle: signal.muscle,
      state: signal.state,
      evidence: [...signal.evidence],
    })),
    respondWith: verdict.status === 'advise' ? 'plan.respond_deload_advisory' : null,
    thresholdsUsed: { ...DELOAD_LADDER_CONSTANTS },
    algorithmVersion: DELOAD_LADDER_VERSION,
  };
}

function decide(input: DeloadLadderInput): Verdict {
  if (input.currentWeekIsDeload) return suppressedVerdict();
  const byWindow = groupByWindow(input.muscles, input.now);
  if (byWindow.inWindow.length > 0) return adviseVerdict(byWindow.inWindow);
  const provisional = musclesIn(input.muscles, 'provisional');
  if (provisional.length + byWindow.stale.length + byWindow.unplaced.length > 0) {
    return watchingVerdict({ provisional, stale: byWindow.stale, unplaced: byWindow.unplaced });
  }
  if (musclesIn(input.muscles, 'clear').length > 0) return clearVerdict();
  return inconclusiveVerdict(input.muscles.length);
}

function musclesIn(
  muscles: readonly DeloadMuscleSignal[],
  state: MusclePerformanceState,
): string[] {
  return muscles.filter((signal) => signal.state === state).map((signal) => signal.muscle);
}

interface WatchedMuscles {
  /** A single miss. */
  provisional: string[];
  /** Confirmed, but longer ago than the rolling window. */
  stale: string[];
  /** Confirmed at an instant after `now` or one that does not parse. */
  unplaced: string[];
}

/** Sorts confirmed muscles by where their confirmation instant falls against the window ending at `now`. */
function groupByWindow(
  muscles: readonly DeloadMuscleSignal[],
  now: Date,
): Omit<WatchedMuscles, 'provisional'> & { inWindow: string[] } {
  const windowMs = DELOAD_LADDER_CONSTANTS.rollingWindowDays * DAY_MS;
  const groups = { inWindow: [] as string[], stale: [] as string[], unplaced: [] as string[] };
  for (const signal of muscles) {
    if (signal.state !== 'confirmed') continue;
    const ageMs = now.getTime() - Date.parse(signal.confirmedAt);
    if (Number.isNaN(ageMs) || ageMs < 0) groups.unplaced.push(signal.muscle);
    else if (ageMs > windowMs) groups.stale.push(signal.muscle);
    else groups.inWindow.push(signal.muscle);
  }
  return groups;
}

function adviseVerdict(confirmed: string[]): Verdict {
  const days = DELOAD_LADDER_CONSTANTS.rollingWindowDays;
  const names = listMuscles(confirmed);
  if (confirmed.length >= DELOAD_LADDER_CONSTANTS.halfWeekMinConfirmedMuscles) {
    return {
      status: 'advise',
      rung: 'recovery_half_week',
      reasoning: `${confirmed.length} muscles (${names}) each came in below their own performance a week earlier on two consecutive sessions, inside the same rolling ${days} days.`,
      userMessage: `${names} have each fallen below the week before on two sessions in a row. A recovery half-week is a few days of lighter training that usually buys one and a half to two and a half more weeks of productive work. Whether to take it is your call.`,
    };
  }
  return {
    status: 'advise',
    rung: 'recovery_session',
    reasoning: `${names} came in below its own performance a week earlier on two consecutive sessions inside the rolling ${days} days; it is the only muscle confirmed there.`,
    userMessage: `${names} has fallen below the week before on two sessions in a row. A recovery session is one session at about half the usual volume, load and reps, with more reps in reserve. Whether to take it is your call.`,
  };
}

function watchingVerdict(watched: WatchedMuscles): Verdict {
  const days = DELOAD_LADDER_CONSTANTS.rollingWindowDays;
  const causes: Array<[string[], string, string]> = [
    [
      watched.provisional,
      'a single miss',
      'came in below the week before on one session. One session is noise; the next session of that muscle shows whether it repeats',
    ],
    [
      watched.stale,
      `a confirmation older than the rolling ${days} days`,
      `came in below the week before on two sessions in a row, but that was more than ${days} days ago, so it no longer points at a recovery rung; the next session of that muscle shows whether it is still declining`,
    ],
    [
      watched.unplaced,
      'a confirmation whose instant cannot be placed in the window',
      'came in below the week before on two sessions in a row, but the date of that confirmation could not be placed in the last week, so it does not point at a recovery rung',
    ],
  ];
  const present = causes.filter(([muscles]) => muscles.length > 0);
  const reasons = present.map(
    ([muscles, cause]) => `${listMuscles(muscles)} ${verb(muscles, 'has', 'have')} ${cause}`,
  );
  const messages = present.map(([muscles, , message]) => `${listMuscles(muscles)} ${message}.`);
  return {
    status: 'watching',
    rung: null,
    reasoning: `No muscle has a confirmation inside the rolling ${days} days. ${reasons.join('; ')}, so nothing is advised yet.`,
    userMessage: messages.join(' '),
  };
}

function suppressedVerdict(): Verdict {
  return {
    status: 'suppressed',
    rung: null,
    reasoning:
      'The current planned week is already a deload week, so no ladder rung is offered on top of it.',
    userMessage:
      'This week is a planned deload, which already reduces fatigue more than any recovery rung would.',
  };
}

function clearVerdict(): Verdict {
  return {
    status: 'clear',
    rung: null,
    reasoning:
      'Every evaluable muscle held or improved against its own performance a week earlier.',
    userMessage:
      'No muscle has come in below the week before, so there is no sign of accumulated fatigue.',
  };
}

function inconclusiveVerdict(muscleCount: number): Verdict {
  const scope =
    muscleCount === 0
      ? 'No muscle was trained in the window'
      : 'No muscle had an evaluable comparison';
  return {
    status: 'inconclusive',
    rung: null,
    reasoning: `${scope}, so performance decline cannot be judged either way.`,
    userMessage:
      'There is not yet enough comparable history to tell whether performance is declining.',
  };
}

function verb(muscles: string[], singular: string, plural: string): string {
  return muscles.length === 1 ? singular : plural;
}

function listMuscles(muscles: string[]): string {
  if (muscles.length <= 1) return muscles.join('');
  return `${muscles.slice(0, -1).join(', ')} and ${muscles[muscles.length - 1]}`;
}
