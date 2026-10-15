// The specialization lint as `plan.exercise.create` surfaces it (VW-624). A real `:memory:`
// store holds the declared priorities; the tier is stubbed, because reaching intermediate through
// the real signal takes months of seeded sessions that say nothing about this rule.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TierSignalModule from '../tier-signal.js';
import type { Tier } from '../tier-signal.js';

const tier = vi.hoisted(() => ({ current: 'intermediate' as Tier }));

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));
vi.mock('../tier-signal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TierSignalModule>()),
  getTierSignal: async () => ({ tier: tier.current, confidence: 'confident', declared: null }),
}));

const { registerPlanTools } = await import('../plan-tools.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');

import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { PlanWarning } from '../../plan/lint-plan.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredPriorityLevel } from '../../store/types.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

type Callback = (args: unknown) => Promise<{ content: { text: string }[] }>;

const SEED_BY_ID = new Map(SEED_CABLE_EXERCISES.map((e) => [e.id, e]));

interface Placeholder {
  callback?: Callback;
  update(u: { callback: Callback }): void;
  remove(): void;
}

/** Hands registerPlanTools a placeholder for whichever tool it asks for. */
class Placeholders extends Map<string, Placeholder> {
  override get(name: string): Placeholder {
    if (!this.has(name)) {
      const tool: Placeholder = {
        update(u) {
          tool.callback = u.callback;
        },
        remove() {},
      };
      this.set(name, tool);
    }
    return super.get(name)!;
  }
}

interface Harness {
  store: SessionStore;
  call: <T>(name: string, args: unknown) => Promise<T>;
}

function setup(): Harness {
  const store = openTestStore();
  const exercises = new ExerciseService();
  exercises.getById = ((id: string) => SEED_BY_ID.get(id)) as ExerciseService['getById'];
  const state = { store, exercises } as unknown as ServerState;
  const callbacks = new Placeholders();
  registerPlanTools(
    { tool: vi.fn() } as unknown as Parameters<typeof registerPlanTools>[0],
    state,
    callbacks as unknown as Parameters<typeof registerPlanTools>[2],
  );
  const call = async <T>(name: string, args: unknown): Promise<T> => {
    const result = await callbacks.get(name).callback!(args);
    return JSON.parse(result.content[0]!.text) as T;
  };
  return { store, call };
}

async function makeTemplate(h: Harness): Promise<string> {
  const { program } = await h.call<{ program: { id: string } }>('plan.program.create', {
    name: 'Arms',
  });
  const { block } = await h.call<{ block: { id: string } }>('plan.block.create', {
    programId: program.id,
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 4,
  });
  const { week } = await h.call<{ week: { id: string } }>('plan.week.create', {
    blockId: block.id,
    orderIndex: 0,
  });
  const { template } = await h.call<{ template: { id: string } }>('plan.template.create', {
    weekId: week.id,
    orderIndex: 0,
    name: 'Day A',
    dayLabel: 'Mon',
  });
  return template.id;
}

async function declare(store: SessionStore, ref: string, level: StoredPriorityLevel) {
  await store.putPriority({
    id: `pri-${ref}`,
    userId: LOCAL_USER_ID,
    horizonWeeks: 6,
    kind: 'muscle',
    ref,
    level,
    declaredAt: '2026-09-01T00:00:00.000Z',
    mesosHeld: 1,
  });
}

function specializationCodes(response: { warnings: PlanWarning[] }): string[] {
  return response.warnings
    .filter((w) => w.code === 'specialized_muscle_single_exercise')
    .map((w) => `${w.code} ${w.muscleGroup}`);
}

describe('plan.exercise.create specialization lint', () => {
  let h: Harness;

  beforeEach(() => {
    tier.current = 'intermediate';
    h = setup();
  });

  async function add(templateId: string, exerciseId: string, orderIndex: number) {
    return h.call<{ warnings: PlanWarning[] }>('plan.exercise.create', {
      workoutTemplateId: templateId,
      exerciseId,
      orderIndex,
      targetSets: 3,
    });
  }

  it('warns on the first exercise for a specialized muscle and clears on the second', async () => {
    await declare(h.store, 'biceps', 'specialize');
    const templateId = await makeTemplate(h);

    const first = await add(templateId, 'cable-bicep-curl', 0);
    const second = await add(templateId, 'cable-hammer-curl', 1);

    expect(specializationCodes(first)).toEqual(['specialized_muscle_single_exercise biceps']);
    expect(specializationCodes(second)).toEqual([]);
  });

  it('lets a back-burner muscle stand on one exercise', async () => {
    await declare(h.store, 'biceps', 'maintain');
    const templateId = await makeTemplate(h);

    expect(specializationCodes(await add(templateId, 'cable-bicep-curl', 0))).toEqual([]);
  });

  it('exempts a beginner', async () => {
    tier.current = 'beginner';
    await declare(h.store, 'biceps', 'specialize');
    const templateId = await makeTemplate(h);

    expect(specializationCodes(await add(templateId, 'cable-bicep-curl', 0))).toEqual([]);
  });
});
