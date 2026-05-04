// Unit tests for LiveState.
//
// Covers every branch in src/state/live-state.ts to satisfy NF-03 (≥80%
// branch coverage for src/state/). Tests are organized by mutator/snapshot
// pair plus a final group for cross-cutting invariants (independence of
// snapshots, stale-rep drop, null battery coercion).
import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';
import { LiveState, type ActiveSession, type ActiveSet } from '../live-state.js';

const TS_A = '2025-01-01T00:00:00.000Z';
const TS_B = '2025-01-01T00:01:00.000Z';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 'sess-1',
    startedAt: TS_A,
    setIds: [],
    status: 'active',
    ...overrides,
  };
}

function makeSet(overrides: Partial<ActiveSet> = {}): ActiveSet {
  return {
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: TS_A,
    reps: [],
    status: 'active',
    ...overrides,
  };
}

function makeRep(repNumber: number): Rep {
  // Construct a minimal Rep that satisfies the analytics interface for tests.
  // We rely on shape rather than runtime computation; LiveState never calls
  // analytics functions on these reps.
  const phase = {
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
  return { repNumber, concentric: phase, eccentric: phase };
}

describe('LiveState', () => {
  describe('initial state', () => {
    it('has a disconnected device, no session, no set', () => {
      const live = new LiveState();
      expect(live.device).toEqual({ connected: false });
      expect(live.session).toBeUndefined();
      expect(live.set).toBeUndefined();
      expect(live.snapshotSession()).toBeUndefined();
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('startSession / endSession', () => {
    it('startSession sets the active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      const snap = live.snapshotSession();
      expect(snap?.sessionId).toBe('sess-1');
      expect(snap?.status).toBe('active');
    });

    it('startSession is a no-op when a session is already active', () => {
      // Documented behavior: tool layer enforces SESSION_ALREADY_ACTIVE
      // (EC-14); LiveState chooses silent no-op so mutators stay total.
      const live = new LiveState();
      live.startSession(makeSession({ sessionId: 'first' }));
      live.startSession(makeSession({ sessionId: 'second' }));
      expect(live.snapshotSession()?.sessionId).toBe('first');
    });

    it('endSession returns the prior session with status=ended', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      const ended = live.endSession();
      expect(ended?.sessionId).toBe('sess-1');
      expect(ended?.status).toBe('ended');
      expect(live.snapshotSession()).toBeUndefined();
    });

    it('endSession returns undefined when no session is active', () => {
      const live = new LiveState();
      expect(live.endSession()).toBeUndefined();
    });
  });

  describe('startSet / endSet', () => {
    it('startSet sets the active set', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      expect(live.snapshotSet()?.setId).toBe('set-1');
    });

    it('startSet is a no-op when a set is already active', () => {
      const live = new LiveState();
      live.startSet(makeSet({ setId: 'first' }));
      live.startSet(makeSet({ setId: 'second' }));
      expect(live.snapshotSet()?.setId).toBe('first');
    });

    it('startSet → appendRep × 3 → endSet captures the reps', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      live.appendRep(makeRep(2));
      live.appendRep(makeRep(3));
      const finalized = live.endSet();
      expect(finalized?.reps).toHaveLength(3);
      expect(finalized?.reps.map((r) => r.repNumber)).toEqual([1, 2, 3]);
      expect(finalized?.status).toBe('ended');
      expect(finalized?.partialReason).toBeUndefined();
      expect(finalized?.endedAt).toBeDefined();
      expect(live.snapshotSet()).toBeUndefined();
    });

    it("endSet('session_end') marks set partial with partialReason='session_end'", () => {
      const live = new LiveState();
      live.startSet(makeSet());
      const finalized = live.endSet('session_end');
      expect(finalized?.status).toBe('partial');
      expect(finalized?.partialReason).toBe('session_end');
    });

    it("endSet('disconnect') marks set partial with partialReason='disconnect'", () => {
      const live = new LiveState();
      live.startSet(makeSet());
      const finalized = live.endSet('disconnect');
      expect(finalized?.status).toBe('partial');
      expect(finalized?.partialReason).toBe('disconnect');
    });

    it('endSet returns undefined when no set is active', () => {
      const live = new LiveState();
      expect(live.endSet()).toBeUndefined();
      expect(live.endSet('disconnect')).toBeUndefined();
    });

    it('endSet appends the setId to the active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()?.setIds).toEqual(['set-1']);
    });

    it('endSet does not duplicate an already-tracked setId', () => {
      const live = new LiveState();
      live.startSession(makeSession({ setIds: ['set-1'] }));
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()?.setIds).toEqual(['set-1']);
    });

    it('endSet without an active session leaves session state untouched', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.endSet();
      expect(live.snapshotSession()).toBeUndefined();
    });
  });

  describe('appendRep edge cases (EC-11)', () => {
    it('appendRep before startSet is silently dropped', () => {
      const live = new LiveState();
      live.appendRep(makeRep(1));
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('appendRep after endSet is silently dropped (no callback fired)', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      const finalized = live.endSet();
      expect(finalized?.reps).toHaveLength(1);
      // Stale rep arrives after endSet — must not mutate any visible state.
      live.appendRep(makeRep(2));
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('markDisconnected', () => {
    it('sets disconnectedAt on device only when no session is active', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, deviceId: 'd1' });
      live.markDisconnected(TS_B);
      expect(live.snapshotDevice()).toMatchObject({
        connected: false,
        disconnectedAt: TS_B,
      });
      expect(live.snapshotSession()).toBeUndefined();
    });

    it('propagates disconnectedAt to an active session', () => {
      const live = new LiveState();
      live.startSession(makeSession());
      live.markDisconnected(TS_B);
      expect(live.snapshotSession()?.disconnectedAt).toBe(TS_B);
      expect(live.snapshotDevice().disconnectedAt).toBe(TS_B);
    });
  });

  describe('applySettings', () => {
    it('coerces battery null → absent (critic FIX #6)', () => {
      const live = new LiveState();
      live.applySettings({
        connected: true,
        // Cast required: SDK runtime can deliver null even though our
        // typed surface forbids it.
        batteryPercent: null as unknown as number,
      });
      const snap = live.snapshotDevice();
      expect(snap.batteryPercent).toBeUndefined();
      expect('batteryPercent' in snap).toBe(false);
    });

    it('passes a real numeric battery value through', () => {
      const live = new LiveState();
      live.applySettings({ batteryPercent: 73 });
      expect(live.snapshotDevice().batteryPercent).toBe(73);
    });

    it('drops a previously-set battery when later update reports null', () => {
      const live = new LiveState();
      live.applySettings({ batteryPercent: 50 });
      live.applySettings({
        batteryPercent: null as unknown as number,
      });
      expect(live.snapshotDevice().batteryPercent).toBeUndefined();
    });

    it('merges multiple partial updates additively', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, deviceName: 'Voltra-1' });
      live.applySettings({ weightLbs: 100, trainingMode: 'WeightTraining' });
      expect(live.snapshotDevice()).toEqual({
        connected: true,
        deviceName: 'Voltra-1',
        weightLbs: 100,
        trainingMode: 'WeightTraining',
      });
    });
  });

  describe('snapshot independence', () => {
    it('snapshotDevice returns an independent copy', () => {
      const live = new LiveState();
      live.applySettings({ connected: true, deviceName: 'Voltra-1' });
      const snap = live.snapshotDevice();
      snap.deviceName = 'mutated';
      expect(live.snapshotDevice().deviceName).toBe('Voltra-1');
    });

    it('snapshotSession returns an independent copy with cloned setIds', () => {
      const live = new LiveState();
      live.startSession(makeSession({ setIds: ['s1'] }));
      const snap = live.snapshotSession();
      expect(snap).toBeDefined();
      snap!.setIds.push('mutated');
      snap!.exerciseId = 'x';
      expect(live.snapshotSession()?.setIds).toEqual(['s1']);
      expect(live.snapshotSession()?.exerciseId).toBeUndefined();
    });

    it('snapshotSet returns an independent copy with cloned reps', () => {
      const live = new LiveState();
      live.startSet(makeSet());
      live.appendRep(makeRep(1));
      const snap = live.snapshotSet();
      expect(snap).toBeDefined();
      snap!.reps.push(makeRep(99));
      expect(live.snapshotSet()?.reps).toHaveLength(1);
    });
  });
});
