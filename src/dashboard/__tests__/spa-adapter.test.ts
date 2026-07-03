// Unit tests for the Phase 1 SPA snapshot→props adapter (VMCP-01.45).
//
// Focus: the client-side completed-set accumulator (reduceSnapshot) that mirrors
// the legacy dashboard-html.ts updateSetLog/updateRestState state machine, plus
// the unit-conversion formatters. Pure logic, node environment — no DOM.

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import {
  buildCurrentSet,
  buildSessionProgress,
  buildSetLogRows,
  fmtElapsed,
  fmtMode,
  fmtVelocity,
  fmtWeight,
  initialAccumulatorState,
  reduceSnapshot,
  toMps,
  type Snapshot,
  type SnapshotActiveSet,
  type SnapshotDevice,
} from '../spa/adapter.js';

/** Build a Rep whose concentric peak velocity (mm/s) is `peakMms`. */
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

describe('formatters (legacy parity)', () => {
  it('fmtVelocity converts mm/s → m/s with 2 decimals', () => {
    expect(fmtVelocity(741)).toBe('0.74 m/s');
    expect(fmtVelocity(1000)).toBe('1.00 m/s');
    expect(fmtVelocity(null)).toBe('—');
    expect(fmtVelocity(undefined)).toBe('—');
  });

  it('toMps converts mm/s → m/s number (2dp)', () => {
    expect(toMps(741)).toBe(0.74);
    expect(toMps(null)).toBeNull();
  });

  it('fmtWeight formats lbs with 1 decimal', () => {
    expect(fmtWeight(135)).toBe('135.0 lbs');
    expect(fmtWeight(null)).toBe('—');
  });

  it('fmtMode spaces camelCase modes', () => {
    expect(fmtMode('weightTraining')).toBe('weight Training');
    expect(fmtMode(null)).toBe('—');
  });

  it('fmtElapsed renders M:SS', () => {
    expect(fmtElapsed(0)).toBe('0:00');
    expect(fmtElapsed(65_000)).toBe('1:05');
    expect(fmtElapsed(600_000)).toBe('10:00');
  });
});

describe('buildCurrentSet', () => {
  it('reports inactive when no active set', () => {
    const view = buildCurrentSet(snapshot({ sessionId: 's1' }));
    expect(view.active).toBe(false);
    expect(view.reps).toBe(0);
    expect(view.velocitiesMps).toEqual([]);
  });

  it('maps weight/mode/reps/latest-peak/target and per-rep velocities', () => {
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        device: { connected: true, weightLbs: 135, trainingMode: 'isokinetic' },
        activeSet: {
          reps: [rep(1, 800), rep(2, 700), rep(3, 650)],
          latestInProgress: { targetWeightTenths: 1400 },
        },
      }),
    );
    expect(view.active).toBe(true);
    expect(view.weight).toBe('135.0 lbs');
    expect(view.mode).toBe('isokinetic');
    expect(view.reps).toBe(3);
    expect(view.latestPeakVelocity).toBe('0.65 m/s'); // latest rep, mm/s→m/s
    expect(view.targetWeight).toBe('140.0 lbs'); // tenths/10
    expect(view.velocitiesMps).toEqual([0.8, 0.7, 0.65]);
  });

  it('falls back to target weight when device weight is absent', () => {
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        activeSet: { reps: [], latestInProgress: { targetWeightTenths: 1000 } },
      }),
    );
    expect(view.weight).toBe('100.0 lbs');
  });
});

describe('reduceSnapshot — completed-set accumulation', () => {
  it('logs a set only when active transitions non-null → null', () => {
    let state = initialAccumulatorState();
    const device: SnapshotDevice = { connected: true, weightLbs: 100, trainingMode: 'weight' };
    const activeSet: SnapshotActiveSet = { reps: [rep(1, 900), rep(2, 800)] };

    // Tick 1: set active — nothing logged yet.
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', device, activeSet }), 1_000);
    expect(state.setLog).toHaveLength(0);
    expect(state.restStartMs).toBeNull();

    // Tick 2: still active — still nothing.
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', device, activeSet }), 1_500);
    expect(state.setLog).toHaveLength(0);

    // Tick 3: set closed — one completed set logged, rest timer starts.
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', device }), 2_000);
    expect(state.setLog).toHaveLength(1);
    expect(state.setLog[0]).toEqual({
      weightLbs: 100,
      mode: 'weight',
      repCount: 2,
      bestPeakVelocityMms: 900,
    });
    expect(state.restStartMs).toBe(2_000);
  });

  it('captures weight/mode from the tick the set was still open', () => {
    let state = initialAccumulatorState();
    const openDevice: SnapshotDevice = { weightLbs: 185, trainingMode: 'weight' };
    const set: SnapshotActiveSet = { reps: [rep(1, 500)] };

    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', device: openDevice, activeSet: set }),
      100,
    );
    // Set closes; device now reports a *different* weight — must not be recorded.
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', device: { weightLbs: 999, trainingMode: 'weight' } }),
      600,
    );
    expect(state.setLog[0].weightLbs).toBe(185);
  });

  it('clears rest timer when a new set starts', () => {
    let state = initialAccumulatorState();
    const set: SnapshotActiveSet = { reps: [rep(1, 700)] };
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', activeSet: set }), 0);
    state = reduceSnapshot(state, snapshot({ sessionId: 's1' }), 500); // closed → rest starts
    expect(state.restStartMs).toBe(500);
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', activeSet: set }), 1_000); // new set
    expect(state.restStartMs).toBeNull();
  });

  it('clears the log when the session changes', () => {
    let state = initialAccumulatorState();
    const set: SnapshotActiveSet = { reps: [rep(1, 700)] };
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', activeSet: set }), 0);
    state = reduceSnapshot(state, snapshot({ sessionId: 's1' }), 500);
    expect(state.setLog).toHaveLength(1);
    // New session id → log resets.
    state = reduceSnapshot(state, snapshot({ sessionId: 's2', activeSet: set }), 1_000);
    expect(state.setLog).toHaveLength(0);
  });
});

describe('buildSessionProgress + buildSetLogRows', () => {
  it('totals reps and volume over completed sets only', () => {
    const setLog = [
      { weightLbs: 100, mode: 'weight', repCount: 5, bestPeakVelocityMms: 900 },
      { weightLbs: 120, mode: 'weight', repCount: 4, bestPeakVelocityMms: 850 },
    ];
    const view = buildSessionProgress(snapshot({ sessionId: 's1', exerciseName: 'Row' }), setLog);
    expect(view).toMatchObject({
      active: true,
      exercise: 'Row',
      sets: 2,
      totalReps: 9,
      totalVolume: 100 * 5 + 120 * 4, // 980
    });
  });

  it('reports inactive with no session', () => {
    expect(buildSessionProgress(snapshot({ sessionId: null }), []).active).toBe(false);
  });

  it('formats set-log rows', () => {
    const rows = buildSetLogRows([
      { weightLbs: 135, mode: 'isokinetic', repCount: 3, bestPeakVelocityMms: 741 },
    ]);
    expect(rows[0]).toEqual({
      index: 1,
      weight: '135.0 lbs',
      mode: 'isokinetic',
      reps: 3,
      peakVelocity: '0.74 m/s',
    });
  });
});
