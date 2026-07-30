// Tests for per-set capture provenance (Wave 1-S).
//
// The theme running through these: every one of these values is unrecoverable
// once a set has closed, so the failure mode that matters is not "wrong number"
// but "confidently wrong number where a gap belonged". Each case below checks
// that an unknown stays unknown.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';
import type { DeviceSnapshot } from '../live-state.js';
import {
  CURRENT_POSITION_UNITS,
  hashSettingsContext,
  measureSampleRateHz,
  readSettingsContext,
} from '../set-capture.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** A rep whose concentric phase carries samples at the given timestamps. */
function repWithTimestamps(timestamps: number[]): Rep {
  return {
    repNumber: 1,
    concentric: {
      ...EMPTY_PHASE,
      samples: timestamps.map((timestamp, i) => ({
        sequence: i,
        timestamp,
        phase: 0,
        position: 0,
        velocity: 0,
        force: 0,
        load: 0,
      })),
    },
    eccentric: { ...EMPTY_PHASE },
  } as unknown as Rep;
}

describe('readSettingsContext', () => {
  it('reads the user-facing chains setting, not the capped state-dump field', () => {
    // `chainTargetForceTenths` is min(chains, weight) — it silently reads as the
    // weight whenever chains exceed it, so a set at chains 60 / weight 50 would
    // record 50 and look like a different configuration than it was.
    const device: DeviceSnapshot = {
      connected: true,
      chainSettingLbs: 60,
      chainTargetForceTenths: 500,
    };
    expect(readSettingsContext(device).chainsLbs).toBe(60);
  });

  it('reads inverse chains as a weight, alongside chains rather than instead of it', () => {
    // The device carries both settings at once, and they are mechanically
    // opposite — chains add resistance through the concentric, inverse chains
    // shed it there and add it through the eccentric. One signed field could
    // not represent a set that has both.
    const device: DeviceSnapshot = {
      connected: true,
      chainSettingLbs: 30,
      inverseChainSettingLbs: 15,
    };
    const ctx = readSettingsContext(device);
    expect(ctx.chainsLbs).toBe(30);
    expect(ctx.inverseChainsLbs).toBe(15);
  });

  it('omits inverse chains when the snapshot never reported it', () => {
    // The pre-v9 bridge never read this field at all, so "absent" has to stay
    // absent rather than becoming an implicit 0 the corpus would trust.
    expect(readSettingsContext({ connected: true, chainSettingLbs: 30 })).not.toHaveProperty(
      'inverseChainsLbs',
    );
  });

  it('scales eccentric from tenths of a percent', () => {
    const device: DeviceSnapshot = { connected: true, eccentricPercentTenths: 1250 };
    expect(readSettingsContext(device).eccentricPct).toBe(125);
  });

  it('omits every field the snapshot has no value for', () => {
    // Not zero-filled: an absent damper setting and a damper setting of 0 are
    // different claims about the set.
    expect(readSettingsContext({ connected: true })).toEqual({});
  });
});

describe('hashSettingsContext', () => {
  it('is stable across key order', () => {
    const a = hashSettingsContext({ chainsLbs: 20, damperLevel: 3 });
    const b = hashSettingsContext({ damperLevel: 3, chainsLbs: 20 });
    expect(a).toBe(b);
    expect(a).toBeDefined();
  });

  it('carries the version prefix', () => {
    // Load-bearing: without it, hashes computed before a tenth settings
    // dimension is added compare equal to hashes computed after, and the
    // mismatch is undetectable.
    expect(hashSettingsContext({ damperLevel: 3 })).toMatch(/^v2:[0-9a-f]{16}$/);
  });

  it('distinguishes an absent setting from a zero one', () => {
    expect(hashSettingsContext({ damperLevel: 0 })).not.toBe(hashSettingsContext({}));
    expect(hashSettingsContext({ damperLevel: 0, chainsLbs: 10 })).not.toBe(
      hashSettingsContext({ chainsLbs: 10 }),
    );
  });

  it('distinguishes two genuinely different configurations', () => {
    expect(hashSettingsContext({ chainsLbs: 20 })).not.toBe(hashSettingsContext({ chainsLbs: 25 }));
  });

  it('distinguishes chains from inverse chains at the same weight', () => {
    // THE case this hash exists for. Chains ascend through the concentric,
    // inverse chains descend through it — the same number in the two fields
    // describes opposite mechanics. Before inverse chains were captured these
    // two produced the SAME hash and would have been compared like-for-like.
    const chains = hashSettingsContext({ chainsLbs: 20, damperLevel: 3, eccentricPct: 0 });
    const inverse = hashSettingsContext({ inverseChainsLbs: 20, damperLevel: 3, eccentricPct: 0 });
    expect(chains).toBeDefined();
    expect(inverse).toBeDefined();
    expect(chains).not.toBe(inverse);
  });

  it('distinguishes zero inverse chains from unrecorded inverse chains', () => {
    // "The user had none set" is an observation; "nobody read the field" is a
    // gap. Serializing the absent case as 0 would merge the two.
    expect(hashSettingsContext({ chainsLbs: 20, inverseChainsLbs: 0 })).not.toBe(
      hashSettingsContext({ chainsLbs: 20 }),
    );
  });

  it('distinguishes two inverse-chains weights', () => {
    // Under the old boolean model both of these were "inverse chains: true".
    expect(hashSettingsContext({ inverseChainsLbs: 5 })).not.toBe(
      hashSettingsContext({ inverseChainsLbs: 40 }),
    );
  });

  it('returns undefined for a wholly unknown context', () => {
    // An empty hash would assert "these two sets shared a configuration" about
    // two sets whose configuration nobody recorded.
    expect(hashSettingsContext({})).toBeUndefined();
  });
});

describe('measureSampleRateHz', () => {
  it('measures the rate from sample timestamps', () => {
    // 10 samples 100 ms apart = 10 Hz.
    const ts = Array.from({ length: 10 }, (_, i) => 1000 + i * 100);
    expect(measureSampleRateHz([repWithTimestamps(ts)])).toBe(10);
  });

  it('uses the median, so one disconnect gap does not drag the rate down', () => {
    // Nine ~91 ms intervals plus one 30-second hole. A mean would report about
    // 0.3 Hz for a set actually sampled at ~11 Hz.
    const ts = [0, 91, 182, 273, 364, 30_364, 30_455, 30_546, 30_637, 30_728];
    const rate = measureSampleRateHz([repWithTimestamps(ts)]);
    expect(rate).toBeCloseTo(11, 0);
  });

  it('returns undefined when there is not enough signal to measure', () => {
    // Fewer than two intervals is not a rate, and inventing one would be worse
    // than a gap — the whole reason to record the rate is to tell two corpora
    // apart, which a guessed value defeats.
    expect(measureSampleRateHz([])).toBeUndefined();
    expect(measureSampleRateHz([repWithTimestamps([1000])])).toBeUndefined();
    expect(measureSampleRateHz([repWithTimestamps([1000, 1100])])).toBeUndefined();
  });

  it('ignores non-advancing timestamps rather than dividing by zero', () => {
    const ts = [1000, 1000, 1100, 1200, 1300];
    expect(measureSampleRateHz([repWithTimestamps(ts)])).toBe(10);
  });
});

describe('CURRENT_POSITION_UNITS', () => {
  it('is meters now that the bridge converts position before WA ingestion (VMCP-05.19)', () => {
    // WA 2.0.0 redefines `WorkoutSample.position` as cable extension in
    // metres, converted at the producer's bridge. `event-bridge.ts` now
    // converts `frame.position` via `mmToM` before building each
    // `WorkoutSample`, so newly-written rows are genuinely on the metres
    // scale and the marker may truthfully say so.
    expect(CURRENT_POSITION_UNITS).toBe('meters');
  });
});
