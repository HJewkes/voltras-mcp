// Unit tests for the deterministic cue policy.
//
// The decisions are exercised against the REAL channel-payload builders
// (`channel-payloads.ts`) rather than hand-rolled meta/content, so if a
// producer renames a field the slot extraction breaks here first. The Rep/
// phase fixture helpers mirror `channel-payloads.test.ts`.

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import {
  buildRepFinalizedPayload,
  buildSetEndedPayload,
  buildSetStartedPayload,
  buildSetTargetReachedPayload,
  buildVelocityLossExceededPayload,
} from '../../state/channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import type { StoredSet } from '../../store/types.js';
import { decideCue } from '../cue-policy.js';

// Native WA scale: peakVelocity in mm/s, positions in mm. Mirrors the fixture
// builders in channel-payloads.test.ts.
function makePhase(
  overrides: Partial<{
    samples: number;
    peakVelocity: number;
    movementSampleCount: number;
    startTime: number;
    endTime: number;
    startPos: number;
    endPos: number;
  }>,
): Rep['concentric'] {
  const samples = overrides.samples ?? 0;
  const sampleArr: Rep['concentric']['samples'] = [];
  for (let i = 0; i < samples; i++) {
    sampleArr.push({
      sequence: i,
      timestamp: (overrides.startTime ?? 0) + i * 50,
      phase: 1 as Rep['concentric']['samples'][number]['phase'],
      position: 0,
      velocity: 0,
      force: 0,
    });
  }
  return {
    samples: sampleArr,
    startTime: overrides.startTime ?? 0,
    endTime: overrides.endTime ?? 0,
    startPosition: overrides.startPos ?? 0,
    endPosition: overrides.endPos ?? 0,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: overrides.movementSampleCount ?? 0,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: 0,
    peakVelocity: overrides.peakVelocity ?? 0,
    peakForce: 0,
    peakLoad: 0,
  };
}

function makeRep(repNumber: number, concPeak: number, eccPeak: number): Rep {
  return {
    repNumber,
    concentric: makePhase({
      samples: 4,
      peakVelocity: concPeak,
      movementSampleCount: 4,
      startTime: 1000,
      endTime: 1400,
      startPos: 0,
      endPos: 600,
    }),
    eccentric: makePhase({
      samples: 4,
      peakVelocity: eccPeak,
      movementSampleCount: 4,
      startTime: 1400,
      endTime: 1900,
      startPos: 600,
      endPos: 0,
    }),
  };
}

const device: DeviceSnapshot = {
  connected: true,
  weightLbs: 135,
  trainingMode: 'WeightTraining',
};

function activeSet(reps: Rep[] = []): ActiveSet {
  return {
    setId: 'set-abc',
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    reps,
    status: 'active',
  };
}

function storedSet(reps: Rep[]): StoredSet {
  return {
    id: 'set-abc',
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:01:30.000Z', // 90s
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 135,
    reps: reps.map((r, i) => ({ ...r, id: `r${i}`, setId: 'set-abc', index: i })),
  };
}

describe('decideCue — set_started → set_intro', () => {
  it('extracts weight + ordinal from the real payload', () => {
    const event = buildSetStartedPayload(activeSet(), device, 3, null);
    const decision = decideCue(event);
    expect(decision).toEqual({
      category: 'set_intro',
      slots: { weight: 135, ordinal: 3 },
      priority: 'normal',
      setId: 'set-abc',
    });
  });

  it('omits the weight slot when the device has no recorded weight', () => {
    const noWeight: DeviceSnapshot = { connected: true, trainingMode: 'WeightTraining' };
    const event = buildSetStartedPayload(activeSet(), noWeight, 2, null);
    const decision = decideCue(event);
    expect(decision).not.toBeNull();
    expect(decision?.category).toBe('set_intro');
    expect(decision?.slots.weight).toBeUndefined();
    expect(decision?.slots.ordinal).toBe(2);
  });
});

describe('decideCue — set_target_reached → target_hit', () => {
  it('extracts target + actual rep counts', () => {
    const event = buildSetTargetReachedPayload(activeSet([makeRep(1, 800, 500)]), device, 8, 5);
    expect(decideCue(event)).toEqual({
      category: 'target_hit',
      slots: { target: 8, actual: 5 },
      priority: 'normal',
      setId: 'set-abc',
    });
  });
});

describe('decideCue — velocity_loss_exceeded → slowdown (urgent)', () => {
  it('extracts pct + rep and marks the cue urgent', () => {
    const set = activeSet([makeRep(1, 850, 500), makeRep(2, 550, 400)]);
    const event = buildVelocityLossExceededPayload(set, device, 25, 35.3, 850, 550, 1, 2);
    expect(decideCue(event)).toEqual({
      category: 'slowdown',
      slots: { pct: 35.3, rep: 2 },
      priority: 'urgent',
      setId: 'set-abc',
    });
  });
});

describe('decideCue — set_ended → set_complete', () => {
  it('extracts reps, seconds, and velocity loss', () => {
    // Two reps 850→500 mm/s peak → 41.2% peak-to-last loss; 90s duration.
    const event = buildSetEndedPayload(storedSet([makeRep(1, 850, 500), makeRep(2, 500, 400)]));
    expect(decideCue(event)).toEqual({
      category: 'set_complete',
      slots: { reps: 2, seconds: 90, loss: 41.2 },
      priority: 'normal',
      setId: 'set-abc',
    });
  });

  it('omits the loss slot when velocity_loss_pct is null (single rep)', () => {
    const event = buildSetEndedPayload(storedSet([makeRep(1, 700, 400)]));
    const decision = decideCue(event);
    expect(decision?.category).toBe('set_complete');
    expect(decision?.slots.reps).toBe(1);
    expect(decision?.slots.loss).toBeUndefined();
  });
});

describe('decideCue — non-cue events → null', () => {
  it('returns null for a rep_finalized payload', () => {
    const event = buildRepFinalizedPayload(makeRep(1, 800, 500), 0, activeSet(), device, 1);
    expect(decideCue(event)).toBeNull();
  });

  it('returns null for a hand-made wake_word_detected event', () => {
    expect(
      decideCue({ meta: { event_type: 'wake_word_detected', set_id: 'set-abc' }, content: '{}' }),
    ).toBeNull();
  });

  it('returns null for a hand-made rep_finalized event with empty content', () => {
    expect(decideCue({ meta: { event_type: 'rep_finalized' }, content: '{}' })).toBeNull();
  });
});

describe('decideCue — defensive guards', () => {
  it('returns null when set_id is missing', () => {
    expect(
      decideCue({
        meta: { event_type: 'set_ended', rep_count: '5', duration_ms: '90000' },
        content: '{}',
      }),
    ).toBeNull();
  });

  it('returns null when a required numeric field is NaN', () => {
    expect(
      decideCue({
        meta: {
          event_type: 'set_ended',
          set_id: 'set-abc',
          rep_count: 'notanumber',
          duration_ms: '90000',
        },
        content: '{}',
      }),
    ).toBeNull();
  });
});
