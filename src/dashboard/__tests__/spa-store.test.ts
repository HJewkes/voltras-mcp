/**
 * Dashboard client store (VMCP-03.02). Covers the store actions that replaced the
 * 13-`useState` `useDashboardModel` hook — snapshot application (with the
 * `reduceSnapshot` fold moved into `applySnapshot`), the staleness tick, the
 * historical batch merge, and live-slice isolation. Pure/headless: drives the
 * vanilla store directly, no React.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { dashboardStore, STALE_THRESHOLD_MS } from '../spa/store';
import {
  initialAccumulatorState,
  type Rep,
  type Snapshot,
  type SnapshotActiveSet,
  type SnapshotDevice,
} from '../spa/adapter';
import type { LiveModel } from '../spa/live-stream';

function rep(repNumber: number, peakMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms },
    eccentric: {},
  } as unknown as Rep;
}

function snapshot(opts: {
  sessionId?: string | null;
  exerciseName?: string;
  device?: SnapshotDevice;
  activeSet?: SnapshotActiveSet | null;
}): Snapshot {
  const { sessionId, exerciseName, device, activeSet } = opts;
  return {
    session: sessionId == null ? null : { sessionId, exerciseName },
    devices: device ? [{ slotId: 'primary', device }] : [],
    sets: { active: activeSet ?? null },
  };
}

const liveModel = (velocity: number): LiveModel => ({
  connected: true,
  phase: 'con',
  phaseElapsedMs: 0,
  velocity,
  position: 100,
  force: 60,
  repInProgress: 1,
  lastRep: null,
});

/** Reset every data field between tests (the store is a module singleton). */
beforeEach(() => {
  dashboardStore.setState({
    snapshot: null,
    accumulator: initialAccumulatorState(),
    status: 'ok',
    lastUpdate: '—',
    nowMs: 0,
    lastSuccessMs: 0,
    trend: [],
    nextWorkout: null,
    prescription: null,
    program: null,
    muscleVolume: {},
    prRecords: [],
    capacityBand: [],
    meso: null,
    live: null,
  });
});

describe('dashboardStore — snapshot slice', () => {
  it('applySnapshot stores the snapshot and stamps status/clock/lastSuccess', () => {
    const snap = snapshot({ sessionId: 's1' });
    dashboardStore.getState().applySnapshot(snap, 1000);
    const s = dashboardStore.getState();
    expect(s.snapshot).toBe(snap);
    expect(s.status).toBe('ok');
    expect(s.nowMs).toBe(1000);
    expect(s.lastSuccessMs).toBe(1000);
    expect(s.lastUpdate).not.toBe('—');
  });

  it('applySnapshot folds the completed-set accumulator (reduceSnapshot as an action)', () => {
    const device: SnapshotDevice = { connected: true, weightLbs: 100, trainingMode: 'weight' };
    const activeSet: SnapshotActiveSet = { reps: [rep(1, 900)] };

    // active set open → nothing logged yet
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1', device, activeSet }), 1000);
    expect(dashboardStore.getState().accumulator.setLog).toHaveLength(0);
    expect(dashboardStore.getState().accumulator.restStartMs).toBeNull();

    // set closes (active → null) → logged + rest clock starts at `now`
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1', device }), 2000);
    const acc = dashboardStore.getState().accumulator;
    expect(acc.setLog).toHaveLength(1);
    expect(acc.restStartMs).toBe(2000);
  });

  it('markError surfaces the error state but keeps the last-known snapshot', () => {
    const snap = snapshot({ sessionId: 's1' });
    dashboardStore.getState().applySnapshot(snap, 1000);
    dashboardStore.getState().markError();
    expect(dashboardStore.getState().status).toBe('error');
    expect(dashboardStore.getState().snapshot).toBe(snap);
  });
});

describe('dashboardStore — staleness tick', () => {
  it('advances nowMs and flips ok → stale past the threshold', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    const now = 1000 + STALE_THRESHOLD_MS + 1;
    dashboardStore.getState().tick(now);
    const s = dashboardStore.getState();
    expect(s.nowMs).toBe(now);
    expect(s.status).toBe('stale');
  });

  it('keeps ok while the snapshot is still fresh', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    dashboardStore.getState().tick(1500);
    expect(dashboardStore.getState().status).toBe('ok');
  });

  it('error survives a stale tick (does not downgrade to stale)', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    dashboardStore.getState().markError();
    dashboardStore.getState().tick(1000 + STALE_THRESHOLD_MS + 1);
    expect(dashboardStore.getState().status).toBe('error');
  });

  it('never goes stale before the first successful poll', () => {
    dashboardStore.getState().tick(999_999);
    expect(dashboardStore.getState().status).toBe('ok');
  });
});

describe('dashboardStore — historical slice', () => {
  it('applyHistorical merges a partial batch, leaving unlisted fields intact', () => {
    dashboardStore.getState().applyHistorical({ muscleVolume: { chest: 12 } });
    expect(dashboardStore.getState().muscleVolume).toEqual({ chest: 12 });
    expect(dashboardStore.getState().trend).toEqual([]);

    dashboardStore.getState().applyHistorical({ prRecords: [] });
    expect(dashboardStore.getState().muscleVolume).toEqual({ chest: 12 }); // untouched
  });
});

describe('dashboardStore — rev-guarded snapshot application (VMCP-03.04)', () => {
  const withRev = (snap: Snapshot, rev: number): Snapshot => ({ ...snap, rev });

  it('applies a strictly-newer rev and drops stale/equal revs', () => {
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'a' }), 5), 1000);
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('a');

    // stale (lower) — dropped
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'b' }), 4), 1100);
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('a');
    // equal — dropped
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'c' }), 5), 1200);
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('a');
    // newer — applied
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'd' }), 6), 1300);
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('d');
  });

  it('never double-logs a set when a stale poll trails a fresh SSE close', () => {
    const device: SnapshotDevice = { connected: true, weightLbs: 100, trainingMode: 'weight' };
    const activeSet: SnapshotActiveSet = { reps: [rep(1, 900)] };

    // set open (rev 10), then the SSE push closes it (rev 11) → logged once
    dashboardStore
      .getState()
      .applySnapshot(withRev(snapshot({ sessionId: 's1', device, activeSet }), 10), 1000);
    dashboardStore
      .getState()
      .applySnapshot(withRev(snapshot({ sessionId: 's1', device }), 11), 2000);
    expect(dashboardStore.getState().accumulator.setLog).toHaveLength(1);

    // a slow poll built before the close (still shows the active set, rev 10) lands late:
    // dropped by the guard, so the fold never re-opens then re-logs the set.
    dashboardStore
      .getState()
      .applySnapshot(withRev(snapshot({ sessionId: 's1', device, activeSet }), 10), 2100);
    expect(dashboardStore.getState().accumulator.setLog).toHaveLength(1);
    expect(dashboardStore.getState().accumulator.restStartMs).toBe(2000);
  });

  it('markError resets the guard so the next snapshot applies after a server restart', () => {
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'a' }), 500), 1000);
    dashboardStore.getState().markError(); // connection blip; server rev counter rewinds
    // a post-restart snapshot with a low rev must still apply
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'b' }), 1), 2000);
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('b');
  });

  it('always applies rev-less snapshots (hand-built / empty)', () => {
    dashboardStore.getState().applySnapshot(withRev(snapshot({ sessionId: 'a' }), 9), 1000);
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 'b' }), 1100); // no rev
    expect(dashboardStore.getState().snapshot?.session?.sessionId).toBe('b');
  });
});

describe('dashboardStore — live slice isolation', () => {
  it('setLive updates only the live slice; shell-read references stay stable', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    dashboardStore.getState().applyHistorical({ muscleVolume: { chest: 12 } });
    const before = dashboardStore.getState();

    dashboardStore.getState().setLive(liveModel(0.5));
    const after = dashboardStore.getState();

    expect(after.live?.velocity).toBe(0.5);
    // A ~20 Hz live write must not churn the objects the shell selectors read,
    // or the whole dashboard would re-render at 20 Hz.
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.accumulator).toBe(before.accumulator);
    expect(after.muscleVolume).toBe(before.muscleVolume);
  });
});
