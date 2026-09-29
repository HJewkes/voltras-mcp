// The caller-owned `store.transaction(fn)` (VW-658, VW-512 S2).
//
// Store calls awaited inside `fn` join as savepoints and commit or roll back with it. Callers
// queue first-in first-out, and a store call from outside the owner's async context throws
// rather than joining. Every row is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../logger.js';
import { TRANSACTION_STALL_WARN_MS } from '../sqlite-store.js';
import { LOCAL_USER_ID, type StoredSet } from '../types.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

const AT = '2026-09-20T18:00:00.000Z';

let store: SessionStore;

function setWithId(id: string): StoredSet {
  return {
    id,
    sessionId: 'sess-1',
    userId: LOCAL_USER_ID,
    startedAt: AT,
    endedAt: AT,
    partial: false,
    weightLbs: 40,
    reps: [],
  };
}

function declareMaintenance(): Promise<unknown> {
  return store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'maintenance',
    startedAt: '2026-09-01T00:00:00.000Z',
    declaredAt: AT,
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function persisted(setId: string): Promise<{ set: boolean; dietPhases: number }> {
  return {
    set: (await store.getSet(setId)) !== undefined,
    dietPhases: (await store.listDietPhases(LOCAL_USER_ID)).length,
  };
}

beforeEach(async () => {
  store = openTestStore();
  await store.putSession({ id: 'sess-1', startedAt: AT });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await store.close();
});

describe('store.transaction', () => {
  it('commits a set and a diet phase written inside it together', async () => {
    const result = await store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      await declareMaintenance();
      return 'done';
    });

    expect(result).toBe('done');
    expect(await persisted('set-a')).toEqual({ set: true, dietPhases: 1 });
  });

  it('rolls both writes back when fn throws after they land', async () => {
    const run = store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      await declareMaintenance();
      throw new Error('caller failed');
    });

    await expect(run).rejects.toThrow('caller failed');
    expect(await persisted('set-a')).toEqual({ set: false, dietPhases: 0 });
  });

  it('keeps the outer writes when the caller catches a nested throw', async () => {
    await store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      const inner = store.transaction(async () => {
        await declareMaintenance();
        throw new Error('inner failed');
      });
      await expect(inner).rejects.toThrow('inner failed');
      await store.putSet(setWithId('set-b'));
    });

    expect(await persisted('set-a')).toEqual({ set: true, dietPhases: 0 });
    expect(await store.getSet('set-b')).toBeDefined();
  });

  it('nests a transaction inside a nested one, in sequence', async () => {
    await store.transaction(() =>
      store.transaction(() => store.transaction(() => store.putSet(setWithId('set-a')))),
    );

    expect(await store.getSet('set-a')).toBeDefined();
  });

  it('refuses a nested transaction opened beside one still open, and keeps the first', async () => {
    const settled = await store.transaction(() =>
      Promise.allSettled([
        store.transaction(async () => {
          await store.putSet(setWithId('set-a'));
          await nextTurn();
        }),
        store.transaction(() => store.putSet(setWithId('set-b'))),
      ]),
    );

    expect(settled[0].status).toBe('fulfilled');
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'STORE_TRANSACTION_OVERLAP' },
    });
    expect(await store.getSet('set-a')).toBeDefined();
    expect(await store.getSet('set-b')).toBeUndefined();
  });

  it('does not commit before fn resolves: a second connection sees nothing until then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vmcp-caller-tx-'));
    const writer = openTestStore({ path: join(dir, 'store.sqlite') });
    await writer.putSession({ id: 'sess-1', startedAt: AT });
    const reader = openTestStore({ path: join(dir, 'store.sqlite') });
    try {
      await writer.transaction(async () => {
        await writer.putSet(setWithId('set-a'));
        await nextTurn();
        expect(await reader.getSet('set-a')).toBeUndefined();
      });
      expect(await reader.getSet('set-a')).toBeDefined();
    } finally {
      await reader.close();
      await writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serialises two concurrent transactions instead of interleaving them', async () => {
    const order: string[] = [];
    const inTurn = (label: string, setId: string) => async () => {
      order.push(`${label} start`);
      await store.putSet(setWithId(setId));
      await nextTurn();
      order.push(`${label} end`);
    };

    await Promise.all([
      store.transaction(inTurn('first', 'set-a')),
      store.transaction(inTurn('second', 'set-b')),
    ]);

    expect(order).toEqual(['first start', 'first end', 'second start', 'second end']);
    expect(await store.getSet('set-b')).toBeDefined();
  });

  it('keeps the queue moving after a transaction throws', async () => {
    const failed = store.transaction(() => Promise.reject(new Error('first failed')));
    const next = store.transaction(async () => {
      await store.putSet(setWithId('set-b'));
      return 'ran';
    });

    await expect(failed).rejects.toThrow('first failed');
    expect(await next).toBe('ran');
  });
});

describe('store.transaction foreign-access guard', () => {
  it('throws for a write scheduled outside the transaction that fires while it is open', async () => {
    const foreign = new Promise<unknown>((resolve) => {
      setImmediate(() => resolve(store.putSet(setWithId('set-foreign')).catch((err) => err)));
    });

    await store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      await nextTurn();
    });

    expect(await foreign).toMatchObject({ code: 'STORE_TRANSACTION_BUSY' });
    expect(await store.getSet('set-a')).toBeDefined();
    expect(await store.getSet('set-foreign')).toBeUndefined();
  });

  it('throws for a foreign read too, so no one outside sees rows that may roll back', async () => {
    const foreign = new Promise<unknown>((resolve) => {
      setImmediate(() => resolve(store.getSet('set-a').catch((err) => err)));
    });

    await store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      await nextTurn();
    });

    expect(await foreign).toMatchObject({ code: 'STORE_TRANSACTION_BUSY' });
  });

  it('lets a timer the owner schedules and awaits join the transaction', async () => {
    const run = store.transaction(async () => {
      await new Promise((resolve) => setImmediate(() => resolve(declareMaintenance())));
      await store.putSet(setWithId('set-a'));
      throw new Error('caller failed');
    });

    await expect(run).rejects.toThrow('caller failed');
    expect(await persisted('set-a')).toEqual({ set: false, dietPhases: 0 });
  });

  it('lets a foreign caller in once the transaction has closed', async () => {
    await store.transaction(() => store.putSet(setWithId('set-a')));

    await store.putSet(setWithId('set-b'));

    expect(await store.getSet('set-b')).toBeDefined();
  });
});

describe('store.transaction yield sentinel', () => {
  it('warns once when the transaction spans event-loop turns', async () => {
    const warn = vi.spyOn(log, 'warn');

    await store.transaction(async () => {
      await nextTurn();
      await nextTurn();
    });
    await nextTurn();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('event-loop turn');
  });

  it('stays quiet when fn awaits only the store', async () => {
    const warn = vi.spyOn(log, 'warn');

    await store.transaction(async () => {
      await store.putSet(setWithId('set-a'));
      await declareMaintenance();
    });
    await nextTurn();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('store.transaction stall sentinel', () => {
  function stallWarnings(warn: ReturnType<typeof vi.spyOn>): number {
    return warn.mock.calls.filter((call) => String(call[0]).includes('still open')).length;
  }

  it('warns once when fn is still open past the stall limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(log, 'warn');
    let markOpen!: () => void;
    let finish!: () => void;
    const opened = new Promise<void>((resolve) => (markOpen = resolve));
    const run = store.transaction(() => {
      markOpen();
      return new Promise<void>((resolve) => (finish = resolve));
    });
    await opened;

    await vi.advanceTimersByTimeAsync(TRANSACTION_STALL_WARN_MS - 1);
    expect(stallWarnings(warn)).toBe(0);
    await vi.advanceTimersByTimeAsync(TRANSACTION_STALL_WARN_MS * 2);
    expect(stallWarnings(warn)).toBe(1);

    finish();
    await run;
  });

  it('stays quiet about a transaction that closed before the limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(log, 'warn');

    await store.transaction(() => store.putSet(setWithId('set-a')));
    await vi.advanceTimersByTimeAsync(TRANSACTION_STALL_WARN_MS * 2);

    expect(stallWarnings(warn)).toBe(0);
  });
});
