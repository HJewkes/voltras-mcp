// VMCP-02.63: the movement-class gate on the progression side.
//
// The 25% velocity-loss hold and the B07 effort gate both read
// `setVelocityLossPct`, which reads peak concentric velocity. On a ballistic
// pull that figure does not track fatigue, so a pull session must neither
// trigger the hold nor be called `easy` — it has no effort verdict at all.
//
// Every case below drives the SAME 50% decaying velocities through the SAME
// rep band; only `exerciseId` differs, so any difference in the suggestion is
// the class gate and nothing else.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '@voltras/workout-analytics';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError, TrainingMode: {}, TrainingModeNames: {} };
});

const { computeProgressionDelta } = await import('../plan-tools.js');

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** A cable row: the catalog's `pull`, and the movement VMCP-02.63 was filed on. */
const PULL = 'cable-row';
/** A cable chest press: the catalog's `push`, and the control for every case. */
const PUSH = 'cable-chest-press';

const BASIS = 'sess-prior';

function makeRep(setId: string, index: number, peakVelocity: number): StoredRep {
  const rep = {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity },
    eccentric: { ...EMPTY_PHASE, peakVelocity: peakVelocity * 0.7 },
  } as Rep;
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

/** Peak velocity decaying 1000 -> 500 across `repCount` reps: a 50% loss. */
function decayingVelocities(repCount: number): number[] {
  return Array.from({ length: repCount }, (_, i) => 1000 - (500 * i) / (repCount - 1));
}

function setWithDecay(setId: string, exerciseId: string, repCount: number): StoredSet {
  const velocities = decayingVelocities(repCount);
  return {
    id: setId,
    sessionId: BASIS,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:01:00.000Z',
    partial: false,
    weightLbs: 135,
    exerciseId,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(setId, i, velocities[i])),
  } as StoredSet;
}

function plannedBand(exerciseId: string): StoredPlannedExercise {
  return {
    id: `pe-${exerciseId}`,
    workoutTemplateId: 'tmpl-1',
    exerciseId,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 12,
  };
}

/** Three topped-out sets of 12 at a 50% within-set velocity loss. */
function toppedOutSession(exerciseId: string): StoredSet[] {
  return ['s1', 's2', 's3'].map((id) => setWithDecay(id, exerciseId, 12));
}

describe('computeProgressionDelta — movement-class gate (VMCP-02.63)', () => {
  beforeEach(() => {
    // The catalog is module-global state seeded at bootstrap; without this the
    // lookup returns undefined and every class reads `unknown`.
    (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(
      SEED_CABLE_EXERCISES,
    );
  });

  it('holds the load on a push session at 50% loss', () => {
    const suggestion = computeProgressionDelta(plannedBand(PUSH), toppedOutSession(PUSH), BASIS);

    expect(suggestion.delta).toBe(0);
    expect(suggestion.reasoning).toContain('velocity dropped');
    expect(suggestion.gates.effort).toBe('hard');
  });

  it('skips the hold on a pull session at the identical 50% loss', () => {
    const suggestion = computeProgressionDelta(plannedBand(PULL), toppedOutSession(PULL), BASIS);

    expect(suggestion.delta).toBeGreaterThan(0);
    expect(suggestion.reasoning).not.toContain('velocity dropped');
  });

  it('reports effort unknown on a pull session rather than calling it easy', () => {
    const suggestion = computeProgressionDelta(plannedBand(PULL), toppedOutSession(PULL), BASIS);

    expect(suggestion.gates.effort).toBe('unknown');
    // The sets gate is downstream of the effort gate, so it stays shut too:
    // no set is unlocked on evidence the signal cannot supply.
    expect(suggestion.gates.setsUnlocked).toBe(false);
  });

  it('leaves an unidentified exercise on the ungated path', () => {
    const sets = toppedOutSession('not-in-the-catalog');
    const suggestion = computeProgressionDelta(plannedBand('not-in-the-catalog'), sets, BASIS);

    expect(suggestion.delta).toBe(0);
    expect(suggestion.gates.effort).toBe('hard');
  });
});
