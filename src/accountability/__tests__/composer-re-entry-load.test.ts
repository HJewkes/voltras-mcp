// The load a coach message states after a break (VW-977): the planned load while the lifter is
// training, the re-entry load from a short break on. Most cases run through
// `accountability.preview`, so the read has to travel from `plan.next_workout` into the copy.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { COACH_FRAGMENTS, validateFragment } from '../../coach-copy/fragments.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { describeAccountabilityPreview } from '../../tools/accountability-tools.js';
import type { ReEntryResult } from '../../tools/re-entry-read.js';
import { composeMissRecovery, type MissRecoveryInput } from '../composer.js';
import { assertCopyRules } from './copy-rules.js';

const THURSDAY_NOON = '2026-09-17T12:00:00';
const PLANNED_LBS = 170;

const HELD = `load held at ${PLANNED_LBS} lb`;
const returnClause = (lbs: number): string =>
  `, starting at ${lbs} lb, lighter on purpose after a break`;

let store: SessionStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(THURSDAY_NOON));
  store = openTestStore();
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

function makeState(): ServerState {
  return {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
}

async function seedPlan(): Promise<void> {
  await store.putTrainingProgram({
    id: 'prog',
    name: 'Base',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B1',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0 });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Full A', orderIndex: 0 });
  await store.putPlannedExercise({
    id: 'planned-row',
    workoutTemplateId: 'tpl',
    exerciseId: 'cable row',
    orderIndex: 0,
    targetSets: 3,
    targetWeightLbs: PLANNED_LBS,
  });
}

async function seedMiss(): Promise<void> {
  await store.putAccountabilityState({
    userId: LOCAL_USER_ID,
    state: 'missed',
    enteredAt: '2026-09-14T12:00:00',
    consecutiveMisses: 1,
    ghostSends: [],
    lastInboundAt: null,
    proactiveSends: [],
    holdingUntil: null,
  });
}

/** The miss-recovery text on a Thursday, for a lifter who trained on exactly these days. */
async function previewAfterTraining(days: readonly string[]): Promise<string> {
  await seedPlan();
  await seedMiss();
  for (const day of days) {
    await seedTrainingDay(store, {
      id: `trained-${day}`,
      startedAt: `${day}T12:00:00`,
      endedAt: `${day}T12:30:00`,
    });
  }
  const result = await describeAccountabilityPreview(makeState(), { at: THURSDAY_NOON });
  expect(result.kind).toBe('miss_recovery');
  return result.text ?? '';
}

describe('the load a miss-recovery offer states', () => {
  it.each([
    ['a 3-day gap', '2026-09-14'],
    ['a 14-day gap, the last day that changes nothing', '2026-09-03'],
  ])('holds the planned load after %s', async (_label, lastDay) => {
    const text = await previewAfterTraining([lastDay]);

    expect(text).toContain(`, ${HELD}`);
    expect(text).not.toContain('lighter on purpose');
  });

  it.each([
    ['a 15-day gap (short)', '2026-09-02', 135],
    ['a 30-day gap (medium)', '2026-08-18', 55],
  ])('states the lighter return load after %s', async (_label, lastDay, expectedLbs) => {
    const text = await previewAfterTraining([lastDay]);

    expect(text).toContain(returnClause(expectedLbs));
    expect(text).not.toContain(HELD);
    expect(() => assertCopyRules(text)).not.toThrow();
  });

  it('keeps the return load inside the window after the first session back', async () => {
    const text = await previewAfterTraining(['2026-07-01', '2026-09-16']);

    expect(text).toContain(returnClause(55));
  });

  it('holds the planned load once the return window has ended', async () => {
    // Back on 08-20, so the two-week window closed on 09-02.
    const text = await previewAfterTraining([
      '2026-06-01',
      '2026-08-20',
      '2026-09-03',
      '2026-09-14',
    ]);

    expect(text).toContain(HELD);
  });

  it('states no load after a break too long to scale one', async () => {
    const text = await previewAfterTraining(['2026-01-05']);

    expect(text).toContain('plus one accessory, because');
    expect(text).not.toContain(`${PLANNED_LBS} lb`);
  });

  it('holds the planned load when no training day is logged', async () => {
    const text = await previewAfterTraining([]);

    expect(text).toContain(HELD);
  });

  it.each([
    ['3 days', '2026-09-14'],
    ['30 days', '2026-08-18'],
    ['over six months', '2026-01-05'],
  ])('books the re-entry no more than 1 day out after %s', async (_label, lastDay) => {
    const text = await previewAfterTraining([lastDay]);

    expect(text).toContain('smaller than the plan asks for: Friday,');
    expect(text).toContain('goes on the plan for Friday,');
  });
});

describe('the load a session offered during a hold states', () => {
  const reEntry: ReEntryResult = {
    phase: 'in_gap',
    daysSinceLastTrainingDay: 30,
    band: 'medium',
    windowEndsOn: '2026-09-30',
    rule: { loadFactor: 1 / 3, weeks: 2, source: 'synthetic' },
  };
  const input: MissRecoveryInput = {
    lifterName: 'Harrison',
    missed: { plannedDay: 'Monday', fallbackDay: 'Wednesday', exerciseNames: ['cable row'] },
    nextWorkout: {
      templateName: 'Full A',
      exercises: [{ name: 'cable row', targetWeightLbs: PLANNED_LBS }],
    },
    reEntryDay: 'Friday',
    holding: { active: true },
    reEntry,
  };

  it('states the lighter return load', () => {
    const message = composeMissRecovery(input);

    expect(message.kind).toBe('holding_acknowledgement');
    expect(message.text).toContain(returnClause(55));
    expect(() => assertCopyRules(message.text)).not.toThrow();
  });

  it('states no load when the lead exercise has none planned', () => {
    const nextWorkout = { templateName: 'Full A', exercises: [{ name: 'cable row' }] };

    const { text } = composeMissRecovery({ ...input, nextWorkout });

    expect(text).not.toContain(' lb');
  });
});

describe('the return load fragment', () => {
  const fragment = COACH_FRAGMENTS.find(({ id }) => id === 'composer.load-clause-return');

  it('is registered with a valid source', () => {
    expect(fragment).toBeDefined();
    expect(validateFragment(fragment!)).toEqual([]);
  });

  it('carries no day count', () => {
    expect(fragment?.text).not.toMatch(/\bdays?\b|\{\{days/i);
  });
});
