// The cue record (VW-544): what the effort cue decided over a set, as stored with it.
// Every value is synthetic.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { cueRecordFor } from '../effort-cue.js';
import type { ActiveSet, DeviceSnapshot } from '../live-state.js';
import { openTestStore } from '../../store/__tests__/open-test-store.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

const PHASE: Phase = {
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

function repAt(repNumber: number, mps: number): Rep {
  const concentric = { ...PHASE, _totalVelocity: mps, _movementSampleCount: 1, peakVelocity: mps };
  return { repNumber, concentric, eccentric: PHASE } as Rep;
}

const SET: ActiveSet = {
  setId: 'set-1',
  sessionId: 'sess-1',
  startedAt: '2026-09-21T12:00:00.000Z',
  reps: [repAt(1, 1.0), repAt(2, 0.5), repAt(3, 0.5)],
  status: 'ended',
  watch: {
    notifyOn: [
      { type: 'rep_count_reached', value: 3 },
      { type: 'velocity_loss_exceeded', pct: 30, thresholdSource: 'explicit' },
    ],
  },
};

describe('cueRecordFor', () => {
  it('records the latched reason, what else became true, and the policy that judged the set', () => {
    expect(cueRecordFor(SET, DEVICE)).toMatchObject({
      policyId: 'effort/v1',
      policyVersion: 'effort-policy@1.0.0',
      basis: 'velocity_loss_table',
      goalKind: 'rep_range',
      reason: 'velocity_loss',
      reachedAtRep: 2,
      repsPastCue: 1,
      alsoTrue: [{ reason: 'reps', atRep: 3 }],
    });
  });

  it('round-trips through the store unchanged', async () => {
    const record = cueRecordFor(SET, DEVICE);
    const store = openTestStore();

    await store.putSet({
      id: 'set-1',
      sessionId: 'sess-1',
      startedAt: SET.startedAt,
      endedAt: '2026-09-21T12:01:00.000Z',
      partial: false,
      reps: [],
      cueRecord: record,
    });
    const stored = await store.getSet('set-1');
    await store.close();

    expect(stored?.cueRecord).toEqual(record);
  });
});
