// What clears an unrecorded-week banner (VW-504). The banner is not dismissible, so the only
// way it goes away is the lifter recording what actually happened. This pins the one route that
// works for a week already in the past: `plan.week.skip` on a block that is still running.
//
// The clock is pinned to Saturday 2026-09-19 because `plan.week.skip` reads the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localDate } from '../../analytics/training-days.js';
import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import { readTopBanner } from '../read-models/banners.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { registerPlanTools } = await import('../../tools/plan-tools.js');
const { registerPlanScheduleTools } = await import('../../tools/plan-schedule-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

const TODAY = '2026-09-19';
const NOW = '2026-09-19T18:00:00.000Z';
/** The block runs 31 Aug to 27 Sep, so its first week has passed while the block is current. */
const BLOCK_STARTS_ON = '2026-08-31';

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SqliteSessionStore;
let callbacks: Map<string, Callback>;

function register(): void {
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      {
        update: (updates: { callback: Callback }) => callbacks.set(name, updates.callback),
        remove: () => undefined,
      },
    ]),
  );
  const state = { store, exercises: { getById: () => undefined } } as unknown as ServerState;
  const server = {} as Parameters<typeof registerPlanTools>[0];
  registerPlanTools(server, state, placeholders as never);
  registerPlanScheduleTools(server, state, placeholders as never);
}

async function skipWeekOne(mode: 'hold' | 'extend'): Promise<void> {
  const callback = callbacks.get('plan.week.skip');
  if (callback === undefined) throw new Error('no handler for plan.week.skip');
  const result = await callback({ blockId: 'b1', week: 1, mode });
  expect(result.isError ?? false, result.content[0].text).toBe(false);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
  await dateBlock(store, 'b1', BLOCK_STARTS_ON, 4);
  register();
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('plan.week.skip on a week that has already passed', () => {
  it('is accepted while the block is still running', async () => {
    expect(await readTopBanner(store, TODAY, NOW)).not.toBeNull();

    await skipWeekOne('hold');
  });

  it('clears the banner when the lifter records a hold', async () => {
    await skipWeekOne('hold');

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('clears the banner when the lifter records an extend', async () => {
    await skipWeekOne('extend');

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });
});

// Own beforeEach/afterEach, scoped with vi.stubEnv rather than the file's own TZ (America/Denver
// only while these two tests run): a top-of-file `process.env.TZ` write executes at import time,
// before Vitest's run order is settled, and was observed leaking into unrelated sibling test
// files sharing the same worker in CI (see block-calendar-local-time.test.ts for a file that
// pins its own TZ safely, in isolation from any file with async tool registration like this one).
describe('a week is judged passed by the local calendar, not the UTC one', () => {
  /** b1's week 3 (14-20 Sep) and week 4 (21-27 Sep) share a Sunday/Monday boundary. */
  const SUNDAY_NIGHT_DENVER = '2026-09-21T03:00:00.000Z'; // Sun 20 Sep, 9pm in Denver
  const MONDAY_JUST_AFTER_MIDNIGHT_DENVER = '2026-09-21T06:01:00.000Z'; // Mon 21 Sep, 12:01am

  beforeEach(() => {
    vi.stubEnv('TZ', 'America/Denver');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not yet call week 3 passed while Denver still reads Sunday night', async () => {
    const today = localDate(SUNDAY_NIGHT_DENVER);
    expect(today).toBe('2026-09-20');

    expect(await readTopBanner(store, today, SUNDAY_NIGHT_DENVER)).toMatchObject({
      title: 'Week of Mon 31 Aug: nothing recorded',
      subtitle: null,
    });
  });

  it('calls week 3 passed once Denver reads Monday, even by one minute', async () => {
    const today = localDate(MONDAY_JUST_AFTER_MIDNIGHT_DENVER);
    expect(today).toBe('2026-09-21');

    expect(await readTopBanner(store, today, MONDAY_JUST_AFTER_MIDNIGHT_DENVER)).toMatchObject({
      title: '2 planned weeks: nothing recorded',
      subtitle: 'Most recent: week of Mon 14 Sep.',
    });
  });
});
