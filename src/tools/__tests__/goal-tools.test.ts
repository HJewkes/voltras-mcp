// Tool-boundary tests for src/tools/goal-tools.ts (VW-350, plan H2).
//
// A real `SqliteSessionStore` on `:memory:` rather than a faked store: these
// handlers read history, the plan tree, the diet phase and the baseline row,
// and a fake that answers all of those is a second implementation of the
// store with its own opinions. The exercise catalog IS stubbed — which lifts
// exist is `goal-metrics.ts`'s problem, already tested there.
//
// What the cases are for:
//   * the declaration is stored exactly as made, however loudly the
//     guardrails complain about it;
//   * a start value is read from history, so a lift with no sets gets a
//     stated gap rather than a band over an invented number;
//   * the information level tracks the evidence (1 matched session is cold,
//     2 earns the ramp);
//   * an accepted target does not move, in either direction, ever.

import { beforeEach, describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { registerGoalTools } from '../goal-tools.js';

const TOOL_NAMES = [
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
];

const CATALOG = [
  { id: 'bench-press', muscleGroups: ['chest'], name: 'Bench Press' },
  { id: 'cable-fly', muscleGroups: ['chest'], name: 'Cable Fly' },
  { id: 'curl', muscleGroups: ['biceps'], name: 'Curl' },
];

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(updates: { callback: FakeRegisteredTool['callback'] }): void;
}

interface Harness {
  store: SqliteSessionStore;
  invoke: (name: string, args?: unknown) => Promise<Record<string, unknown>>;
  expectError: (name: string, args?: unknown) => Promise<{ code: string; message: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function makeReps(setId: string, count: number): StoredRep[] {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 1000,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return Array.from({ length: count }, (_, index) => ({
    repNumber: index + 1,
    concentric: phase,
    eccentric: phase,
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  }));
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const state = {
    store,
    exercises: { list: () => CATALOG, getById: (id: string) => CATALOG.find((e) => e.id === id) },
  } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  registerGoalTools(
    undefined as unknown as Parameters<typeof registerGoalTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerGoalTools>[2],
  );
  const call = async (name: string, args: unknown = {}) => {
    const callback = placeholders.get(name)?.callback;
    if (callback === undefined) throw new Error(`no callback installed for ${name}`);
    return callback(args);
  };
  return {
    store,
    invoke: async (name, args) => {
      const result = await call(name, args);
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
      if (result.isError === true) throw new Error(`unexpected error: ${result.content[0].text}`);
      return body;
    },
    expectError: async (name, args) => {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      return JSON.parse(result.content[0].text) as { code: string; message: string };
    },
  };
}

/**
 * `sessionCount` sessions at `weightLbs` for `reps`, two working sets each.
 *
 * Two sets a session because the baseline needs three qualifying sets before
 * it leaves COLD, and the information-level gate wants both — two matched
 * SESSIONS and a baseline past SHAPE_ONLY — before it claims a gain band.
 * `withBaseline` adds the one failure anchor that carries it to PROVISIONAL.
 */
async function seedLiftHistory(
  store: SqliteSessionStore,
  options: {
    exerciseId?: string;
    sessionCount: number;
    weightLbs: number;
    reps: number;
    withBaseline?: boolean;
  },
): Promise<void> {
  const exerciseId = options.exerciseId ?? 'bench-press';
  let lastSetId = '';
  for (let index = 0; index < options.sessionCount; index += 1) {
    const at = daysAgo((options.sessionCount - index) * 7);
    const sessionId = `${exerciseId}-sess-${String(index)}`;
    await store.putSession({ id: sessionId, startedAt: at, endedAt: at, exerciseId });
    for (const suffix of ['a', 'b']) {
      lastSetId = `${exerciseId}-set-${String(index)}${suffix}`;
      const set: StoredSet = {
        id: lastSetId,
        sessionId,
        userId: LOCAL_USER_ID,
        exerciseId,
        startedAt: at,
        endedAt: at,
        partial: false,
        weightLbs: options.weightLbs,
        setPurpose: 'working',
        reps: makeReps(lastSetId, options.reps),
      };
      await store.putSet(set);
    }
  }
  if (options.withBaseline !== true) return;
  await store.putFailureAnchor({
    id: `${exerciseId}-anchor`,
    userId: LOCAL_USER_ID,
    setId: lastSetId,
    exerciseId,
    observedAt: daysAgo(7),
    source: 'harvested',
    terminalVelocityMps: 0.18,
    filterInputs: {},
    filterVerdict: 'failure',
    filterVersion: 'test@1',
  });
  await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId });
}

async function declareLift(harness: Harness, ref = 'bench-press'): Promise<string> {
  const declared = await harness.invoke('goal.declare_priorities', {
    items: [{ kind: 'lift', ref, level: 'specialize' }],
    horizonWeeks: 6,
  });
  return (declared.priorities as { id: string }[])[0].id;
}

interface ProposedTargetShape {
  targetId: string;
  metric: string;
  infoLevel: string;
  basis: string;
  startValue: number;
  committedValue: number;
  stretchValue: number;
  rpIds: string[];
  acceptedBy: null;
}

async function proposeFirstTarget(
  harness: Harness,
  priorityId: string,
): Promise<ProposedTargetShape> {
  const proposed = await harness.invoke('goal.propose_targets', { priorityId });
  return (proposed.targets as ProposedTargetShape[])[0];
}

describe('goal.declare_priorities', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
  });

  it('stores what was declared and reports the phase and tier it judged it against', async () => {
    const result = await harness.invoke('goal.declare_priorities', {
      items: [
        { kind: 'lift', ref: 'bench-press', level: 'specialize' },
        { kind: 'muscle', ref: 'arms', level: 'maintain' },
      ],
      horizonWeeks: 8,
    });
    expect(result.priorities).toHaveLength(2);
    expect(result.priorities).toMatchObject([
      { kind: 'lift', ref: 'bench-press', level: 'specialize', horizonWeeks: 8, mesosHeld: 0 },
      { kind: 'muscle', ref: 'arms', level: 'maintain' },
    ]);
    expect(result.dietPhase).toBe('unknown');
    expect(result.tierUsed).toBe('beginner');
  });

  it('warns above the specialize cap without dropping an item', async () => {
    const result = await harness.invoke('goal.declare_priorities', {
      items: ['chest', 'back', 'biceps'].map((ref) => ({
        kind: 'muscle',
        ref,
        level: 'specialize',
      })),
    });
    expect((result.warnings as { code: string }[]).map((w) => w.code)).toEqual([
      'specialize_cap_exceeded',
    ]);
    expect(result.priorities).toHaveLength(3);
  });

  it('proposes the fat-loss downgrade, stores the declaration unchanged, and never re-offers a decline', async () => {
    await harness.store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      declaredTier: 'intermediate',
      updatedAt: daysAgo(1),
    });
    await harness.store.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'fat-loss',
      startedAt: daysAgo(14),
      declaredAt: daysAgo(14),
    });
    const offered = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize' }],
    });
    expect(offered.proposals).toMatchObject([
      { code: 'goal_fat_loss_specialize_downgrade', ref: 'chest', to: 'maintain' },
    ]);
    expect(offered.priorities).toMatchObject([{ ref: 'chest', level: 'specialize' }]);

    const declined = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize', declineFatLossDowngrade: true }],
    });
    expect(declined.proposals).toEqual([]);

    const again = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize' }],
    });
    expect(again.proposals).toEqual([]);
    const recorded = await harness.store.listAdvisoryDecisions(LOCAL_USER_ID);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      code: 'goal_fat_loss_specialize_downgrade',
      userResponse: 'declined',
      verdict: 'downgrade_to_maintain',
    });
  });

  it('counts a mesocycle held when the same priority is restated for the next block', async () => {
    await harness.store.putTrainingProgram({
      id: 'prog-1',
      name: 'Autumn',
      createdAt: daysAgo(60),
    });
    for (const [index, id] of ['block-1', 'block-2'].entries()) {
      await harness.store.putTrainingBlock({
        id,
        programId: 'prog-1',
        orderIndex: index,
        name: `Block ${String(index + 1)}`,
        weeksCount: 5,
      });
    }
    const item = { kind: 'muscle', ref: 'chest', level: 'specialize' };
    const first = await harness.invoke('goal.declare_priorities', {
      items: [item],
      blockId: 'block-1',
    });
    const second = await harness.invoke('goal.declare_priorities', {
      items: [item],
      blockId: 'block-2',
    });
    expect((first.priorities as { mesosHeld: number }[])[0].mesosHeld).toBe(0);
    expect(second.priorities).toMatchObject([{ mesosHeld: 1, blockId: 'block-2' }]);
    expect(await harness.store.listPriorities(LOCAL_USER_ID)).toHaveLength(1);
  });

  it('warns when a declaration changes inside a block it already holds', async () => {
    await harness.store.putTrainingProgram({
      id: 'prog-1',
      name: 'Autumn',
      createdAt: daysAgo(30),
    });
    await harness.store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Accumulation',
      weeksCount: 5,
    });
    await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize' }],
      blockId: 'block-1',
    });
    const changed = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'back', level: 'specialize' }],
      blockId: 'block-1',
    });
    expect((changed.warnings as { code: string }[]).map((w) => w.code)).toContain(
      'priority_changed_mid_block',
    );
  });

  it('takes the horizon from the named block when none is given', async () => {
    await harness.store.putTrainingProgram({
      id: 'prog-1',
      name: 'Autumn',
      createdAt: daysAgo(30),
    });
    await harness.store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Accumulation',
      weeksCount: 5,
    });
    const result = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize' }],
      blockId: 'block-1',
    });
    expect(result.priorities).toMatchObject([{ horizonWeeks: 5 }]);
  });
});

describe('goal.propose_targets', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
  });

  it('bands a lift with two matched sessions as a ramp, from a start value read out of history', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const target = await proposeFirstTarget(harness, await declareLift(harness));
    expect(target).toMatchObject({
      metric: 'top_load_at_reps',
      infoLevel: 'ramp',
      basis: 'rp_ramp',
      startValue: 135,
      acceptedBy: null,
    });
    expect(target.stretchValue).toBeGreaterThan(target.committedValue);
    expect(target.committedValue).toBeGreaterThan(135);
    expect(target.rpIds).toContain('rp:rp-s10-underpromise-overdeliver-goal-setting');
  });

  it('bands a lift with one matched session as cold, with no gain claim', async () => {
    await seedLiftHistory(harness.store, { sessionCount: 1, weightLbs: 135, reps: 8 });
    const target = await proposeFirstTarget(harness, await declareLift(harness));
    expect(target).toMatchObject({ infoLevel: 'cold', basis: 'execution_ramp' });
    expect(target.committedValue).toBe(target.stretchValue);
  });

  it('says what it cannot derive rather than banding an invented start value', async () => {
    const proposed = await harness.invoke('goal.propose_targets', {
      priorityId: await declareLift(harness),
    });
    expect(proposed.targets).toEqual([]);
    const skipped = proposed.skipped as { metric: string; reason: string }[];
    expect(skipped.map((entry) => entry.metric)).toContain('top_load_at_reps');
    expect(skipped[0].reason).toMatch(/read from history and never typed/);
  });

  it('re-derives a live proposal in place rather than stacking a second one', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const priorityId = await declareLift(harness);
    const first = await proposeFirstTarget(harness, priorityId);
    const second = await proposeFirstTarget(harness, priorityId);
    expect(second.targetId).toBe(first.targetId);
    const stored = await harness.store.listGoalTargets({ priorityId });
    expect(stored).toHaveLength(1);
  });

  it('never re-offers a declined proposal', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const priorityId = await declareLift(harness);
    const target = await proposeFirstTarget(harness, priorityId);
    await harness.invoke('goal.retire', { targetId: target.targetId, outcome: 'abandoned' });

    const again = await harness.invoke('goal.propose_targets', { priorityId });
    expect(again.targets).toEqual([]);
    const skipped = again.skipped as { metric: string; reason: string }[];
    expect(skipped[0].reason).toMatch(/declined proposal is never re-offered/);
  });

  it('tracks a muscle through the lifts that train it', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    await seedLiftHistory(harness.store, {
      exerciseId: 'cable-fly',
      sessionCount: 2,
      weightLbs: 40,
      reps: 12,
    });
    const declared = await harness.invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'chest', level: 'specialize' }],
      horizonWeeks: 6,
    });
    const proposed = await harness.invoke('goal.propose_targets', {
      priorityId: (declared.priorities as { id: string }[])[0].id,
    });
    expect((proposed.targets as ProposedTargetShape[]).map((t) => t.metric)).toEqual([
      'top_load_at_reps',
      'top_load_at_reps',
    ]);
  });
});

describe('goal.accept_target', () => {
  let harness: Harness;
  let target: ProposedTargetShape;

  beforeEach(async () => {
    harness = setup();
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    target = await proposeFirstTarget(harness, await declareLift(harness));
  });

  it('accepts the coach default as the band drew it', async () => {
    const accepted = await harness.invoke('goal.accept_target', { targetId: target.targetId });
    expect(accepted).toMatchObject({
      acceptedBy: 'coach-default',
      acknowledgedStretch: false,
      bandUnchanged: true,
    });
    expect(accepted.target).toMatchObject({
      committedValue: target.committedValue,
      stretchValue: target.stretchValue,
    });
  });

  it('refuses a committed value past the stretch edge without an acknowledgement', async () => {
    const error = await harness.expectError('goal.accept_target', {
      targetId: target.targetId,
      committedValue: target.stretchValue + 50,
    });
    expect(error.code).toBe('GOAL_TARGET_ABOVE_BAND');
    const stored = await harness.store.listGoalTargets({ userId: LOCAL_USER_ID });
    expect(stored[0].acceptedBy).toBeUndefined();
  });

  it('takes it with the acknowledgement, and leaves the band where it was', async () => {
    const reach = target.stretchValue + 50;
    const accepted = await harness.invoke('goal.accept_target', {
      targetId: target.targetId,
      committedValue: reach,
      acknowledgeStretch: true,
    });
    expect(accepted).toMatchObject({ acceptedBy: 'user', acknowledgedStretch: true });
    expect(accepted.target).toMatchObject({
      committedValue: reach,
      bandLowPctPerWeek: (await harness.store.listGoalTargets({ userId: LOCAL_USER_ID }))[0]
        .bandLowPctPerWeek,
    });
  });

  it('refuses a value short of the committed edge outright', async () => {
    const error = await harness.expectError('goal.accept_target', {
      targetId: target.targetId,
      committedValue: target.startValue,
    });
    expect(error.code).toBe('GOAL_TARGET_BELOW_BAND');
  });

  it('refuses a second acceptance: once accepted, the numbers are fixed', async () => {
    await harness.invoke('goal.accept_target', { targetId: target.targetId });
    const error = await harness.expectError('goal.accept_target', {
      targetId: target.targetId,
      committedValue: target.committedValue + 5,
      acknowledgeStretch: true,
    });
    expect(error.code).toBe('GOAL_TARGET_FIXED');
    const stored = await harness.store.listGoalTargets({ userId: LOCAL_USER_ID });
    expect(stored[0].committedValue).toBe(target.committedValue);
  });

  // The store refuses a second acceptance that MOVES a number. This one moves
  // nothing, so only the tool's own check stands between an accepted target
  // and a silent re-acceptance under different provenance.
  it('refuses a second acceptance even when it repeats the same numbers', async () => {
    await harness.invoke('goal.accept_target', { targetId: target.targetId });
    const error = await harness.expectError('goal.accept_target', {
      targetId: target.targetId,
      committedValue: target.committedValue,
      stretchValue: target.stretchValue,
    });
    expect(error.code).toBe('GOAL_TARGET_FIXED');
    const stored = await harness.store.listGoalTargets({ userId: LOCAL_USER_ID });
    expect(stored[0].acceptedBy).toBe('coach-default');
  });

  it('refuses to re-propose over an accepted target', async () => {
    await harness.invoke('goal.accept_target', { targetId: target.targetId });
    const priorityId = (await harness.store.listPriorities(LOCAL_USER_ID))[0].id;
    const again = await harness.invoke('goal.propose_targets', { priorityId });
    expect(again.targets).toEqual([]);
    expect((again.skipped as { reason: string }[])[0].reason).toMatch(/already accepted/);
  });
});

describe('goal.list, goal.retire and goal.new_chapter', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
  });

  it('lists each priority with the targets derived under it', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const priorityId = await declareLift(harness);
    await proposeFirstTarget(harness, priorityId);
    const listed = await harness.invoke('goal.list');
    const entries = listed.priorities as { priority: { id: string }; targets: unknown[] }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].priority.id).toBe(priorityId);
    expect(entries[0].targets).toHaveLength(1);
  });

  it('cascades a retired priority to its targets, marking them rather than deleting them', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const priorityId = await declareLift(harness);
    const target = await proposeFirstTarget(harness, priorityId);
    await harness.invoke('goal.accept_target', { targetId: target.targetId });

    const retired = await harness.invoke('goal.retire', { priorityId, outcome: 'missed' });
    expect(retired.cascaded).toBe(1);
    expect((retired.targets as { outcome: string }[])[0].outcome).toBe('missed');
    expect(await harness.store.listPriorities(LOCAL_USER_ID)).toEqual([]);
    const kept = await harness.store.listGoalTargets({ priorityId }, { includeRetired: true });
    expect(kept).toHaveLength(1);
    expect(kept[0].retiredAt).toBeDefined();
  });

  it('hides retired rows from goal.list unless they are asked for', async () => {
    const priorityId = await declareLift(harness);
    await harness.invoke('goal.retire', { priorityId, outcome: 'abandoned' });
    expect((await harness.invoke('goal.list')).priorities).toEqual([]);
    expect(
      ((await harness.invoke('goal.list', { includeRetired: true })).priorities as unknown[])
        .length,
    ).toBe(1);
  });

  it('refuses a retire that names both ids or neither', async () => {
    expect((await harness.expectError('goal.retire', { outcome: 'met' })).code).toBe(
      'INVALID_INPUT',
    );
    const both = await harness.expectError('goal.retire', {
      priorityId: 'a',
      targetId: 'b',
      outcome: 'met',
    });
    expect(both.code).toBe('INVALID_INPUT');
  });

  it('stamps a new chapter without moving the accepted numbers', async () => {
    await seedLiftHistory(harness.store, {
      sessionCount: 2,
      weightLbs: 135,
      reps: 8,
      withBaseline: true,
    });
    const target = await proposeFirstTarget(harness, await declareLift(harness));
    await harness.invoke('goal.accept_target', { targetId: target.targetId });
    const reformedAt = daysAgo(1);
    const stamped = await harness.invoke('goal.new_chapter', {
      targetId: target.targetId,
      at: reformedAt,
    });
    expect(stamped.target).toMatchObject({
      newChapterAt: reformedAt,
      committedValue: target.committedValue,
      stretchValue: target.stretchValue,
    });
  });

  it('reports an unknown id as NOT_FOUND', async () => {
    expect((await harness.expectError('goal.new_chapter', { targetId: 'nope' })).code).toBe(
      'NOT_FOUND',
    );
    expect((await harness.expectError('goal.propose_targets', { priorityId: 'nope' })).code).toBe(
      'NOT_FOUND',
    );
  });
});
