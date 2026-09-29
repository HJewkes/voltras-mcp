// report.weekly reads the tier signal as of the report's instant (VW-575).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import type * as TierSignalModule from '../tier-signal.js';

const tierReads = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('../tier-signal.js', async (importOriginal) => {
  const original = await importOriginal<typeof TierSignalModule>();
  return {
    ...original,
    getTierSignal: (...args: Parameters<typeof original.getTierSignal>) => {
      tierReads.calls.push(args.slice(1));
      return original.getTierSignal(...args);
    },
  };
});

const { buildWeeklyReport } = await import('../report-tools.js');

describe('report.weekly tier signal', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tierReads.calls.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Base',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
  });

  it('reads the tier as of the pinned week end, not the wall clock', async () => {
    const to = '2026-09-14T00:00:00.000Z';

    await buildWeeklyReport({ store, config: { adapter: 'mock' } } as unknown as ServerState, {
      from: '2026-09-07T00:00:00.000Z',
      to,
    });

    expect(tierReads.calls).toHaveLength(1);
    expect(tierReads.calls[0]?.[1]).toBe(to);
  });
});
