// A basis session that crosses local midnight is dated by its training day, not its start
// (VW-907). Run west of UTC: under UTC the session below starts and ends on one date, so a
// start-dated age would pass. The zone is pinned before any Date is constructed.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { seedBasis, seedPlan, suggestProgressionOn } from './fixtures/stale-basis.js';

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

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

let store: SessionStore;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 06:00 on 2026-10-03, Denver time.
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  store = openTestStore();
  await seedPlan(store);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('plan.suggest_progression basis age in local time', () => {
  it('dates a session from 23:30 to 00:30 by the day it ended, as next_workout does', async () => {
    // 23:30 on 2026-09-06 to 00:30 on 2026-09-07, Denver time: training day 2026-09-07.
    await seedBasis(store, {
      startedAt: '2026-09-07T05:30:00.000Z',
      endedAt: '2026-09-07T06:30:00.000Z',
    });

    const suggestion = await suggestProgressionOn(store)();

    expect(suggestion.lastTime).toEqual({
      startedAt: '2026-09-07T05:30:00.000Z',
      daysAgo: 26,
      stale: true,
    });
  });
});
