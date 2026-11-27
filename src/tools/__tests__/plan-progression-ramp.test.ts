// plan.suggest_progression after a break (VW-988): the precedence of the three load rules on one
// lifter's history. Inside the return window the re-entry load wins, then the climb-back ramp,
// then the plain progression off the basis session. The plain progression is the tier VW-620's
// block-start basis will take its place in.
//
// One history, read at three dates: a 150 lb bench before a 12-week break, then sessions every
// three days at the load the rules give. Each case seeds only the sessions before its own date,
// because the basis is the latest session for the lift.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { seedPlan, suggestProgressionOn, toppedOutSet } from './fixtures/stale-basis.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const BACK = '2026-03-02';
const PRE_BREAK_LBS = 150;
const GAP_DAYS = 84;
/** The medium window's load, then the six ramp weeks from the first day after the window. */
const WINDOW_LBS = 50;
const RAMP_LBS = [65, 80, 100, 115, 130, 150];

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The load the lifter actually lifted on `day`: what the rules prescribed for it. */
function loadOn(dayBack: number): number {
  if (dayBack < 0) return PRE_BREAK_LBS;
  if (dayBack < 14) return WINDOW_LBS;
  return RAMP_LBS[Math.floor((dayBack - 14) / 7)] ?? PRE_BREAK_LBS;
}

async function seedSession(store: SessionStore, dayBack: number): Promise<void> {
  const sessionId = `sess-${String(dayBack)}`;
  const startedAt = `${addDays(BACK, dayBack)}T12:00:00.000Z`;
  await store.putSession({ kind: 'training', id: sessionId, startedAt, endedAt: startedAt });
  for (const n of [1, 2, 3]) {
    const set = toppedOutSet(n, { startedAt, weightLbs: loadOn(dayBack) });
    const id = `${sessionId}-${set.id}`;
    const reps = set.reps.map((rep) => ({ ...rep, id: `${id}-${String(rep.index)}`, setId: id }));
    await store.putSet({ ...set, id, sessionId, reps, userId: LOCAL_USER_ID });
  }
}

/** Every session of the one history before `dayBack`. */
async function seedHistoryBefore(store: SessionStore, dayBack: number): Promise<void> {
  for (const before of [-GAP_DAYS - 6, -GAP_DAYS - 3, -GAP_DAYS]) await seedSession(store, before);
  for (let day = 0; day < dayBack; day += 3) await seedSession(store, day);
}

let store: SessionStore;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  store = openTestStore();
  await seedPlan(store);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function suggestOn(dayBack: number): Promise<Record<string, unknown>> {
  await seedHistoryBefore(store, dayBack);
  vi.setSystemTime(new Date(`${addDays(BACK, dayBack)}T18:00:00.000Z`));
  return suggestProgressionOn(store)();
}

describe('plan.suggest_progression precedence after a break', () => {
  it('holds at the window load inside the return window, over the ramp and the plain step', async () => {
    const suggestion = await suggestOn(9);

    expect(suggestion.lastTime).toMatchObject({ stale: false });
    expect(suggestion.reEntry).toMatchObject({ band: 'medium', loadLbs: WINDOW_LBS });
    expect(suggestion).not.toHaveProperty('returnRamp');
    expect(suggestion).toMatchObject({ delta: 0, repDelta: 0, basis: 'fixed' });
    expect(suggestion.gates).toMatchObject({ setsUnlocked: false });
  });

  it('climbs to the ramp week load after the window, over the plain step', async () => {
    // Day 28 is ramp week 3; the basis is day 27, lifted at week 2's load.
    const suggestion = await suggestOn(28);

    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion.returnRamp).toMatchObject({
      week: 3,
      weeks: 6,
      loadLbs: 100,
      preBreakLoadLbs: PRE_BREAK_LBS,
    });
    expect(suggestion.delta).toBe(100 - 80);
    expect(suggestion.reasoning).toContain('week 3 of 6');
    expect(suggestion.reasoning).not.toMatch(/\d+[\s_-]*days?\b/i);
  });

  it('falls back to the plain progression once the ramp has ended', async () => {
    const suggestion = await suggestOn(14 + 6 * 7 + 1);

    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion).not.toHaveProperty('returnRamp');
    expect(suggestion.delta).toBe(5);
  });
});
