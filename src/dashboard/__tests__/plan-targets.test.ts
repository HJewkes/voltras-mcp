// Regression tests for the planned-exercise target gate (VW-121 / F1 + F2).
//
// The review that produced this task typed `-999` into the `lb` box, clicked
// "Save targets", and watched the prescription line become `@ -999 lb` — then
// survive a reload. Both the client and the server checked only
// `Number.isFinite`. These tests hold the three properties that were missing:
//
//   1. RANGE. A number outside a field's bounds is refused, on both sides.
//   2. CROSS-FIELD. `hi < lo` is not a rep band, even when only one bound is
//      being PATCHed and the other comes from the stored row.
//   3. SINGLE FLIGHT. A second click that lands before the first write returns
//      is DROPPED, not queued — the duplicate-add bug in one assertion.

import { describe, expect, it, vi } from 'vitest';

import { validateTargetField, validateTargets, TARGET_RULES } from '../plan-targets.js';
import { parseTargetFields } from '../spa/planner/target-fields.js';
import { createMutationLatch } from '../spa/planner/mutation-latch.js';

describe('validateTargetField', () => {
  it('refuses a negative weight — the exact value that reached a prescription', () => {
    expect(validateTargetField('targetWeightLbs', -999)).toContain('between');
    expect(validateTargetField('targetWeightLbs', 135)).toBeNull();
  });

  it('refuses out-of-range values at both ends of every field', () => {
    for (const [field, rule] of Object.entries(TARGET_RULES)) {
      const key = field as keyof typeof TARGET_RULES;
      expect(validateTargetField(key, rule.min - 1)).not.toBeNull();
      expect(validateTargetField(key, rule.max + 1)).not.toBeNull();
      expect(validateTargetField(key, rule.min)).toBeNull();
      expect(validateTargetField(key, rule.max)).toBeNull();
    }
  });

  it('refuses a fractional count where only whole units exist', () => {
    expect(validateTargetField('targetSets', 2.5)).toContain('whole number');
    // Weight is not integer-constrained: 2.5 lb plates exist.
    expect(validateTargetField('targetWeightLbs', 2.5)).toBeNull();
  });

  it('refuses a non-finite number rather than passing NaN through', () => {
    expect(validateTargetField('targetSets', Number.NaN)).not.toBeNull();
    expect(validateTargetField('targetSets', Number.POSITIVE_INFINITY)).not.toBeNull();
  });
});

describe('validateTargets', () => {
  it('refuses a rep band whose high bound sits below its low bound', () => {
    expect(validateTargets({ targetRepsLow: 10, targetRepsHigh: 4 })).toContain('at least');
    expect(validateTargets({ targetRepsLow: 8, targetRepsHigh: 10 })).toBeNull();
    // Equal bounds are a legitimate single-rep-count prescription.
    expect(validateTargets({ targetRepsLow: 5, targetRepsHigh: 5 })).toBeNull();
  });

  it('accepts a lone bound — a half-specified band is not an inverted one', () => {
    expect(validateTargets({ targetRepsHigh: 4 })).toBeNull();
  });
});

describe('parseTargetFields', () => {
  const noExisting = {};

  it('treats a blank box as "leave unchanged" and reports an all-blank form', () => {
    const result = parseTargetFields(
      { sets: '', repsLow: '', repsHigh: '', weight: '' },
      noExisting,
    );
    expect(result).toEqual({ ok: true, patch: {}, empty: true });
  });

  it('rejects a negative weight before it ever reaches the network', () => {
    const result = parseTargetFields(
      { sets: '', repsLow: '', repsHigh: '', weight: '-999' },
      noExisting,
    );
    expect(result.ok).toBe(false);
  });

  it('surfaces a typo instead of silently discarding it', () => {
    // The old `numberOrUndefined` returned undefined for 'abc', so a typo became
    // "no change" with no feedback at all.
    const result = parseTargetFields(
      { sets: 'abc', repsLow: '', repsHigh: '', weight: '' },
      noExisting,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Sets');
  });

  it('catches an inverted band formed against the values already stored', () => {
    // Only `hi` is being edited; `lo = 8` comes from the row. A patch-only check
    // sees a single in-range number and waves it through.
    const result = parseTargetFields(
      { sets: '', repsLow: '', repsHigh: '4', weight: '' },
      { targetRepsLow: 8 },
    );
    expect(result.ok).toBe(false);
  });

  it('builds a patch of only the boxes that were filled in', () => {
    const result = parseTargetFields(
      { sets: '4', repsLow: '', repsHigh: '', weight: '135' },
      noExisting,
    );
    expect(result).toEqual({
      ok: true,
      patch: { targetSets: 4, targetWeightLbs: 135 },
      empty: false,
    });
  });
});

describe('createMutationLatch', () => {
  it('drops a second call that lands while the first is still in flight', async () => {
    // The duplicate-add bug: two `onPress`es in one React tick. Nothing between
    // them yields, so any guard that waits for a re-render is already too late.
    let release = (): void => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const latch = createMutationLatch();

    const first = latch.run(write);
    const second = latch.run(write);
    expect(await second).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reopens after the in-flight call settles, including on failure', async () => {
    const latch = createMutationLatch();
    await latch.run(async () => undefined);
    expect(latch.busy).toBe(false);

    const onError = vi.fn();
    const failing = createMutationLatch({ onError });
    expect(
      await failing.run(async () => {
        throw new Error('boom');
      }),
    ).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(failing.busy).toBe(false);
    expect(await failing.run(async () => undefined)).toBe(true);
  });

  it('reports busy transitions so a component can disable its controls', async () => {
    const onBusyChange = vi.fn();
    const latch = createMutationLatch({ onBusyChange });
    await latch.run(async () => undefined);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});
