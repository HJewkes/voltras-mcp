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

describe('CoercionWatch.observe — per-field stability threshold (VMCP-01.38)', () => {
  // Hardware repro 2026-05-12 (bilateral.cascade chains coerce): the
  // slow-settling slot's chainTargetForceTenths oscillates between two
  // non-matching values (e.g. 300↔200) during the firmware settle window;
  // the 2-of-2 consecutive-identical default never reaches stability and
  // the slot's setting_coerced event is silently dropped within the 2500ms
  // window. The per-field override lets fields with no documented
  // transient-burst pattern (chains, weight, assist, damper) fire on the
  // first non-matching observation while preserving the 2-of-2 default for
  // fields that do (eccentricPercentTenths — 80→320→0 transient).
  it('chainTargetForceTenths fires on the FIRST non-matching observation', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'bilateral.cascade',
        field: 'chainTargetForceTenths',
        requested: 800, // user asked for 80 lbs
      }),
    );
    // Single firmware echo at 500 (=50 lbs, capped at weight=50) — should
    // fire immediately without waiting for a second consecutive observation.
    const hits = watch.observe('chainTargetForceTenths', 500, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(800);
    expect(hits[0].setterName).toBe('bilateral.cascade');
    expect(watch.size()).toBe(0);
  });

  it('weightLbsTenths fires on the FIRST non-matching observation', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.set_weight',
        field: 'weightLbsTenths',
        requested: 2000,
      }),
    );
    const hits = watch.observe('weightLbsTenths', 1500, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(2000);
  });

  it('assistMode fires on the FIRST non-matching observation', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.set_assist_mode',
        field: 'assistMode',
        requested: 3,
      }),
    );
    const hits = watch.observe('assistMode', 0, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(3);
  });

  it('damperLevel fires on the FIRST non-matching observation', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.set_damper_level',
        field: 'damperLevel',
        requested: 10,
      }),
    );
    const hits = watch.observe('damperLevel', 6, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(10);
  });

  it('eccentricPercentTenths STILL requires two consecutive observations (transient defense preserved)', () => {
    // Regression guard for PR #43's stability counter motivation: the
    // 80→320→0 ecc transient burst must not fire a spurious setting_coerced
    // at the transient value. Threshold=2 stays in place for this field.
    const watch = new CoercionWatch();
    watch.register(makeRegister({ requested: 0 }));
    // First observation at 320 — should NOT fire (one-shot transient).
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_100)).toEqual([]);
    // Second observation at the same coerced value — NOW fires.
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_200);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(0);
  });

  it('an unknown / unmapped field defaults to the conservative 2-of-2 threshold', () => {
    // Forward-compat: any new device-level field we haven't classified yet
    // gets the safer default (requires stability), so adding new tracked
    // fields without an entry in STABILITY_BY_FIELD is never a silent
    // false-positive risk.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.set_future',
        field: 'someFutureField',
        requested: 0,
      }),
    );
    expect(watch.observe('someFutureField', 99, 1_000_100)).toEqual([]);
    const hits = watch.observe('someFutureField', 99, 1_000_200);
    expect(hits).toHaveLength(1);
  });

  it('bilateral scenario: two independent watches each fire on a single chains coerce', () => {
    // Models the VMCP-01.38 hardware repro: bilateral.cascade { chainsLbs }
    // on both slots; each slot's per-slot CoercionWatch receives one
    // chainTargetForceTenths state-dump at the coerced value (the
    // post-settle echo) within the window. Before the fix, neither slot's
    // 2-of-2 counter reached stability and both events were dropped. After
    // the fix, both slots' channels fire.
    const left = new CoercionWatch();
    const right = new CoercionWatch();
    left.register(
      makeRegister({
        setterName: 'bilateral.cascade',
        field: 'chainTargetForceTenths',
        requested: 800,
      }),
    );
    right.register(
      makeRegister({
        setterName: 'bilateral.cascade',
        field: 'chainTargetForceTenths',
        requested: 800,
      }),
    );
    const leftHits = left.observe('chainTargetForceTenths', 500, 1_000_100);
    const rightHits = right.observe('chainTargetForceTenths', 500, 1_000_110);
    expect(leftHits).toHaveLength(1);
    expect(rightHits).toHaveLength(1);
    expect(left.size()).toBe(0);
    expect(right.size()).toBe(0);
  });
});

describe('CoercionWatch.observe — per-call stabilityOverride (VMCP-02.21)', () => {
  // Hardware repro 2026-05-18 (bench session, every device.start_guided_load
  // call): the Damper→WeightTraining mode-bounce emits a transient
  // state-dump with weightLbsTenths at the mode-floor (50 = 5 lb) for one
  // tick before the firmware settles on the user's target. The field
  // default of 1 fires a spurious setting_coerced with a large negative
  // delta on that transient. start_guided_load passes stabilityOverride: 2
  // to require a 2-of-2 streak before firing, defusing the burst. The
  // override is per-check — bilateral.cascade's chainTargetForceTenths
  // path keeps the default-of-1 stability for the chains-oscillation case.
  it('does NOT fire on a single non-matching observation when stabilityOverride is 2', () => {
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.start_guided_load',
        field: 'weightLbsTenths',
        requested: 550, // target = 55 lb
        stabilityOverride: 2,
      }),
    );
    // Mode-bounce transient: weightLbsTenths floors to 50 (5 lb) for one
    // state-dump. With the override in place, this single non-matching
    // observation primes the streak but does not fire.
    const hits = watch.observe('weightLbsTenths', 50, 1_000_100);
    expect(hits).toEqual([]);
    expect(watch.size()).toBe(1);
  });

  it('fires after two consecutive matching non-matching observations when stabilityOverride is 2', () => {
    // Real firmware coercion (not a transient) reads the same coerced
    // value across two consecutive state-dumps; that meets the 2-of-2
    // streak and the event fires.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.start_guided_load',
        field: 'weightLbsTenths',
        requested: 550,
        stabilityOverride: 2,
      }),
    );
    expect(watch.observe('weightLbsTenths', 400, 1_000_100)).toEqual([]);
    const hits = watch.observe('weightLbsTenths', 400, 1_000_110);
    expect(hits).toHaveLength(1);
    expect(hits[0].setterName).toBe('device.start_guided_load');
    expect(hits[0].requested).toBe(550);
    expect(watch.size()).toBe(0);
  });

  it('stabilityOverride applies per-check — other pending checks on the same field keep the field default', () => {
    // Co-existence: a start_guided_load check (override=2) and a
    // bilateral.cascade check (default=1, no override) for weightLbsTenths
    // are both pending. A single non-matching observation should fire the
    // cascade check (threshold=1) but NOT the guided-load check
    // (threshold=2, requires two consecutive).
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        setterName: 'device.start_guided_load',
        field: 'weightLbsTenths',
        requested: 550,
        stabilityOverride: 2,
      }),
    );
    watch.register(
      makeRegister({
        setterName: 'bilateral.cascade',
        field: 'weightLbsTenths',
        requested: 800,
      }),
    );
    const hits = watch.observe('weightLbsTenths', 50, 1_000_100);
    expect(hits).toHaveLength(1);
    expect(hits[0].setterName).toBe('bilateral.cascade');
    // The guided-load check is still pending (streak primed, not fired).
    expect(watch.size()).toBe(1);
  });

  it('stabilityOverride threads through trackedSetterCall via TrackedFieldSpec.stability', async () => {
    // End-to-end wiring: the tool-layer setter passes `stability: 2` on
    // the TrackedFieldSpec, trackedSetterCall forwards it as
    // stabilityOverride on the PendingCoercionRegister, and observe()
    // honors the override. This pins the contract device-tools.ts relies
    // on for VMCP-02.21.
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'device.start_guided_load',
      [{ field: 'weightLbsTenths', requested: 550, stability: 2 }],
      async () => undefined,
    );
    const now = Date.now() + 100;
    expect(watch.observe('weightLbsTenths', 50, now)).toEqual([]);
    const hits = watch.observe('weightLbsTenths', 50, now + 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].setterName).toBe('device.start_guided_load');
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
    // Hardware repro 2026-05-11: start_guided_load against pre-state
    // ecc=50 — state-dump trace passes 500 (echo) → 200 (coerced) → 200
    // (stable). Guard mode preserves the check across the echo so the
    // eventual coercion fires once the streak satisfies the field's
    // stability threshold. Use eccentricPercentTenths to exercise the
    // 2-of-2 threshold; the chains-mode analog under threshold=1 fires
    // on the first non-matching observation (covered separately).
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 500,
        mode: 'guard',
        setterName: 'device.start_guided_load',
        field: 'eccentricPercentTenths',
      }),
    );
    expect(watch.observe('eccentricPercentTenths', 500, 1_000_100)).toEqual([]);
    expect(watch.observe('eccentricPercentTenths', 200, 1_000_200)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 200, 1_000_300);
    expect(hits).toHaveLength(1);
    expect(hits[0].requested).toBe(500);
    expect(hits[0].setterName).toBe('device.start_guided_load');
    expect(watch.size()).toBe(0);
  });

  it('a baseline-echo arriving AFTER a coerced observation resets the streak (guard mode)', () => {
    // Uses eccentricPercentTenths so the 2-of-2 stability threshold
    // applies — the streak-reset path is unobservable under threshold=1.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        requested: 500,
        mode: 'guard',
        field: 'eccentricPercentTenths',
        setterName: 'device.start_guided_load',
      }),
    );
    // Coerced 200 (streak=1).
    expect(watch.observe('eccentricPercentTenths', 200, 1_000_100)).toEqual([]);
    // Baseline echo (500) — guard mode does NOT clear; streak resets.
    expect(watch.observe('eccentricPercentTenths', 500, 1_000_200)).toEqual([]);
    expect(watch.size()).toBe(1);
    // Two more coerced observations are needed to fire.
    expect(watch.observe('eccentricPercentTenths', 200, 1_000_300)).toEqual([]);
    const hits = watch.observe('eccentricPercentTenths', 200, 1_000_400);
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
    // setter's check when the second registered. Use eccentricPercent-
    // Tenths (threshold=2) so the keying-independence assertion isn't
    // conflated with the immediate-fire behavior of threshold=1 fields.
    const watch = new CoercionWatch();
    watch.register(
      makeRegister({
        field: 'eccentricPercentTenths',
        requested: 0,
        setterName: 'device.set_eccentric',
        setterReturnedAt: 1_000_000,
      }),
    );
    watch.register(
      makeRegister({
        field: 'eccentricPercentTenths',
        requested: 500,
        setterName: 'bilateral.cascade',
        setterReturnedAt: 1_000_100,
      }),
    );
    expect(watch.size()).toBe(2);
    // First observation primes both stability counters at 320.
    expect(watch.observe('eccentricPercentTenths', 320, 1_000_500)).toEqual([]);
    // Second observation fires both checks — one event per setter.
    const hits = watch.observe('eccentricPercentTenths', 320, 1_000_600);
    expect(hits).toHaveLength(2);
    const setterNames = hits.map((h) => h.setterName).sort();
    expect(setterNames).toEqual(['bilateral.cascade', 'device.set_eccentric']);
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
    // Uses chainTargetForceTenths (threshold=1, fires on first
    // non-matching observation) AND eccentricPercentTenths (threshold=2,
    // needs two matching observations) to confirm setterReturnedAt is
    // identical across both even though their fire timing differs.
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'bilateral.cascade',
      [
        { field: 'chainTargetForceTenths', requested: 100 },
        { field: 'eccentricPercentTenths', requested: 0 },
      ],
      async () => undefined,
    );
    const observedNow = Date.now() + 100;
    // chains: threshold=1 — fires on the first observation.
    const chainsHits = watch.observe('chainTargetForceTenths', 20, observedNow);
    expect(chainsHits).toHaveLength(1);
    // ecc: threshold=2 — primes on the first, fires on the second.
    expect(watch.observe('eccentricPercentTenths', 320, observedNow)).toEqual([]);
    const eccHits = watch.observe('eccentricPercentTenths', 320, observedNow + 10);
    expect(eccHits).toHaveLength(1);
    // Both fired checks share the SAME setterReturnedAt.
    expect(chainsHits[0].setterReturnedAt).toBe(eccHits[0].setterReturnedAt);
  });

  it('opts.windowMs propagates to every registered check', async () => {
    // Uses fields with threshold=2 (eccentricPercentTenths,
    // eccentricPercentTenths-guard via different setters keying) so the
    // single-observation probes below don't fire the checks — the test
    // is about window survival, not about when stability is reached.
    const watch = new CoercionWatch();
    await trackedSetterCall(
      watch,
      'device.start_guided_load',
      [
        { field: 'eccentricPercentTenths', requested: 0 },
        { field: 'someUnclassifiedField', requested: 0, mode: 'guard' },
      ],
      async () => undefined,
      { windowMs: COERCION_WINDOW_MS_GUIDED_LOAD },
    );
    // Both checks survive 10s after setter — would have expired at 2.5s.
    // Single non-matching observations don't fire either check (ecc is
    // threshold=2, the unclassified field falls back to threshold=2).
    const lateNow = Date.now() + 10_000;
    expect(watch.observe('eccentricPercentTenths', 320, lateNow)).toEqual([]);
    expect(watch.observe('someUnclassifiedField', 99, lateNow)).toEqual([]);
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
