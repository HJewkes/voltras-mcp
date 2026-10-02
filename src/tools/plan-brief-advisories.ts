// Advisories the planning brief carries into the sitting (VW-558 S10): a main lift going in on
// an open flatline, the deload cadence (VW-619, in plan-brief-cadence.ts) and a training day
// added too soon (VW-623, in plan-brief-frequency.ts) and the specialization frequency bump (VW-624,
// in plan-brief-specialization.ts). Advisory copy only: the sitting decides, and nothing here blocks a plan.

import { todayLocal } from '../analytics/training-days.js';
import type { Flatline } from '../analytics/stall-step.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type StoredTrainingBlock } from '../store/types.js';
import { computeHistoryTrend } from './metrics-tools.js';
import {
  activeRestAdvisory,
  cadenceTier,
  deloadCadenceAdvisory,
  tierEvidenceAdvisory,
  type BlockWeeks,
  type DatedBlockWeeks,
  type DatedWeek,
  type WeekShape,
} from './plan-brief-cadence.js';
import {
  readProgramBlockDays,
  trainingDayAddAdvisory,
  type BlockDays,
} from './plan-brief-frequency.js';
import { frequencyBumpAdvisories, isFinalBeforeActiveRest } from './plan-brief-specialization.js';
import { isSpecializedMuscle } from '../plan/specialization.js';
import { readDietPhaseState } from './diet-phase-state.js';
import { calendarOf, placedBlocks } from './plan-schedule-tools.js';
import { getTierSignal, type TierSignal } from './tier-signal.js';

export interface BriefAdvisory {
  kind:
    | 'staleness'
    | 'deload_cadence'
    | 'tier_evidence'
    | 'active_rest'
    | 'frequency_progression'
    | 'specialization_frequency_bump';
  exerciseId: string | null;
  text: string;
  rpIds: string[];
}

type AdvisoryState = Pick<ServerState, 'store'>;

/** The trailing flatline on a lift's top-load trend, or `null` when it has none or no history. */
export type FlatlineReader = (state: AdvisoryState, exerciseId: string) => Promise<Flatline | null>;

/** What the advisories read beyond the plan rows; each is injectable so a test can pin it. */
export interface AdvisoryReaders {
  readFlatline: FlatlineReader;
  readTier: (state: AdvisoryState) => Promise<Pick<TierSignal, 'tier' | 'declared'>>;
  readDatedBlocks: (state: AdvisoryState, today: string) => Promise<DatedBlockWeeks[]>;
  readBlockDays: (state: AdvisoryState, next: StoredTrainingBlock | null) => Promise<BlockDays[]>;
  readDietPhase: (state: AdvisoryState) => Promise<string>;
  today: string;
}

export async function readBriefAdvisories(
  state: AdvisoryState,
  finishing: StoredTrainingBlock | null,
  overrides: Partial<AdvisoryReaders> = {},
  next: StoredTrainingBlock | null = null,
): Promise<BriefAdvisory[]> {
  const readers = { ...defaultReaders(), ...overrides };
  const advisories: BriefAdvisory[] = [];
  for (const exerciseId of await mainLiftIds(state)) {
    const found = await readers.readFlatline(state, exerciseId);
    if (found !== null) advisories.push(stalenessAdvisory(exerciseId, found));
  }
  const dayAdded = trainingDayAddAdvisory(await readers.readBlockDays(state, next));
  return [
    ...advisories,
    ...(await cadenceAdvisories(state, finishing, readers)),
    ...(dayAdded === null ? [] : [dayAdded]),
    ...(await specializationAdvisories(state, next, readers)),
  ];
}

function defaultReaders(): AdvisoryReaders {
  return {
    readFlatline: openFlatline,
    readTier: (state) => getTierSignal(state),
    readDatedBlocks,
    readBlockDays: (state, next) => readProgramBlockDays(state.store, next),
    readDietPhase: async (state) => (await readDietPhaseState(state as ServerState)).phase,
    today: todayLocal(),
  };
}

/** The cadence family, all silent for a beginner (rp:rp-s4-beginner-no-deload-for-months). */
async function cadenceAdvisories(
  state: AdvisoryState,
  finishing: StoredTrainingBlock | null,
  readers: AdvisoryReaders,
): Promise<BriefAdvisory[]> {
  const signal = await readers.readTier(state);
  const tier = cadenceTier(signal);
  if (tier === null) return [];
  const history = finishing === null ? [] : await programHistory(state, finishing);
  const found = [
    finishing === null ? null : deloadCadenceAdvisory(finishing, history, tier),
    tier === 'advanced' ? tierEvidenceAdvisory(history) : null,
    activeRestAdvisory(await readers.readDatedBlocks(state, readers.today), readers.today),
  ];
  return found.filter((advisory) => advisory !== null);
}

/** The frequency bump offer for the block being planned, read only when a muscle is specialized. */
async function specializationAdvisories(
  state: AdvisoryState,
  next: StoredTrainingBlock | null,
  readers: AdvisoryReaders,
): Promise<BriefAdvisory[]> {
  if (next === null) return [];
  const priorities = await state.store.listPriorities(LOCAL_USER_ID);
  if (!priorities.some(isSpecializedMuscle)) return [];
  const following = (await state.store.getTrainingBlocksForProgram(next.programId))
    .filter((block) => block.orderIndex > next.orderIndex)
    .sort((a, b) => a.orderIndex - b.orderIndex)[0];
  const followingWeeks = following === undefined ? [] : await weekShapes(state, following.id);
  return frequencyBumpAdvisories({
    blockName: next.name,
    priorities,
    tier: (await readers.readTier(state)).tier,
    dietPhase: await readers.readDietPhase(state),
    finalBeforeActiveRest: isFinalBeforeActiveRest(
      await weekShapes(state, next.id),
      followingWeeks,
    ),
  });
}

/** The lifts the lifter declared as priorities: the main lifts a sitting plans around. */
async function mainLiftIds(state: AdvisoryState): Promise<string[]> {
  const priorities = await state.store.listPriorities(LOCAL_USER_ID);
  return [...new Set(priorities.filter((p) => p.kind === 'lift').map((p) => p.ref))];
}

async function openFlatline(state: AdvisoryState, exerciseId: string): Promise<Flatline | null> {
  try {
    const result = await computeHistoryTrend(state as ServerState, { exerciseId });
    return result.plateau?.flatline ?? null;
  } catch {
    // A lift with no working sets in the window has no trend, so it cannot be stale.
    return null;
  }
}

function stalenessAdvisory(exerciseId: string, found: Flatline): BriefAdvisory {
  return {
    kind: 'staleness',
    exerciseId,
    text:
      `${exerciseId} goes into this sitting on an open flatline: ${found.reasoning}. A lift that ` +
      'has stopped responding is the one to swap at the end of the mesocycle, after checking the ' +
      'stall is not fatigue or a diet phase (rp:rp-s7-sfr-staleness-exercise-swap-trigger).',
    rpIds: ['rp:rp-s7-sfr-staleness-exercise-swap-trigger'],
  };
}

/** The finishing block's program up to and including it, each block with its weeks in order. */
async function programHistory(
  state: AdvisoryState,
  finishing: StoredTrainingBlock,
): Promise<BlockWeeks[]> {
  const blocks = (await state.store.getTrainingBlocksForProgram(finishing.programId))
    .filter((block) => block.id === finishing.id || block.orderIndex < finishing.orderIndex)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  return Promise.all(
    blocks.map(async (block) => ({ block, weeks: await weekShapes(state, block.id) })),
  );
}

async function weekShapes(state: AdvisoryState, blockId: string): Promise<WeekShape[]> {
  const weeks = await state.store.getTrainingWeeksForBlock(blockId);
  const ordered = [...weeks].sort((a, b) => a.orderIndex - b.orderIndex);
  return Promise.all(
    ordered.map(async (week) => ({
      isDeload: week.isDeload,
      templates: (await state.store.getWorkoutTemplatesForWeek(week.id)).length,
    })),
  );
}

async function readDatedBlocks(state: AdvisoryState, today: string): Promise<DatedBlockWeeks[]> {
  const placed = await placedBlocks(state as ServerState);
  return Promise.all(
    placed.map(async (block) => ({
      startsOn: block.startsOn,
      endsOn: block.endsOn,
      weeks: await datedWeeks(state, block.blockId, today),
    })),
  );
}

/** The block's calendar weeks; an extend skip, or a week row with no workouts, is off. */
async function datedWeeks(
  state: AdvisoryState,
  blockId: string,
  today: string,
): Promise<DatedWeek[]> {
  const calendar = await calendarOf(state as ServerState, blockId, today);
  const rows = await state.store.getTrainingWeeksForBlock(blockId);
  const templatesByPlanWeek = new Map<number, number>();
  for (const row of rows) {
    const templates = await state.store.getWorkoutTemplatesForWeek(row.id);
    templatesByPlanWeek.set(row.orderIndex + 1, templates.length);
  }
  return calendar.weeks.map((week) => ({
    isDeload: week.isDeload,
    off: week.planWeek === null || templatesByPlanWeek.get(week.planWeek) === 0,
    endsOn: week.endsOn,
  }));
}
