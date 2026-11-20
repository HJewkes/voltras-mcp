// The swap gate (VW-622, B19): when a plan edit replaces a planned exercise mid-block, the
// response carries the outgoing lift's own top-load trend and what it argues for. Still
// progressing means finish the block, because boredom is not grounds; a flatline or a decline
// means the swap is supported. Advisory only: the edit has already been written when this runs.
//
// The trend stands in for stimulus against fatigue because nothing here measures the fatigue
// side (B18 is needs-research), so the copy names the trend and never a ratio. It also makes no
// "the new exercise will do better" claim: nothing compares the two lifts.

import {
  EXERCISE_SWAP_REFRAME,
  EXERCISE_SWAP_SETTLING_SESSIONS,
} from '../analytics/comparability.js';
import { plateauReferenceStepLbs } from '../analytics/stall-step.js';
import { FLATLINE_FRACTION_OF_RATE } from '@voltras/workout-analytics';
import type { SessionStore, StoredPlannedExercise } from '../store/types.js';
import { readTopLoadTrend, type TopLoadTrendReader } from './plan-brief-advisories.js';
import { WA_DEFAULT_PLATEAU_MIN_DAYS, type HistoryTrendResult } from './metrics-tools.js';

/**
 * The shortest window the trend is read over before it says anything: the flatline rule's own
 * minimum run, so this gate never calls a trend the stall rule would refuse to judge.
 */
export const SWAP_TREND_MIN_DAYS = WA_DEFAULT_PLATEAU_MIN_DAYS;

export type SwapTrend = 'progressing' | 'flat' | 'declining' | 'too_little_history';

export interface SwapCheck {
  outgoingExerciseId: string;
  incomingExerciseId: string;
  trend: SwapTrend;
  /** `swap_supported` on a flat or declining lift, `finish_block` on a progressing one. */
  advice: 'finish_block' | 'swap_supported' | 'no_trend_to_judge';
  /** The fitted top-load slope; `null` with too little history. */
  slopeLbsPerWeek: number | null;
  windowDays: number | null;
  text: string;
  rpIds: string[];
}

export interface SwapEdit {
  outgoingExerciseId: string;
  incomingExerciseId: string;
}

const RP_STALENESS = 'rp:rp-s7-sfr-staleness-exercise-swap-trigger';
const RP_BOREDOM = 'rp:rp-s2-physiological-vs-psychological-staleness';
const RP_NOVELTY = 'rp:rp-s7-novelty-effect-inflates-sfr-temporarily';

type MidBlockStore = Pick<
  SessionStore,
  | 'getWorkoutTemplate'
  | 'getTrainingWeek'
  | 'getTrainingWeeksForBlock'
  | 'getWorkoutTemplatesForWeek'
  | 'getAssignmentsForTemplate'
>;

/**
 * Whether the template's block is under way: some workout in it has been trained and some has
 * not. Read from the block's own assignments rather than its dates, so an undated block counts.
 */
export async function isMidBlock(store: MidBlockStore, templateId: string): Promise<boolean> {
  const template = await store.getWorkoutTemplate(templateId);
  const week = template && (await store.getTrainingWeek(template.weekId));
  if (week === undefined) return false;
  let trained = false;
  let remaining = false;
  for (const blockWeek of await store.getTrainingWeeksForBlock(week.blockId)) {
    for (const sibling of await store.getWorkoutTemplatesForWeek(blockWeek.id)) {
      const done = (await store.getAssignmentsForTemplate(sibling.id)).length > 0;
      trained ||= done;
      remaining ||= !done;
    }
  }
  return trained && remaining;
}

/**
 * The check for a write that replaced a planned exercise mid-block, or `null` for any other
 * write. Swallows a failed read on purpose: the row is already committed, and the gate is
 * advisory, so a hiccup costs the caller its advisory and never its write.
 */
export async function swapCheckForEdit(
  state: Parameters<TopLoadTrendReader>[0] & { store: MidBlockStore },
  before: StoredPlannedExercise | undefined,
  after: StoredPlannedExercise,
): Promise<SwapCheck | null> {
  if (before === undefined || before.exerciseId === after.exerciseId) return null;
  try {
    if (!(await isMidBlock(state.store, after.workoutTemplateId))) return null;
    const edit = { outgoingExerciseId: before.exerciseId, incomingExerciseId: after.exerciseId };
    return await readSwapCheck(state, edit);
  } catch {
    return null;
  }
}

/** The swap check for one replacement, reading the outgoing lift's trend. */
export async function readSwapCheck(
  state: Parameters<TopLoadTrendReader>[0],
  edit: SwapEdit,
  readTrend: TopLoadTrendReader = readTopLoadTrend,
): Promise<SwapCheck> {
  return swapCheckOf(edit, await readTrend(state, edit.outgoingExerciseId));
}

/** The check a trend read argues for; pure so each verdict is pinned without a store. */
export function swapCheckOf(edit: SwapEdit, found: HistoryTrendResult | null): SwapCheck {
  const fit = found?.trend ?? null;
  if (found === null || fit === null || fit.windowDays < SWAP_TREND_MIN_DAYS) {
    return tooLittleHistory(edit);
  }
  const slopeLbsPerWeek = round1(fit.slope * 7);
  const trend = classify(found, slopeLbsPerWeek);
  const base = { ...edit, trend, slopeLbsPerWeek, windowDays: fit.windowDays };
  if (trend === 'progressing') {
    return { ...base, advice: 'finish_block', text: progressingText(base), rpIds: [RP_BOREDOM] };
  }
  return {
    ...base,
    advice: 'swap_supported',
    text: supportedText(base, found),
    rpIds: [RP_STALENESS, RP_NOVELTY],
  };
}

/**
 * A flatline is the stall rule's own verdict. Without one, the slope is judged against the same
 * line that rule draws (a share of the expected weekly step), so the two never disagree on flat.
 */
function classify(found: HistoryTrendResult, slopeLbsPerWeek: number): SwapTrend {
  const flatline = found.plateau?.flatline ?? null;
  if (flatline !== null) return flatline.slopeLbsPerWeek < 0 ? 'declining' : 'flat';
  const latest = found.series.at(-1)?.value ?? 0;
  const flatBelow = plateauReferenceStepLbs(latest) * FLATLINE_FRACTION_OF_RATE;
  if (slopeLbsPerWeek <= -flatBelow) return 'declining';
  return slopeLbsPerWeek < flatBelow ? 'flat' : 'progressing';
}

type CheckBase = Pick<
  SwapCheck,
  'outgoingExerciseId' | 'incomingExerciseId' | 'trend' | 'slopeLbsPerWeek' | 'windowDays'
>;

function progressingText(base: CheckBase): string {
  return (
    `${base.outgoingExerciseId} is still progressing: its top load is rising about ` +
    `${base.slopeLbsPerWeek} lb a week over the last ${base.windowDays} days. Finish the block on ` +
    'it and make the swap at the next block. Boredom is not grounds for a swap mid-block; only ' +
    `a lift that has stopped responding is (${RP_BOREDOM}). This reads only the trend: a swap ` +
    'for joint pain is a different call, so ask the lifter which it is.'
  );
}

function supportedText(base: CheckBase, found: HistoryTrendResult): string {
  const flatline = found.plateau?.flatline ?? null;
  const evidence =
    flatline === null
      ? `its top load is moving about ${base.slopeLbsPerWeek} lb a week over the last ${base.windowDays} days`
      : flatline.reasoning;
  return (
    `${base.outgoingExerciseId} is ${base.trend === 'declining' ? 'declining' : 'flat'}: ` +
    `${evidence}. The swap to ${base.incomingExerciseId} is supported (${RP_STALENESS}). ` +
    noveltyWindowText(base.incomingExerciseId)
  );
}

function tooLittleHistory(edit: SwapEdit): SwapCheck {
  return {
    ...edit,
    trend: 'too_little_history',
    advice: 'no_trend_to_judge',
    slopeLbsPerWeek: null,
    windowDays: null,
    text:
      `${edit.outgoingExerciseId} has too little recent history to read a trend from (under ` +
      `${SWAP_TREND_MIN_DAYS} days of working sets), so the trend neither supports nor argues ` +
      'against the swap. If the reason is boredom rather than pain, finishing the block on it ' +
      `is the default (${RP_BOREDOM}).`,
    rpIds: [RP_BOREDOM],
  };
}

/**
 * The novelty window, named without a length: {@link EXERCISE_SWAP_SETTLING_SESSIONS} is
 * `null` because no source gives one, and the sentence follows it.
 */
function noveltyWindowText(incomingExerciseId: string): string {
  const length =
    EXERCISE_SWAP_SETTLING_SESSIONS === null
      ? 'for an unsourced number of sessions'
      : `for about ${EXERCISE_SWAP_SETTLING_SESSIONS} sessions`;
  return (
    `Expect ${incomingExerciseId}'s first sessions to read better than they are, ${length}, ` +
    `because a new movement responds to novelty (${RP_NOVELTY}); and ${EXERCISE_SWAP_REFRAME}.`
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
