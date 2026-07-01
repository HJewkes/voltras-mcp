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
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_500);
    expect(hits).toEqual([]);
    // Check still pending — the observation primed the stability counter.
    expect(watch.size()).toBe(1);
  });

  it('returns empty and clears the check on an exact-mode device echo (no event)', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 500 }));
    const hits = watch.observe('eccentricPercentTenths', 500, 1_000_100);
    expect(hits).toEqual([]);
    expect(watch.size()).toBe(0);
  });

  it('returns empty when no pending check exists for the field', () => {
    const watch = new CoercionWatch();
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_100);
    expect(hits).toEqual([]);
  });

  it('returns empty and sweeps the check when the window has elapsed', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ setterReturnedAt: 1_000_000 }));
    const expiredNow = 1_000_000 + COERCION_WINDOW_MS;
    const hits = watch.observe('eccentricPercentTenths', 320, expiredNow);
    expect(hits).toEqual([]);
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
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_200)).toEqual([]);
    expect(watch.size()).toBe(2);
  });
});

describe('CoercionWatch.observe — stability counter', () => {
  it('fires after two consecutive observations of the same coerced value', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_500)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_600);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(0);
    expect(hits[0].setterName).toBe('device.set_eccentric');
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
    expect(watch.observe('eccentricPercentTenths', 80, 1_000_100)).toEqual([]);
    // Transient mid-cascade (320) — different value, resets streak to 320.
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_200)).toEqual([]);
    // Final settle (0) — exact echo, clears the check.
    expect(watch.observe('eccentricPercentTenths', 0, 1_000_300)).toEqual([]);
    expect(watch.size()).toBe(0);
  });

  it('resets the stability streak when a different coerced value arrives', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // Observe 100 (one tick of streak), then 200 (reset), then 200 again
    // (confirms). Fires with deviceValue=200.
    expect(watch.observe('eccentricPercentTenths', 100, 1_000_100)).toEqual([]);
    expect(watch.observe('eccentricPercentTenths', 200, 1_000_200)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 200, 1_000_300);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(0);
  });

  it('a matching echo resets the streak (exact mode); subsequent coercion needs two more', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // Coerced 320 (streak=1).
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_100)).toEqual([]);
    // Echo at 0 — exact mode clears the check entirely.
    expect(watch.observe('eccentricPercentTenths', 0, 1_000_200)).toEqual([]);
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
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_100)).toEqual([]);
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
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_100)).toEqual([]);
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_200)).toEqual([]);
    const hits = watch.observe('chainTargetForceTenths', 20, 1_000_300);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(100);
    expect(hits[0].setterName).toBe('device.start_guided_load');
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
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_100)).toEqual([]);
    // Baseline echo (100) — guard mode does NOT clear; streak resets.
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_200)).toEqual([]);
    expect(watch.size()).toBe(1);
    // Two more coerced observations are needed to fire.
    expect(watch.observe('chainTargetForceTenths', 20, 1_000_300)).toEqual([]);
    const hits = watch.observe('chainTargetForceTenths', 20, 1_000_400);
    expect(hits).toHaveLength(1);
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
    expect(watch.observe('chainTargetForceTenths', 100, 1_000_500)).toEqual([]);
    expect(watch.observe('chainTargetForceTenths', 100, 1_001_000)).toEqual([]);
    // Window elapses; subsequent observe sweeps the check.
    const expiredNow = 1_000_000 + COERCION_WINDOW_MS;
    expect(watch.observe('chainTargetForceTenths', 20, expiredNow)).toEqual([]);
    expect(watch.size()).toBe(0);
  });
});

describe('CoercionWatch.observe — threshold-1 fields (chains/baseWeight guided-load registration)', () => {
  // start_guided_load (device-tools.ts) registers `chains` in 'guard' mode
  // and `baseWeight` in 'exact' mode, both routed through STABILITY_BY_FIELD
  // at threshold 1 (cmd=0x10 cascade echo — single-shot, never a 2-of-2
  // burst). The guard-mode tests above only exercise the default threshold-2
  // field (`chainTargetForceTenths`), so the single-observation guard-fire
  // path (baseline echo → ONE coerced value fires immediately) was never
  // pinned. These mirror the real production registration shape.

  it('guard + threshold 1 (chains): baseline echo does NOT fire and stays pending', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'chains',
        requested: 100,
        mode: 'guard',
        setterName: 'device.start_guided_load',
      }),
    );
    const hits = watch.observe('chains', 100, 1_000_100);
    expect(hits).toEqual([]);
    expect(watch.size()).toBe(1);
  });

  it('guard + threshold 1 (chains): a single coerced observation fires immediately after the baseline echo', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'chains',
        requested: 100,
        mode: 'guard',
        setterName: 'device.start_guided_load',
      }),
    );
    // Baseline echo — no fire, primes the check as pending.
    expect(watch.observe('chains', 100, 1_000_100)).toEqual([]);
    // ONE coerced value — threshold 1 means this fires immediately, unlike
    // the threshold-2 default which would need a second confirming pass.
    const hits = watch.observe('chains', 20, 1_000_200);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(100);
    expect(hits[0].setterName).toBe('device.start_guided_load');
    expect(watch.size()).toBe(0);
  });

  it('exact + threshold 1 (baseWeight): a single coerced observation fires immediately (no stability wait)', () => {
    // baseWeight differs from chains: start_guided_load registers it in
    // 'exact' mode (the target weight IS the new value the firmware should
    // converge on), not 'guard'. Threshold 1 still applies, so unlike the
    // default threshold-2 exact-mode fields, a single non-matching
    // observation is sufficient to fire — no second confirming pass needed.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'baseWeight',
        requested: 100,
        mode: 'exact',
        setterName: 'device.start_guided_load',
      }),
    );
    const hits = watch.observe('baseWeight', 20, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(100);
    expect(hits[0].setterName).toBe('device.start_guided_load');
    expect(watch.size()).toBe(0);
  });

  it('exact + threshold 1 (baseWeight): an echo at the requested value clears the check (legitimate success)', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'baseWeight',
        requested: 100,
        mode: 'exact',
        setterName: 'device.start_guided_load',
      }),
    );
    const hits = watch.observe('baseWeight', 100, 1_000_100);
    expect(hits).toEqual([]);
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
    expect(watch.observe('eccentricPercentTenths', 320, lateButWithinExtended)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 320, lateButWithinExtended + 100);
    expect(hits).toHaveLength(1);
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

describe('CoercionWatch.register — composite (setterName, field) keying', () => {
  it('evicts a prior pending check on the same (setterName, field) pair', () => {
    // Same setter re-registering the same field is "newest user intent
    // wins" — the second call's `requested` replaces the first.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 50,
        setterReturnedAt: 1_000_000,
        setterName: 'device.set_eccentric',
      }),
    );
    watch.register(
      makeRegister({
        requested: 100,
        setterReturnedAt: 1_000_300,
        setterName: 'device.set_eccentric',
      }),
    );
    expect(watch.size()).toBe(1);
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_500)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_600);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(100);
    expect(hits[0].setterName).toBe('device.set_eccentric');
  });

  it('keeps checks for the same field but different setterNames independent (VMCP-01.38)', () => {
    // Two different setters touching the same field within the window
    // must both retain a pending check so each can fire its own
    // setting_coerced event. The prior field-only keying lost the first
    // setter's check when the second registered.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'chainTargetForceTenths',
        requested: 500,
        setterName: 'device.set_chains',
        setterReturnedAt: 1_000_000,
      }),
    );
    watch.register(
      makeRegister({
        field: 'chainTargetForceTenths',
        requested: 800,
        setterName: 'bilateral.cascade',
        setterReturnedAt: 1_000_100,
      }),
    );
    expect(watch.size()).toBe(2);
    // First observation primes both stability counters at 300.
    expect(watch.observe('chainTargetForceTenths', 300, 1_000_500)).toEqual([]);
    // Second observation fires both checks — one event per setter.
    const hits = watch.observe('chainTargetForceTenths', 300, 1_000_600);
    expect(hits).toHaveLength(2);
    const setterNames = hits.map((h) => h.setterName).sort();
    expect(setterNames).toEqual(['bilateral.cascade', 'device.set_chains']);
    expect(watch.size()).toBe(0);
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
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_000 + COERCION_WINDOW_MS)).toEqual(
      [],
    );
    expect(watch.size()).toBe(0);
  });

  it('defaults mode to "exact" when omitted', () => {
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 50 }));
    // Echo at requested clears the check (exact mode).
    expect(watch.observe('eccentricPercentTenths', 50, 1_000_100)).toEqual([]);
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
    expect(watch.observe('fresh', 99, 1_002_100)).toEqual([]);
    const hits = watch.observe('fresh', 99, 1_002_200);
    expect(hits).toHaveLength(1);
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
    expect(watch.observe('weightLbsTenths', 99, observedNow)).toEqual([]);
    expect(watch.observe('chainTargetForceTenths', 20, observedNow)).toEqual([]);
    expect(watch.observe('weightLbsTenths', 99, observedNow + 10)).toHaveLength(1);
    expect(watch.observe('chainTargetForceTenths', 20, observedNow + 10)).toHaveLength(1);
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
    expect(watch.observe('weightLbsTenths', 5, lateNow)).toEqual([]);
    expect(watch.observe('chainTargetForceTenths', 20, lateNow)).toEqual([]);
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
    expect(watch.observe('weightLbsTenths', 50, Date.now() + 100)).toEqual([]);
    // guard: echo at 100 does NOT clear.
    expect(watch.observe('chainTargetForceTenths', 100, Date.now() + 100)).toEqual([]);
    expect(watch.size()).toBe(1);
  });
});
