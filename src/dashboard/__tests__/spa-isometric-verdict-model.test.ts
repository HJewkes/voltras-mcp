// Model tests for the isometric verdict card (VW-264) — the dwell and every way it ends.

import { describe, expect, it } from 'vitest';

import {
  deriveIsometricVerdictCard,
  VERDICT_CARD_DWELL_MS,
} from '../spa/live-page/isometric-verdict-model.js';
import type { LiveIsometricResultSignal, LiveIsometricSignal } from '../../state/live-signal.js';

const OCCURRED_AT = 1_000_000;

function result(over: Partial<LiveIsometricResultSignal> = {}): LiveIsometricResultSignal {
  return {
    tool: 'isometric.measure_imbalance',
    sides: [
      { side: 'left', slot: 'left', peakForceLbs: 180.4 },
      { side: 'right', slot: 'right', peakForceLbs: 151.2 },
    ],
    asymmetryPct: 16.2,
    verdict: 'meaningful',
    reason: 'Asymmetry 16.2% exceeds this athlete’s own intra-limb CV of 4.1%.',
    comparability: null,
    setupReason: null,
    occurredAt: OCCURRED_AT,
    ...over,
  };
}

function hold(over: Partial<LiveIsometricSignal> = {}): LiveIsometricSignal {
  return { slot: 'left', phase: 'ready', trial: 1, holdMs: 5000, side: 'left', ...over };
}

function derive(over: Partial<Parameters<typeof deriveIsometricVerdictCard>[0]> = {}) {
  return deriveIsometricVerdictCard({
    result: result(),
    hold: null,
    setStartMs: null,
    nowMs: OCCURRED_AT + 1000,
    ...over,
  });
}

describe('deriveIsometricVerdictCard (VW-264)', () => {
  it('shows nothing when no assessment has reported', () => {
    expect(derive({ result: null })).toEqual({ visible: false, card: null });
  });

  it('shows the card inside the dwell', () => {
    const { visible, card } = derive();
    expect(visible).toBe(true);
    expect(card?.asymmetryPct).toBe(16.2);
    expect(card?.verdict).toBe('meaningful');
    expect(card?.sides).toEqual([
      { label: 'LEFT', peakForceLbs: 180.4 },
      { label: 'RIGHT', peakForceLbs: 151.2 },
    ]);
  });

  it('still shows one millisecond before the dwell expires', () => {
    expect(derive({ nowMs: OCCURRED_AT + VERDICT_CARD_DWELL_MS - 1 }).visible).toBe(true);
  });

  it('hides once the dwell has elapsed', () => {
    expect(derive({ nowMs: OCCURRED_AT + VERDICT_CARD_DWELL_MS })).toEqual({
      visible: false,
      card: null,
    });
  });

  it('dismisses early when a set starts after the result', () => {
    expect(derive({ setStartMs: OCCURRED_AT + 500 })).toEqual({ visible: false, card: null });
  });

  it('keeps showing over a set that was already open when the result landed', () => {
    expect(derive({ setStartMs: OCCURRED_AT - 5000 }).visible).toBe(true);
  });

  it('dismisses early when the next hold begins', () => {
    expect(derive({ hold: hold() })).toEqual({ visible: false, card: null });
  });

  it('withholds the verdict on a setup-confounded result, naming the reason', () => {
    const { card } = derive({
      result: result({
        comparability: 'setup_confounded',
        verdict: 'meaningful',
        setupReason: 'the two sides’ cable travel differs by more than the gate allows',
      }),
    });
    expect(card?.verdict).toBeNull();
    expect(card?.withheldReason).toBe(
      'the two sides’ cable travel differs by more than the gate allows',
    );
  });

  it('falls back to the assessment reason when a confounded result carries no setup reason', () => {
    const { card } = derive({
      result: result({ comparability: 'setup_confounded', setupReason: null, reason: 'no gate' }),
    });
    expect(card?.withheldReason).toBe('no gate');
  });

  it('labels a single-sided result by its slot and prints no percentage', () => {
    const { card } = derive({
      result: result({
        tool: 'isometric.measure_max',
        sides: [{ side: null, slot: 'primary', peakForceLbs: 210 }],
        asymmetryPct: null,
        verdict: null,
      }),
    });
    expect(card?.sides).toEqual([{ label: 'PRIMARY', peakForceLbs: 210 }]);
    expect(card?.asymmetryPct).toBeNull();
    expect(card?.verdict).toBeNull();
  });
});
