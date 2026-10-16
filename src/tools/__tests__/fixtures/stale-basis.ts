// One plan, one basis session and a `plan.suggest_progression` caller over a real store, for the
// stale-basis tests (VW-907). The caller mocks `@voltras/node-sdk` and fixes the clock.

import type { Phase, Rep } from '@voltras/workout-analytics';

import { LOCAL_USER_ID } from '../../../store/sqlite-store.js';
import type { ServerState } from '../../../state/server-state.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../../store/types.js';
import type { SessionStore } from '../../../store/__tests__/open-test-store.js';
import { registerPlanTools } from '../../plan-tools.js';
import { CORE_TOOL_NAMES } from '../../../tool-registry.js';

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

export const BASIS = 'sess-basis';

export const PLANNED: StoredPlannedExercise = {
  id: 'pe-1',
  workoutTemplateId: 'tmpl-1',
  exerciseId: 'bench-press',
  orderIndex: 0,
  targetSets: 3,
  targetRepsLow: 8,
  targetRepsHigh: 12,
};

export interface BasisShape {
  startedAt: string;
  /** Defaults to `startedAt`. */
  endedAt?: string;
  /** Defaults to 135; `null` records no load at all. */
  weightLbs?: number | null;
  /** Peak velocity falls from 1000 to 500 over the set: a hard set. Flat otherwise. */
  hard?: boolean;
}

function phase(peakVelocity: number): Phase {
  return {
    samples: [],
    startTime: 0,
    endTime: 0,
    startPosition: 0,
    endPosition: 0.4,
    peakVelocity,
  } as unknown as Phase;
}

/** Twelve reps: a topped-out 8-12 band that would earn +5 lb on a fresh basis. */
export function toppedOutSet(n: number, shape: BasisShape): StoredSet {
  const id = `set-${String(n)}`;
  const reps = Array.from({ length: 12 }, (_, index): StoredRep => {
    const peak = shape.hard === true ? 1000 - (500 * index) / 11 : 800;
    const rep = { repNumber: index + 1, concentric: phase(peak), eccentric: phase(peak) };
    return { ...(rep as unknown as Rep), id: `${id}-r${String(index)}`, setId: id, index };
  });
  const weightLbs = shape.weightLbs === undefined ? 135 : shape.weightLbs;
  return {
    id,
    sessionId: BASIS,
    startedAt: shape.startedAt,
    endedAt: shape.endedAt ?? shape.startedAt,
    partial: false,
    exerciseId: 'bench-press',
    reps,
    ...(weightLbs === null ? {} : { weightLbs }),
  } as StoredSet;
}

export async function seedPlan(store: SessionStore): Promise<void> {
  await store.putTrainingProgram({ id: 'prog-1', name: 'Plan', createdAt: '2026-01-01T00:00:00Z' });
  await store.putTrainingBlock({
    id: 'block-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 4,
  });
  await store.putTrainingWeek({
    id: 'week-1',
    blockId: 'block-1',
    orderIndex: 0,
    weekIndex: 0,
    isDeload: false,
  });
  await store.putWorkoutTemplate({ id: 'tmpl-1', weekId: 'week-1', orderIndex: 0, name: 'A' });
  await store.putPlannedExercise(PLANNED);
}

export async function seedBasis(store: SessionStore, shape: BasisShape): Promise<StoredSet[]> {
  await store.putSession({
    kind: 'training',
    id: BASIS,
    startedAt: shape.startedAt,
    endedAt: shape.endedAt ?? shape.startedAt,
    exerciseId: 'bench-press',
  });
  const sets = [1, 2, 3].map((n) => toppedOutSet(n, shape));
  for (const set of sets) await store.putSet({ ...set, userId: LOCAL_USER_ID });
  return sets;
}

/** A lifter the tier signal reads as intermediate: declared, plateaued, back from a short break. */
export async function seedIntermediate(store: SessionStore): Promise<void> {
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    updatedAt: '2026-01-01T00:00:00.000Z',
    declaredTier: 'intermediate',
    everPlateaued: true,
    yearsTraining: 3,
    lastBreakMonths: 1,
  });
}

/** Register the plan tools on `store` and return a `plan.suggest_progression` caller. */
export function suggestProgressionOn(store: SessionStore): () => Promise<Record<string, unknown>> {
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  const state = { store, slots: new Map() } as unknown as ServerState;
  registerPlanTools({} as never, state, placeholders as never);
  return async () => {
    const result = await callbacks.get('plan.suggest_progression')!({
      programId: 'prog-1',
      exerciseId: 'bench-press',
    });
    if (result.isError === true) throw new Error(result.content[0].text);
    return (JSON.parse(result.content[0].text) as { suggestion: Record<string, unknown> })
      .suggestion;
  };
}
