// Unit tests for src/store/baseline-gate.ts (VW-90 / B57).
//
// The module is a pure enum-to-tier lookup, so the tests are pure too: the
// only double is a one-method fake store for `checkFeatureGate`.

import { describe, expect, it } from 'vitest';
import type { BaselineKey } from '@voltras/workout-analytics';

import {
  BASELINE_STATE_RANK,
  FEATURE_GATE_REQUIREMENTS,
  checkFeatureGate,
  deriveAllFeatureGates,
  deriveFeatureGate,
  describeBaselineState,
  type GatedFeature,
} from '../baseline-gate.js';
import { LOCAL_USER_ID, type BaselineState, type StoredExerciseBaseline } from '../types.js';

const ALL_STATES: BaselineState[] = ['COLD', 'SHAPE_ONLY', 'PROVISIONAL', 'CALIBRATED', 'STALE'];
const ALL_FEATURES: GatedFeature[] = ['relative-signal', 'readiness-score', 'rir-estimate'];

function makeBaseline(overrides: Partial<StoredExerciseBaseline> = {}): StoredExerciseBaseline {
  return {
    id: 'local|bench-press',
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    state: 'CALIBRATED',
    confidence: 0.85,
    observedSessions: 4,
    anchorCount: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    algorithmVersion: 'baseline@1.0.0',
    ...overrides,
  };
}

function activations(baseline: StoredExerciseBaseline | undefined): Record<string, string> {
  const gates = deriveAllFeatureGates(baseline);
  return {
    'relative-signal': gates['relative-signal'].activation,
    'readiness-score': gates['readiness-score'].activation,
    'rir-estimate': gates['rir-estimate'].activation,
  };
}

describe('deriveFeatureGate — no baseline row', () => {
  it('reports the key as not evaluable rather than as a failed gate', () => {
    // Arrange / Act
    const verdict = deriveFeatureGate(undefined, 'readiness-score');

    // Assert
    expect(verdict.evaluable).toBe(false);
    expect(verdict.observedState).toBeNull();
    expect(verdict.confidence).toBeNull();
    expect(verdict.activation).toBe('withheld');
    expect(verdict.reasoning).toContain('no baseline row has ever been computed');
  });

  it('withholds every feature with a populated user message', () => {
    // Arrange / Act
    const gates = deriveAllFeatureGates(undefined);

    // Assert
    expect(activations(undefined)).toEqual({
      'relative-signal': 'withheld',
      'readiness-score': 'withheld',
      'rir-estimate': 'withheld',
    });
    for (const feature of ALL_FEATURES) {
      expect(gates[feature].userMessage).toBe('still learning this exercise — no baseline yet');
    }
  });
});

describe('deriveFeatureGate — per-state activation', () => {
  it('withholds everything at COLD, but the key IS evaluable', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'COLD', confidence: 0 });

    // Act / Assert
    expect(deriveFeatureGate(baseline, 'relative-signal').evaluable).toBe(true);
    expect(activations(baseline)).toEqual({
      'relative-signal': 'withheld',
      'readiness-score': 'withheld',
      'rir-estimate': 'withheld',
    });
  });

  it('opens relative signals fully at SHAPE_ONLY while reps-to-failure stays shut', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'SHAPE_ONLY', confidence: 0.3 });

    // Act / Assert
    expect(activations(baseline)).toEqual({
      'relative-signal': 'full',
      'readiness-score': 'degraded',
      'rir-estimate': 'withheld',
    });
  });

  it('lets an RIR estimate through as a rough read at PROVISIONAL', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'PROVISIONAL', confidence: 0.5 });

    // Act / Assert
    expect(activations(baseline)).toEqual({
      'relative-signal': 'full',
      'readiness-score': 'degraded',
      'rir-estimate': 'degraded',
    });
    expect(deriveFeatureGate(baseline, 'rir-estimate').userMessage).toBe(
      'early baseline — treat this as a rough read',
    );
  });

  it('activates everything at CALIBRATED and carries confidence through unmodified', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'CALIBRATED', confidence: 0.91 });

    // Act
    const gates = deriveAllFeatureGates(baseline);

    // Assert
    expect(activations(baseline)).toEqual({
      'relative-signal': 'full',
      'readiness-score': 'full',
      'rir-estimate': 'full',
    });
    for (const feature of ALL_FEATURES) {
      expect(gates[feature].confidence).toBe(0.91);
      expect(gates[feature].userMessage).toBe('baseline calibrated');
    }
  });

  it('reports a null confidence when the row recorded none', () => {
    // Arrange
    const baseline = makeBaseline();
    delete baseline.confidence;

    // Act / Assert
    expect(deriveFeatureGate(baseline, 'rir-estimate').confidence).toBeNull();
  });
});

describe('deriveFeatureGate — STALE is never fully trusted', () => {
  it('caps a would-be full activation at degraded and records staleSince', () => {
    // Arrange: STALE ranks with SHAPE_ONLY, which fully satisfies relative-signal
    const baseline = makeBaseline({
      state: 'STALE',
      confidence: 0.2,
      invalidatedAt: '2026-07-20T12:00:00.000Z',
    });

    // Act
    const verdict = deriveFeatureGate(baseline, 'relative-signal');

    // Assert
    expect(BASELINE_STATE_RANK.STALE).toBe(BASELINE_STATE_RANK.SHAPE_ONLY);
    expect(verdict.activation).toBe('degraded');
    expect(verdict.staleSince).toBe('2026-07-20T12:00:00.000Z');
    expect(verdict.reasoning).toContain('STALE');
    expect(verdict.userMessage).toContain('out of date');
  });

  it('leaves no feature at full activation', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'STALE', confidence: 0.2 });

    // Act / Assert: the cap demotes, it never promotes a withheld feature
    expect(activations(baseline)).toEqual({
      'relative-signal': 'degraded',
      'readiness-score': 'degraded',
      'rir-estimate': 'withheld',
    });
  });

  it('omits staleSince when the row never recorded an invalidation time', () => {
    // Arrange
    const baseline = makeBaseline({ state: 'STALE' });

    // Act / Assert
    expect(deriveFeatureGate(baseline, 'relative-signal').staleSince).toBeUndefined();
  });
});

describe('deriveFeatureGate — invariants across every state × feature', () => {
  it('always explains itself, to both audiences', () => {
    for (const state of ALL_STATES) {
      for (const feature of ALL_FEATURES) {
        // Arrange / Act
        const verdict = deriveFeatureGate(makeBaseline({ state }), feature);

        // Assert
        expect(verdict.reasoning.length).toBeGreaterThan(0);
        expect(verdict.userMessage.length).toBeGreaterThan(0);
        expect(verdict.feature).toBe(feature);
        expect(verdict.observedState).toBe(state);
      }
    }
  });

  it('never activates a feature fully below its required rank', () => {
    for (const state of ALL_STATES) {
      for (const feature of ALL_FEATURES) {
        // Arrange / Act
        const verdict = deriveFeatureGate(makeBaseline({ state }), feature);

        // Assert
        if (verdict.activation === 'full') {
          expect(BASELINE_STATE_RANK[state]).toBeGreaterThanOrEqual(
            BASELINE_STATE_RANK[FEATURE_GATE_REQUIREMENTS[feature].full],
          );
          expect(state).not.toBe('STALE');
        }
      }
    }
  });
});

describe('checkFeatureGate', () => {
  const KEY: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  it('grades the row the store returns for the key', async () => {
    // Arrange
    const baseline = makeBaseline({ state: 'SHAPE_ONLY', confidence: 0.4 });
    const store = { getBaseline: async (): Promise<StoredExerciseBaseline> => baseline };

    // Act
    const verdict = await checkFeatureGate(store, KEY, 'readiness-score');

    // Assert
    expect(verdict).toEqual(deriveFeatureGate(baseline, 'readiness-score'));
  });

  it('withholds when the store has no row for the key', async () => {
    // Arrange
    const store = { getBaseline: async (): Promise<undefined> => undefined };

    // Act
    const verdict = await checkFeatureGate(store, KEY, 'rir-estimate');

    // Assert
    expect(verdict.evaluable).toBe(false);
    expect(verdict.activation).toBe('withheld');
  });
});

describe('deriveAllFeatureGates', () => {
  it('returns exactly one verdict per gated feature, keyed by its own name', () => {
    // Arrange / Act
    const gates = deriveAllFeatureGates(makeBaseline());

    // Assert
    expect(Object.keys(gates).sort()).toEqual([...ALL_FEATURES].sort());
    for (const feature of ALL_FEATURES) {
      expect(gates[feature].feature).toBe(feature);
    }
  });
});

describe('describeBaselineState', () => {
  it('reports the never-computed case distinctly from COLD', () => {
    // Arrange / Act / Assert
    expect(describeBaselineState(undefined)).toBe('still learning this exercise — no baseline yet');
    expect(describeBaselineState(makeBaseline({ state: 'COLD' }))).toBe(
      'still learning this exercise — not enough consistent sets yet',
    );
  });

  it('reports one feature-agnostic message per state', () => {
    // Arrange
    const expected: Record<BaselineState, string> = {
      COLD: 'still learning this exercise — not enough consistent sets yet',
      SHAPE_ONLY: 'learning this exercise — movement shape known, no failure reference yet',
      PROVISIONAL: 'early baseline — treat this as a rough read',
      CALIBRATED: 'baseline calibrated',
      STALE: 'baseline is out of date — no qualifying set in the last 28 days',
    };

    // Act / Assert
    for (const state of ALL_STATES) {
      expect(describeBaselineState(makeBaseline({ state }))).toBe(expected[state]);
    }
  });
});
