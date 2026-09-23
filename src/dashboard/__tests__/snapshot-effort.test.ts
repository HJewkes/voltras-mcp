// `effort` on the snapshot's sets (VW-543): the active set, each finished set and
// the per-slot sets carry the resolver's answer, which nothing in the SPA reads yet.
// Every value is synthetic.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EffortSetContext } from '@voltras/workout-analytics';

import type { PinnedEffortContext } from '../../state/effort-context.js';
import type { ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import { recordWithEffort, withEffort } from '../read-models/snapshot.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

const SET: ActiveSet = {
  setId: 'set-1',
  sessionId: 'sess-1',
  startedAt: '2026-09-21T12:00:00.000Z',
  reps: [],
  status: 'active',
  watch: { notifyOn: [{ type: 'velocity_loss_exceeded', pct: 20, thresholdSource: 'explicit' }] },
};

describe('effort on the snapshot', () => {
  // Type-checked by `typecheck:tests`: the build fails if the pinned shape drifts from the library's.
  it('pins a context the library accepts as its own', () => {
    expectTypeOf<PinnedEffortContext>().toMatchTypeOf<EffortSetContext>();
  });

  it('resolves the active set against the live device', () => {
    const view = withEffort(SET, DEVICE);

    expect(view.setId).toBe('set-1');
    expect(view.effort?.goal).toEqual({ kind: 'velocity_loss', lossPct: 20, source: 'explicit' });
  });

  it('resolves a finished set against the snapshot it closed with', () => {
    const record = recordWithEffort({
      set: { ...SET, status: 'ended' },
      device: { ...DEVICE, eccentricPercentTenths: 200 },
    });

    expect(record.effort?.policyId).toBe('effort/v1');
    expect(record.set.setId).toBe('set-1');
  });

  it('sends effort as null, and the set unchanged, when the resolver cannot read it', () => {
    const view = withEffort({ ...SET, effortContext: { goal: null } }, DEVICE);

    expect(view.effort).toBeNull();
    expect(view.setId).toBe('set-1');
  });
});
