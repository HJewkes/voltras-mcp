// The swap gate's verdicts (VW-622), read through the real `history.trend` fit and flatline
// rule (workout-analytics unmocked) over synthetic weekly top loads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { readSwapCheck, isMidBlock } = await import('../plan-swap-check.js');

import type { ServerState } from '../../state/server-state.js';
import type { StoredSet } from '../../store/types.js';

const EDIT = { outgoingExerciseId: 'back-squat', incomingExerciseId: 'hack-squat' };

function weekStart(n: number): string {
  const ms = Date.parse('2026-07-06T12:00:00.000Z') + n * 7 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function makeSet(index: number, weightLbs: number): StoredSet {
  const startedAt = weekStart(index);
  const rep = (n: number) => ({
    id: `s-${index}-rep-${n}`,
    setId: `s-${index}`,
    index: n,
    repNumber: n + 1,
    concentric: { samples: [], peakVelocity: 0.5 },
    eccentric: { samples: [], peakVelocity: 0.5 },
  });
  return {
    id: `s-${index}`,
    sessionId: `sess-${index}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs,
    exerciseId: 'back-squat',
    reps: [rep(0), rep(1)],
  } as unknown as StoredSet;
}

function stateWith(loads: number[]): ServerState {
  const sets = loads.map((load, i) => makeSet(i, load));
  const store = {
    getSetsForExercise: vi.fn(async () => sets),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    getDietPhaseCovering: vi.fn(async () => undefined),
    chapterStartedAt: vi.fn(async () => null),
  };
  return {
    store,
    exercises: { getById: vi.fn(() => undefined) },
    config: { adapter: 'node' },
  } as unknown as ServerState;
}

/** The text with its cited rp ids removed, so a ratio claim cannot hide behind a citation. */
function prose(text: string): string {
  return text.replace(/rp:[a-z0-9-]+/g, '');
}

describe('readSwapCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells a lifter whose lift is still climbing to finish the block', async () => {
    const check = await readSwapCheck(stateWith([100, 105, 110, 115, 120]), EDIT);

    expect(check.trend).toBe('progressing');
    expect(check.advice).toBe('finish_block');
    expect(check.text).toMatch(/Finish the block/);
    expect(check.text).toMatch(/Boredom is not grounds/);
  });

  it('supports the swap off a lift on an open flatline', async () => {
    const check = await readSwapCheck(stateWith([100, 100, 100, 100]), EDIT);

    expect(check.trend).toBe('flat');
    expect(check.advice).toBe('swap_supported');
    expect(check.text).toMatch(/swap to hack-squat is supported/);
  });

  it('supports the swap off a declining lift', async () => {
    const check = await readSwapCheck(stateWith([120, 115, 110, 105, 100]), EDIT);

    expect(check.trend).toBe('declining');
    expect(check.advice).toBe('swap_supported');
  });

  it('names the novelty window on a supported swap without giving it a session count', async () => {
    const check = await readSwapCheck(stateWith([100, 100, 100, 100]), EDIT);

    expect(check.text).toMatch(/first sessions to read better than they are/);
    expect(check.text).not.toMatch(/\d+\s+sessions/);
  });

  it('judges nothing from a lift with under two weeks of history', async () => {
    const check = await readSwapCheck(stateWith([100, 110]), EDIT);

    expect(check.trend).toBe('too_little_history');
    expect(check.advice).toBe('no_trend_to_judge');
    expect(check.slopeLbsPerWeek).toBeNull();
  });

  it('judges nothing from a lift with no working sets at all', async () => {
    const check = await readSwapCheck(stateWith([]), EDIT);

    expect(check.trend).toBe('too_little_history');
  });

  it('never states a stimulus-to-fatigue figure in any verdict', async () => {
    const series = [[100, 105, 110, 115, 120], [100, 100, 100, 100], [100, 110], []];
    for (const loads of series) {
      const check = await readSwapCheck(stateWith(loads), EDIT);
      expect(prose(check.text)).not.toMatch(/SFR|stimulus.to.fatigue/i);
    }
  });
});

describe('isMidBlock', () => {
  function storeWith(trained: Record<string, boolean>) {
    const templates = Object.keys(trained).map((id) => ({ id, weekId: 'w1' }));
    return {
      getWorkoutTemplate: vi.fn(async (id: string) => templates.find((t) => t.id === id)),
      getTrainingWeek: vi.fn(async () => ({ id: 'w1', blockId: 'b1' })),
      getTrainingWeeksForBlock: vi.fn(async () => [{ id: 'w1' }]),
      getWorkoutTemplatesForWeek: vi.fn(async () => templates),
      getAssignmentsForTemplate: vi.fn(async (id: string) => (trained[id] ? [{ id: 'a' }] : [])),
    } as unknown as Parameters<typeof isMidBlock>[0];
  }

  it('reads a block with one workout trained and one left as under way', async () => {
    expect(await isMidBlock(storeWith({ a: true, b: false }), 'a')).toBe(true);
  });

  it('reads a block nobody has trained yet as not under way', async () => {
    expect(await isMidBlock(storeWith({ a: false, b: false }), 'a')).toBe(false);
  });

  it('reads a fully trained block as not under way', async () => {
    expect(await isMidBlock(storeWith({ a: true, b: true }), 'a')).toBe(false);
  });
});
