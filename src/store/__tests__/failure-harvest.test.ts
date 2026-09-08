// Criterion v1 for the failure-anchor harvest filter (VW-174 / B59).
//
// The hazard case is the one that matters: a set cut short because something
// hurt looks exactly like a failure to a naive stall test, and yields an anchor
// that reads FASTER than the truth — which then tells the lifter they have reps
// left when they do not. It must be stored as an abort and must not count.

import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { evaluateFailureCandidate } from '../failure-harvest.js';
import type { StoredRep, StoredSet } from '../types.js';

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
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** One rep with a chosen concentric mean velocity and range of motion. */
function rep(index: number, vCon: number, rom: number): StoredRep {
  return {
    id: `rep-${String(index)}`,
    setId: 'set-1',
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      _totalVelocity: vCon,
      _movementSampleCount: 1,
      _lastMovementVelocity: vCon,
      peakVelocity: vCon,
      endPosition: rom,
    },
    eccentric: EMPTY_PHASE,
  };
}

/** `velocities` and `roms` are positionally paired, one entry per rep. */
function setOf(velocities: number[], roms: number[], over: Partial<StoredSet> = {}): StoredSet {
  return {
    id: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:01:00.000Z',
    partial: false,
    weightLbs: 100,
    reps: velocities.map((v, i) => rep(i, v, roms[i])),
    ...over,
  };
}

const FULL_ROM = [0.5, 0.5, 0.5, 0.5, 0.5];

describe('evaluateFailureCandidate — criterion v1', () => {
  it('labels a decay-to-stall set as a failure and reports its terminal velocity', () => {
    // Reps grind down 0.62 -> 0.40 m/s at full range: the shape of a set that
    // ran out, not one that was stopped.
    const result = evaluateFailureCandidate(setOf([0.6, 0.62, 0.55, 0.48, 0.4], FULL_ROM));

    expect(result.verdict).toBe('failure');
    expect(result.terminalVelocityMps).toBe(0.4);
    expect(result.inputs.decayTrajectory).toBe(true);
    expect(result.inputs.stallRatio).toBeLessThanOrEqual(0.7);
  });

  it('stores a short-ROM termination with no preceding decay as an abort (the injury hazard)', () => {
    // Velocities hold flat and the final rep is a half rep. This is what a
    // lifter racking early because something hurt produces.
    const result = evaluateFailureCandidate(
      setOf([0.6, 0.62, 0.58, 0.62, 0.4], [0.5, 0.5, 0.5, 0.5, 0.18]),
    );

    expect(result.verdict).toBe('abort');
    expect(result.inputs.decayTrajectory).toBe(false);
    expect(result.inputs.romRatio).toBeLessThan(0.65);
  });

  it('aborts on a missing decay trajectory even when the final ROM is intact', () => {
    const result = evaluateFailureCandidate(setOf([0.6, 0.62, 0.58, 0.62, 0.4], FULL_ROM));

    expect(result.verdict).toBe('abort');
    expect(result.inputs.reason).toContain('no preceding velocity decay');
  });

  it('aborts on a collapsed final ROM even when the decay trajectory is there', () => {
    const result = evaluateFailureCandidate(
      setOf([0.6, 0.62, 0.55, 0.48, 0.4], [0.5, 0.5, 0.5, 0.5, 0.18]),
    );

    expect(result.verdict).toBe('abort');
    expect(result.inputs.reason).toContain('ROM collapsed');
  });

  it('is not a candidate when the final rep never stalled', () => {
    const result = evaluateFailureCandidate(setOf([0.6, 0.62, 0.6, 0.58, 0.57], FULL_ROM));

    expect(result.verdict).toBe('not_candidate');
    expect(result.inputs.reason).toBe('final rep never stalled');
    expect(result.terminalVelocityMps).toBeUndefined();
  });

  it('is not a candidate for a warm-up, however it ended', () => {
    const warmup = setOf([0.6, 0.62, 0.55, 0.48, 0.4], FULL_ROM, { isWarmup: true });

    expect(evaluateFailureCandidate(warmup).verdict).toBe('not_candidate');
  });

  it('is not a candidate below the four-rep floor', () => {
    const short = setOf([0.6, 0.62, 0.4], [0.5, 0.5, 0.5]);

    expect(evaluateFailureCandidate(short)).toMatchObject({
      verdict: 'not_candidate',
      inputs: { reason: 'fewer than 4 reps' },
    });
  });

  it('ignores rep 1 when picking the stall reference', () => {
    // Rep 1 is routinely a cable-engagement artifact. A set whose rep 1 was a
    // slow scrape must still be measured against the fastest REAL rep.
    const result = evaluateFailureCandidate(setOf([0.2, 0.62, 0.55, 0.48, 0.4], FULL_ROM));

    expect(result.inputs.referenceVelocityMps).toBe(0.62);
    expect(result.verdict).toBe('failure');
  });

  it('normalises a device_native set before evaluating it (VW-160)', () => {
    // Identical set, recorded before the bridge conversion: mm/s on disk. The
    // verdict must match and the stored terminal velocity must be m/s, not
    // 1000x it.
    const native = setOf([600, 620, 550, 480, 400], FULL_ROM, {
      velocityUnits: 'device_native',
    });

    const result = evaluateFailureCandidate(native);

    expect(result.verdict).toBe('failure');
    expect(result.terminalVelocityMps).toBe(0.4);
    expect(result.inputs.referenceVelocityMps).toBe(0.62);
  });

  it('records session position and set index without judging on them', () => {
    const result = evaluateFailureCandidate(setOf([0.6, 0.62, 0.55, 0.48, 0.4], FULL_ROM), {
      setIndexInSession: 4,
      sessionPositionSec: 1830,
    });

    expect(result.inputs.setIndexInSession).toBe(4);
    expect(result.inputs.sessionPositionSec).toBe(1830);
    expect(result.verdict).toBe('failure');
  });
});
