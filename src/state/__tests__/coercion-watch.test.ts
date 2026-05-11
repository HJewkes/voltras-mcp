// Unit tests for the per-slot CoercionWatch ledger.
//
// Window semantics, per-check `windowMs` overrides, the stability-counter
// transient filter, the `exact` vs `guard` mode contract, eviction, sweep,
// and trackedSetterCall wiring are all pinned here so the bridge
// integration tests (event-bridge.test.ts) can rely on the same behavior
// without re-asserting it.

import { describe, expect, it } from 'vitest';

import {
  COERCION_WINDOW_MS,
  COERCION_WINDOW_MS_GUIDED_LOAD,
  CoercionWatch,
  trackedSetterCall,
  type PendingCoercionRegister,
} from '../coercion-watch.js';

function makeRegister(overrides: Partial<PendingCoercionRegister> = {}): PendingCoercionRegister {
  return {
    setterName: 'device.set_eccentric',
    field: 'eccentricPercentTenths',
    requested: 0,
    setterReturnedAt: 1_000_000,
    ...overrides,
  };
}

describe('CoercionWatch.observe — single-observation cases', () => {
  it('does NOT fire on the first non-matching observation (stability check)', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_500);
    expect(hit).toBeNull();
    // Check still pending — the observation primed the stability counter.
    expect(watch.size()).toBe(1);
  });

  it('returns null and clears the check on an exact-mode device echo (no event)', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 500 }));
    const hit = watch.observe('eccentricPercentTenths', 500, 1_000_100);
    expect(hit).toBeNull();
    expect(watch.size()).toBe(0);
  });

  it('returns null when no pending check exists for the field', () => {
    const watch = new CoercionWatch();
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_100);
    expect(hit).toBeNull();
  });

  it('returns null and sweeps the check when the window has elapsed', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ setterReturnedAt: 1_000_000 }));
    const expiredNow = 1_000_000 + COERCION_WINDOW_MS;
    const hit = watch.observe('eccentricPercentTenths', 320, expiredNow);
    expect(hit).toBeNull();
    expect(watch.size()).toBe(0);
  });

  it('observes only the field passed in; other pending checks are untouched', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({ field: 'eccentricPercentTenths', requested: 0, setterReturnedAt: 1_000_000 }),
    );
    watch.register(
      makeRegister({
        field: 'chainTargetForceTenths',
        requested: 100,
        setterName: 'device.set_chains',
        setterReturnedAt: 1_000_000,
      }),
    );
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_200)).toBeNull();
    expect(watch.size()).toBe(2);
  });
});

describe('CoercionWatch.observe — stability counter', () => {
  it('fires after two consecutive observations of the same coerced value', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_500)).toBeNull();
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_600);
    expect(hit).not.toBeNull();
    expect(hit?.requested).toBe(0);
    expect(hit?.setterName).toBe('device.set_eccentric');
    expect(watch.size()).toBe(0);
  });

  it('does NOT fire when two non-matching observations report different values (transient)', () => {
    // Hardware repro 2026-05-11: cascade { ecc: 0 } against pre-state
    // ecc=80 passes through transient 320 before settling at 0. Stability
    // counter resets between the 80 echo and the 320 transient, then the
    // exact-mode echo at 0 clears the check. No event should fire.
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // Pre-state echo (80) — non-matching, primes the streak at 80.
    expect(watch.observe('eccentricPercentTenths', 80, 1_000_100)).toBeNull();
    // Transient mid-cascade (320) — different value, resets streak to 320.
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_200)).toBeNull();
    // Final settle (0) — exact echo, clears the check.
    expect(watch.observe('eccentricPercentTenths', 0, 1_000_300)).toBeNull();
    expect(watch.size()).toBe(0);
  });

  it('resets the stability streak when a different coerced value arrives', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // Observe 100 (one tick of streak), then 200 (reset), then 200 again
    // (confirms). Fires with deviceValue=200.
    expect(watch.observe('eccentricPercentTenths', 100, 1_000_100)).toBeNull();
    expect(watch.observe('eccentricPercentTenths', 200, 1_000_200)).toBeNull();
    const hit = watch.observe('eccentricPercentTenths', 200, 1_000_300);
    expect(hit).not.toBeNull();
    expect(hit?.requested).toBe(0);
  });

  it('a matching echo resets the streak (exact mode); subsequent coercion needs two more', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // Coerced 320 (streak=1).
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_100)).toBeNull();
    // Echo at 0 — exact mode clears the check entirely.
    expect(watch.observe('eccentricPercentTenths', 0, 1_000_200)).toBeNull();
    expect(watch.size()).toBe(0);
  });
});

describe('CoercionWatch.observe — guard mode', () => {
  it('does NOT clear the check on a baseline-echo (echo === requested)', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 100,
        mode: 'guard',
        setterName: 'device.start_guided_load',
        field: 'chainTargetForceTenths',
      }),
    );
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_100)).toBeNull();
    expect(watch.size()).toBe(1);
  });

  it('fires after a coercion stabilizes following a baseline-echo (guided-load shape)', () => {
    // Hardware repro 2026-05-11: start_guided_load{target=5} against
    // pre-state chains=10/ecc=50 — state-dump trace passes 100 (echo)
    // → 20 (coerced) → 20 (stable). Guard mode preserves the check
    // across the echo so the eventual coercion fires.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 100,
        mode: 'guard',
        setterName: 'device.start_guided_load',
        field: 'chainTargetForceTenths',
      }),
    );
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_100)).toBeNull();
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_200)).toBeNull();
    const hit = watch.observe('chainTargetForceTenths', 20, 1_000_300);
    expect(hit).not.toBeNull();
    expect(hit?.requested).toBe(100);
    expect(hit?.setterName).toBe('device.start_guided_load');
    expect(watch.size()).toBe(0);
  });

  it('a baseline-echo arriving AFTER a coerced observation resets the streak (guard mode)', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 100,
        mode: 'guard',
        field: 'chainTargetForceTenths',
        setterName: 'device.start_guided_load',
      }),
    );
    // Coerced 20 (streak=1).
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_100)).toBeNull();
    // Baseline echo (100) — guard mode does NOT clear; streak resets.
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_200)).toBeNull();
    expect(watch.size()).toBe(1);
    // Two more coerced observations are needed to fire.
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_300)).toBeNull();
    const hit = watch.observe('chainTargetForceTenths', 20, 1_000_400);
    expect(hit).not.toBeNull();
  });

  it('guard-mode check expires by window even if no coercion is ever observed', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 100,
        mode: 'guard',
        field: 'chainTargetForceTenths',
        setterName: 'device.start_guided_load',
        setterReturnedAt: 1_000_000,
      }),
    );
    // Only baseline echoes within the window.
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_500)).toBeNull();
    expect(watch.observe('chainTargetForceTenths', 100, 1_001_000)).toBeNull();
    // Window elapses; subsequent observe sweeps the check.
    const expiredNow = 1_000_000 + COERCION_WINDOW_MS;
    expect(watch.observe('chainTargetForceTenths', 20, expiredNow)).toBeNull();
    expect(watch.size()).toBe(0);
  });
});

describe('CoercionWatch.observe — per-check windowMs', () => {
  it('honors a longer windowMs override (guided-load shape)', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 0,
        windowMs: COERCION_WINDOW_MS_GUIDED_LOAD,
        setterReturnedAt: 1_000_000,
      }),
    );
    // 10 seconds after setter — would be expired under default 2500 ms.
    const lateButWithinExtended = 1_000_000 + 10_000;
    expect(watch.observe('eccentricPercentTenths', 320, lateButWithinExtended)).toBeNull();
    const hit = watch.observe('eccentricPercentTenths', 320, lateButWithinExtended + 100);
    expect(hit).not.toBeNull();
  });

  it('sweeps based on the per-check window, not the default', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'long',
        windowMs: 10_000,
        setterReturnedAt: 1_000_000,
      }),
    );
    watch.register(
      makeRegister({
        field: 'short',
        windowMs: 1_000,
        setterReturnedAt: 1_000_000,
      }),
    );
    watch.sweep(1_002_000); // past short, well within long
    expect(watch.size()).toBe(1);
  });
});

describe('CoercionWatch.register', () => {
  it('evicts a prior pending check on the same field (newest setter wins)', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({ requested: 50, setterReturnedAt: 1_000_000, setterName: 'first' }),
    );
    watch.register(
      makeRegister({ requested: 100, setterReturnedAt: 1_000_300, setterName: 'second' }),
    );
    expect(watch.size()).toBe(1);
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_500)).toBeNull();
    const hit = watch.observe('eccentricPercentTenths', 320, 1_000_600);
    expect(hit?.requested).toBe(100);
    expect(hit?.setterName).toBe('second');
  });

  it('keeps checks for distinct fields independent', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ field: 'a', requested: 1 }));
    watch.register(makeRegister({ field: 'b', requested: 2 }));
    expect(watch.size()).toBe(2);
  });

  it('defaults windowMs to COERCION_WINDOW_MS when omitted', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ setterReturnedAt: 1_000_000 }));
    // At the default boundary the check is expired.
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_000 + COERCION_WINDOW_MS)).toBeNull();
    expect(watch.size()).toBe(0);
  });

  it('defaults mode to "exact" when omitted', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 50 }));
    // Echo at requested clears the check (exact mode).
    expect(watch.observe('eccentricPercentTenths', 50, 1_000_100)).toBeNull();
    expect(watch.size()).toBe(0);
  });
});

describe('CoercionWatch.sweep', () => {
  it('drops only checks older than their per-check window', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ field: 'old', setterReturnedAt: 1_000_000 }));
    watch.register(makeRegister({ field: 'fresh', setterReturnedAt: 1_002_000 }));
    watch.sweep(1_000_000 + COERCION_WINDOW_MS + 1);
    expect(watch.size()).toBe(1);
    expect(watch.observe('fresh', 99, 1_002_100)).toBeNull();
    const hit = watch.observe('fresh', 99, 1_002_200);
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
    watch.register(makeRegister({ field: 'a' }));
    watch.register(makeRegister({ field: 'b' }));
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
    const observedNow = Date.now() + 100;
    // Stability requires a second matching observation to fire.
    expect(watch.observe('weightLbsTenths', 99, observedNow)).toBeNull();
    expect(watch.observe('chainTargetForceTenths', 20, observedNow)).toBeNull();
    expect(watch.observe('weightLbsTenths', 99, observedNow + 10)).not.toBeNull();
    expect(watch.observe('chainTargetForceTenths', 20, observedNow + 10)).not.toBeNull();
  });

  it('opts.windowMs propagates to every registered check', async () => {
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'device.start_guided_load',
      [
        { field: 'weightLbsTenths', requested: 50 },
        { field: 'chainTargetForceTenths', requested: 100, mode: 'guard' },
      ],
      async () => undefined,
      { windowMs: COERCION_WINDOW_MS_GUIDED_LOAD },
    );
    // Both checks survive 10s after setter — would have expired at 2.5s.
    const lateNow = Date.now() + 10_000;
    expect(watch.observe('weightLbsTenths', 5, lateNow)).toBeNull();
    expect(watch.observe('chainTargetForceTenths', 20, lateNow)).toBeNull();
    expect(watch.size()).toBe(2);
  });

  it('per-field mode propagates from TrackedFieldSpec to register', async () => {
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'device.start_guided_load',
      [
        { field: 'weightLbsTenths', requested: 50, mode: 'exact' },
        { field: 'chainTargetForceTenths', requested: 100, mode: 'guard' },
      ],
      async () => undefined,
    );
    // exact: echo at 50 clears.
    expect(watch.observe('weightLbsTenths', 50, Date.now() + 100)).toBeNull();
    // guard: echo at 100 does NOT clear.
    expect(watch.observe('chainTargetForceTenths', 100, Date.now() + 100)).toBeNull();
    expect(watch.size()).toBe(1);
  });
});
