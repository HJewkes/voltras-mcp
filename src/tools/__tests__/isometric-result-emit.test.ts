// Unit tests for the isometric_result publish helper (VW-264): what each imbalance
// report maps onto, and the single-sided case that has no verdict to give.

import { describe, expect, it } from 'vitest';

import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { ServerState } from '../../state/server-state.js';
import {
  publishImbalanceResult,
  publishMaxResult,
  type ImbalanceVerdictSource,
} from '../isometric-result-emit.js';

interface Captured {
  state: ServerState;
  published: ChannelEvent[];
}

function captureState(): Captured {
  const published: ChannelEvent[] = [];
  const publisher: ChannelPublisher = {
    publish: (event) => published.push(event),
    forSlot: () => publisher,
  };
  return { state: { channels: publisher } as unknown as ServerState, published };
}

function decode(published: ChannelEvent[]): Record<string, unknown> {
  const parsed = JSON.parse(published[0].content) as { isometric_result: Record<string, unknown> };
  return parsed.isometric_result;
}

const SIDES = [
  { side: 'left' as const, slot: 'left', peakForceLbs: 180.4 },
  { side: 'right' as const, slot: 'right', peakForceLbs: 151.2 },
];

function imbalance(over: Partial<ImbalanceVerdictSource> = {}): ImbalanceVerdictSource {
  return { asymmetryPct: 16.2, real: true, interpretation: 'exceeds the CV', ...over };
}

/** The gate as `measureImbalance` reports it when the two setups line up (VW-284). */
const COMPARABLE = { comparability: 'comparable', reason: 'the two setups line up' };

describe('publishImbalanceResult (VW-264)', () => {
  it('calls a difference beyond the athlete’s own CV meaningful', () => {
    const { state, published } = captureState();
    publishImbalanceResult(state, { sides: SIDES, imbalance: imbalance(), setup: COMPARABLE });
    expect(published[0].meta.event_type).toBe('isometric_result');
    expect(decode(published).verdict).toBe('meaningful');
  });

  it('calls a difference inside that CV flagged, not meaningful', () => {
    const { state, published } = captureState();
    publishImbalanceResult(state, {
      sides: SIDES,
      imbalance: imbalance({ real: false }),
      setup: COMPARABLE,
    });
    expect(decode(published).verdict).toBe('flagged');
  });

  it('gives no verdict at all when neither side produced a comparable mean', () => {
    const { state, published } = captureState();
    publishImbalanceResult(state, {
      sides: SIDES,
      imbalance: imbalance({ asymmetryPct: null, real: false }),
      setup: COMPARABLE,
    });
    expect(decode(published).verdict).toBeNull();
  });

  it('withholds the verdict and reports the setup reason when the gate confounded it', () => {
    const { state, published } = captureState();
    // VW-284 withholds by setting `real` to null and rewriting the interpretation.
    publishImbalanceResult(state, {
      sides: SIDES,
      imbalance: imbalance({
        real: null,
        interpretation: 'Verdict withheld: cable travel differs between the sides',
      }),
      setup: {
        comparability: 'setup_confounded',
        reason: 'cable travel differs between the sides',
      },
    });
    const result = decode(published);
    expect(result.verdict).toBeNull();
    expect(result.comparability).toBe('setup_confounded');
    // The BARE gate wording, so the card can prefix it without doubling up.
    expect(result.setupReason).toBe('cable travel differs between the sides');
  });

  it('still reports the verdict when the gate could not run at all', () => {
    const { state, published } = captureState();
    publishImbalanceResult(state, {
      sides: SIDES,
      imbalance: imbalance(),
      setup: { comparability: 'setup_unverified', reason: 'no confirmed setup on the left' },
    });
    const result = decode(published);
    expect(result.verdict).toBe('meaningful');
    expect(result.comparability).toBe('setup_unverified');
  });

  it('carries no slot in meta — each side names its own inside the payload', () => {
    const { state, published } = captureState();
    publishImbalanceResult(state, { sides: SIDES, imbalance: imbalance(), setup: COMPARABLE });
    expect(published[0].meta.slot).toBeUndefined();
    expect(decode(published).sides).toEqual(SIDES);
  });
});

describe('publishMaxResult (VW-264)', () => {
  it('reports the one peak with no asymmetry and no verdict', () => {
    const { state, published } = captureState();
    publishMaxResult(state, { slot: 'primary', peakForceLbs: 210 });
    const result = decode(published);
    expect(result.tool).toBe('isometric.measure_max');
    expect(result.sides).toEqual([{ side: null, slot: 'primary', peakForceLbs: 210 }]);
    expect(result.asymmetryPct).toBeNull();
    expect(result.verdict).toBeNull();
  });

  it('says so when the run produced no mean peak at all', () => {
    const { state, published } = captureState();
    publishMaxResult(state, { slot: 'primary', peakForceLbs: null });
    expect(decode(published).reason).toContain('fewer than 2 valid trials');
  });
});
