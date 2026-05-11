// Unit tests for the per-slot CoercionWatch ledger.
//
// Window semantics, eviction, sweep, and the exact-match-no-op contract are
// all pinned here so the bridge integration tests (event-bridge.test.ts) can
// rely on the same behavior without re-asserting it.

import { describe, expect, it } from 'vitest';

import {
  COERCION_WINDOW_MS,
  CoercionWatch,
  trackedSetterCall,
  type PendingCoercionCheck,
} from '../coercion-watch.js';

function makeCheck(overrides: Partial<PendingCoercionCheck> = {}): PendingCoercionCheck {
  return {
    setterName: 'device.set_eccentric',
    field: 'eccentricPercentTenths',
    requested: 0,
    setterReturnedAt: 1_000_000,
    ...overrides,
  };
}

describe('CoercionWatch.observe', () => {
  it('returns the pending check and clears it when device value differs within the window', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ requested: 0 }));
    const now = 1_000_500; // 500ms after setter returned
    const hit = watch.observe('eccentricPercentTenths', 320, now);
    expect(hit).not.toBeNull();
    expect(hit?.requested).toBe(0);
    expect(hit?.setterName).toBe('device.set_eccentric');
    expect(watch.size()).toBe(0);
  });

  it('returns null and clears the check on an exact device echo (no event)', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ requested: 500 }));
    const hit = watch.observe('eccentricPercentTenths', 500, 1_000_100);
    expect(hit).toBeNull();
    // Exact echo is treated as success — the check is cleared so a later
    // coerced state-dump in a different burst can't double-fire.
    expect(watch.size()).toBe(0);
  });

  it('returns null when no pending check exists for the field', () => {
    const watch = new CoercionWatch();
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_100);
    expect(hit).toBeNull();
  });

  it('returns null and sweeps the check when the window has elapsed', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ setterReturnedAt: 1_000_000 }));
    const expiredNow = 1_000_000 + COERCION_WINDOW_MS; // exactly at boundary => expired
    const hit = watch.observe('eccentricPercentTenths', 320, expiredNow);
    expect(hit).toBeNull();
    expect(watch.size()).toBe(0);
  });

  it('observes only the field passed in; other pending checks are untouched', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeCheck({ field: 'eccentricPercentTenths', requested: 0, setterReturnedAt: 1_000_000 }),
    );
    watch.register(
      makeCheck({
        field: 'chainTargetForceTenths',
        requested: 100,
        setterName: 'device.set_chains',
        setterReturnedAt: 1_000_000,
      }),
    );
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_200);
    expect(hit?.field).toBe('eccentricPercentTenths');
    expect(watch.size()).toBe(1); // chain check still pending
  });
});

describe('CoercionWatch.register', () => {
  it('evicts a prior pending check on the same field (newest setter wins)', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ requested: 50, setterReturnedAt: 1_000_000, setterName: 'first' }));
    watch.register(
      makeCheck({ requested: 100, setterReturnedAt: 1_000_300, setterName: 'second' }),
    );
    expect(watch.size()).toBe(1);
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_500);
    expect(hit?.requested).toBe(100);
    expect(hit?.setterName).toBe('second');
  });

  it('keeps checks for distinct fields independent', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ field: 'a', requested: 1 }));
    watch.register(makeCheck({ field: 'b', requested: 2 }));
    expect(watch.size()).toBe(2);
  });
});

describe('CoercionWatch.sweep', () => {
  it('drops only checks older than the window', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ field: 'old', setterReturnedAt: 1_000_000 }));
    watch.register(makeCheck({ field: 'fresh', setterReturnedAt: 1_002_000 }));
    watch.sweep(1_000_000 + COERCION_WINDOW_MS + 1);
    expect(watch.size()).toBe(1);
    // The fresh check is still observable.
    const hit = watch.observe('fresh', 99, 1_002_100);
    expect(hit).not.toBeNull();
  });

  it('is a no-op when no checks are pending', () => {
    const watch = new CoercionWatch();
    expect(() => watch.sweep(1_000_000)).not.toThrow();
    expect(watch.size()).toBe(0);
  });
});

describe('CoercionWatch.clear', () => {
  it('drops every pending check regardless of age', () => {
    const watch = new CoercionWatch();
    watch.register(makeCheck({ field: 'a' }));
    watch.register(makeCheck({ field: 'b' }));
    watch.clear();
    expect(watch.size()).toBe(0);
  });
});

describe('trackedSetterCall', () => {
  it('awaits fn() and registers one check per field on success', async () => {
    const watch = new CoercionWatch();
    const result = await trackedSetterCall(
      watch,
      'device.start_guided_load',
      [
        { field: 'weightLbsTenths', requested: 50 },
        { field: 'chainTargetForceTenths', requested: 100 },
        { field: 'eccentricPercentTenths', requested: 500 },
      ],
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(watch.size()).toBe(3);
  });

  it('propagates rejection without registering any check', async () => {
    const watch = new CoercionWatch();
    const boom = new Error('write failed');
    await expect(
      trackedSetterCall(
        watch,
        'device.set_eccentric',
        [{ field: 'eccentricPercentTenths', requested: 0 }],
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(watch.size()).toBe(0);
  });

  it('is a silent passthrough when watch is undefined', async () => {
    const result = await trackedSetterCall(
      undefined,
      'device.set_eccentric',
      [{ field: 'eccentricPercentTenths', requested: 0 }],
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  it('stamps every registered check with the same setterReturnedAt', async () => {
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'bilateral.cascade',
      [
        { field: 'weightLbsTenths', requested: 50 },
        { field: 'chainTargetForceTenths', requested: 100 },
      ],
      async () => undefined,
    );
    // Both checks observed at the same `now` must match within the window
    // because they share the setterReturnedAt.
    const observedNow = Date.now() + 100;
    expect(watch.observe('weightLbsTenths', 99, observedNow)).not.toBeNull();
    expect(watch.observe('chainTargetForceTenths', 20, observedNow)).not.toBeNull();
  });
});
