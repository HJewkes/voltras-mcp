// plan.suggest_progression labels a stale basis and steps down to the re-entry load (VW-907).
//
// End to end over a real in-memory store with the clock fixed, because the age is read from the
// basis session's row. The last case drives `computeProgressionDelta` directly: it never sees the
// age, so the dashboard's session summary, which calls it on the session just finished, is
// untouched. The local-midnight case is in `plan-progression-re-entry-local-time.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import {
  BASIS,
  PLANNED,
  seedBasis,
  seedIntermediate,
  seedPlan,
  suggestProgressionOn,
  toppedOutSet,
} from './fixtures/stale-basis.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError, TrainingMode: {}, TrainingModeNames: {} };
});

const { computeProgressionDelta } = await import('../plan-tools.js');

const NOW = '2026-10-03T12:00:00.000Z';
const DAYS_26 = '2026-09-07T12:00:00.000Z';
const DAYS_40 = '2026-08-24T12:00:00.000Z';
const DAYS_216 = '2026-03-01T12:00:00.000Z';

let store: SessionStore;
let suggest: () => Promise<Record<string, unknown>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  store = openTestStore();
  await seedPlan(store);
  suggest = suggestProgressionOn(store);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('plan.suggest_progression on a stale basis', () => {
  it('labels a 26-day-old basis stale and steps down to 0.8 x the top load', async () => {
    await seedBasis(store, { startedAt: DAYS_26 });

    const suggestion = await suggest();

    expect(suggestion.lastTime).toEqual({ startedAt: DAYS_26, daysAgo: 26, stale: true });
    // 0.8 x 135 = 108, rounded down to 105.
    expect(suggestion.reEntry).toEqual({
      band: 'short',
      loadLbs: 105,
      loadFactor: 0.8,
      source: 'Nuckols 2022',
    });
    expect(suggestion).toMatchObject({ delta: -30, repDelta: 0, basis: 'fixed' });
    expect(suggestion.reasoning).toContain('26 days ago');
  });

  it('scales a medium break to one third of the top load', async () => {
    await seedBasis(store, { startedAt: DAYS_40 });

    const suggestion = await suggest();

    expect(suggestion.lastTime).toMatchObject({ daysAgo: 40, stale: true });
    expect(suggestion.reEntry).toMatchObject({ band: 'medium', loadLbs: 45 });
    expect(suggestion.delta).toBe(-90);
  });

  it('holds after a long break, adds nothing, and points at the starting prescription', async () => {
    await seedBasis(store, { startedAt: DAYS_216 });

    const suggestion = await suggest();

    expect(suggestion.lastTime).toMatchObject({ daysAgo: 216, stale: true });
    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion).toMatchObject({ delta: 0, repDelta: 0, basis: 'fixed' });
    expect(suggestion.reasoning).toContain('hold');
    expect(suggestion.reasoning).toContain('profile.get_starting_prescription');
  });

  it('holds a stale basis that recorded no load instead of progressing off it', async () => {
    await seedBasis(store, { startedAt: DAYS_26, weightLbs: null });

    const suggestion = await suggest();

    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion).toMatchObject({ delta: 0, repDelta: 0 });
    expect(suggestion.reasoning).toContain('no load to scale');
  });

  it('never unlocks a set on a stale basis, even for an intermediate who topped out hard', async () => {
    await seedIntermediate(store);
    await seedBasis(store, { startedAt: DAYS_40, hard: true });

    const suggestion = await suggest();

    expect(suggestion.tier).toMatchObject({ tier: 'intermediate' });
    expect(suggestion.gates).toMatchObject({ effort: 'hard', setsUnlocked: false });
    expect(suggestion.reasoning).not.toContain('+1 set');
  });

  it('re-enters a light lift at 5 lb, never at 0', async () => {
    // One third of 10 lb is 3.3 lb, which rounds down to 0.
    await seedBasis(store, { startedAt: DAYS_40, weightLbs: 10 });

    const suggestion = await suggest();

    expect(suggestion.reEntry).toMatchObject({ band: 'medium', loadLbs: 5 });
    expect(suggestion.delta).toBe(-5);
    expect(suggestion.reasoning).toContain('from 10 lb to 5 lb');
  });

  it('holds a lift already at 5 lb rather than raising it to the floor', async () => {
    await seedBasis(store, { startedAt: DAYS_26, weightLbs: 5 });

    const suggestion = await suggest();

    expect(suggestion.reEntry).toMatchObject({ loadLbs: 5 });
    expect(suggestion.delta).toBe(0);
  });

  it('leaves a 10-day-old basis unchanged apart from its age', async () => {
    await seedBasis(store, { startedAt: '2026-09-23T12:00:00.000Z' });

    const suggestion = await suggest();

    expect(suggestion.lastTime).toEqual({
      startedAt: '2026-09-23T12:00:00.000Z',
      daysAgo: 10,
      stale: false,
    });
    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion).toMatchObject({ delta: 5, repDelta: 0 });
    expect(suggestion.reasoning).not.toContain('Last time');
  });
});

describe('computeProgressionDelta stays store-free', () => {
  it('suggests from the sets alone, with no age and no re-entry, however old they are', () => {
    const sets = [1, 2, 3].map((n) => toppedOutSet(n, { startedAt: DAYS_26 }));

    const suggestion = computeProgressionDelta(PLANNED, sets, BASIS);

    expect(suggestion.delta).toBe(5);
    expect(suggestion).not.toHaveProperty('lastTime');
    expect(suggestion).not.toHaveProperty('reEntry');
  });
});
