// What clears an unrecorded-week banner (VW-504). The banner is not dismissible, so the only
// way it goes away is the lifter recording what actually happened. This pins the one route that
// works for a week already in the past: `plan.week.skip` on a block that is still running.
//
// The clock is pinned to Saturday 2026-09-19 because `plan.week.skip` reads the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
