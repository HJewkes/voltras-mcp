// Unit tests for the Phase 1 SPA snapshot→props adapter (VMCP-01.45).
//
// Focus: the client-side completed-set accumulator (reduceSnapshot) that mirrors
// the legacy dashboard-html.ts updateSetLog/updateRestState state machine, plus
// the unit-conversion formatters. Pure logic, node environment — no DOM.

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import {
  buildBattery,
  buildConnectionStatus,
  buildCurrentSet,
  buildHeroSets,
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

/**
 * Build a Rep carrying the concentric movement-sample aggregates WA needs for
 * mean-velocity (`_totalVelocity / _movementSampleCount`). One sample so mean
 * equals `meanMms`, letting velocity-loss come out deterministically.
 */
function repWithMean(repNumber: number, peakMms: number, meanMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms, _totalVelocity: meanMms, _movementSampleCount: 1 },
    eccentric: {},
  } as unknown as Rep;
}

/**
 * Build a Rep carrying a concentric peak force (lbs) and a larger ECCENTRIC peak,
 * so the fold proves it reads `concentric.peakForce` (VW-61) and never WA's
 * `getRepPeakForce` (which maxes concentric with eccentric).
 */
function repWithForce(repNumber: number, conForceLbs: number, eccForceLbs = 0): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: 700, peakForce: conForceLbs },
    eccentric: { peakForce: eccForceLbs },
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

  it('maps weight/mode/reps/latest-peak/target, bars use MEAN concentric', () => {
    // Reps with DISTINCT peak vs mean, so the bar series (mean) and the
    // latest-peak readout (peak) can be told apart (VW-58).
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        device: { connected: true, weightLbs: 135, trainingMode: 'isokinetic' },
        activeSet: {
          reps: [repWithMean(1, 900, 800), repWithMean(2, 800, 700), repWithMean(3, 750, 650)],
          latestInProgress: { targetWeightTenths: 1400 },
        },
      }),
    );
    expect(view.active).toBe(true);
    expect(view.weight).toBe('135.0 lbs');
    expect(view.mode).toBe('isokinetic');
    expect(view.reps).toBe(3);
    // latestPeakVelocity stays PEAK (latest rep peak 750 mm/s → 0.75 m/s).
    expect(view.latestPeakVelocity).toBe('0.75 m/s');
    expect(view.targetWeight).toBe('140.0 lbs'); // tenths/10
    // VelocityStrip bars are MEAN concentric (mm/s→m/s), NOT the peaks above.
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

  it('renders "N of M reps" from the watch rep_count_reached target', () => {
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        activeSet: {
          reps: [rep(1, 800), rep(2, 700), rep(3, 650)],
          watch: { notifyOn: [{ type: 'rep_count_reached', value: 8 }] },
        },
      }),
    );
    expect(view.repTarget).toBe(8);
    expect(view.repsLabel).toBe('3 of 8 reps');
  });

  it('renders a bare rep count with no configured target', () => {
    const view = buildCurrentSet(snapshot({ sessionId: 's1', activeSet: { reps: [rep(1, 800)] } }));
    expect(view.repTarget).toBeNull();
    expect(view.repsLabel).toBe('1 rep');
  });

  it('computes velocity-loss % via WA across the set', () => {
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        activeSet: { reps: [repWithMean(1, 800, 800), repWithMean(2, 600, 600)] },
      }),
    );
    // (800 - 600) / 800 × 100 = 25%.
    expect(view.velocityLoss).toBe('25%');
  });

  it('shows the em-dash for velocity-loss under two reps', () => {
    const view = buildCurrentSet(
      snapshot({ sessionId: 's1', activeSet: { reps: [repWithMean(1, 800, 800)] } }),
    );
    expect(view.velocityLoss).toBe('—');
  });

  it('bars and velocity-loss % are the SAME metric — bar drop matches loss (VW-58)', () => {
    // Peaks fall only slightly (900→850) while means fall hard (800→600). If the
    // bars used peak, the visible drop (~6%) would contradict the stated 25%
    // loss. On mean, the first→last bar drop equals the loss the verdict uses.
    const view = buildCurrentSet(
      snapshot({
        sessionId: 's1',
        activeSet: { reps: [repWithMean(1, 900, 800), repWithMean(2, 850, 600)] },
      }),
    );
    expect(view.velocitiesMps).toEqual([0.8, 0.6]);
    const [first, last] = view.velocitiesMps;
    const barDropPct = Math.round(((first - last) / first) * 100);
    expect(view.velocityLoss).toBe(`${barDropPct}%`);
    expect(view.velocityLoss).toBe('25%');
  });
});

describe('buildConnectionStatus — device-derived header state', () => {
  it('reports LIVE (success) when the device is connected and fresh', () => {
    const s = buildConnectionStatus(
      snapshot({ sessionId: 's1', device: { connected: true } }),
      'ok',
    );
    expect(s).toMatchObject({ tone: 'success', label: 'LIVE', showBanner: false });
  });

  it('reports OFFLINE (error) + banner when the device is disconnected', () => {
    const s = buildConnectionStatus(
      snapshot({
        sessionId: 's1',
        device: { connected: false, disconnectedAt: '2026-07-03T10:00:00.000Z' },
      }),
      'ok',
    );
    expect(s).toMatchObject({
      tone: 'error',
      label: 'OFFLINE',
      showBanner: true,
      disconnectedAt: '2026-07-03T10:00:00.000Z',
    });
  });

  it('reports STALE (warning) when the snapshot is cached pre-disconnect data', () => {
    const s = buildConnectionStatus(
      snapshot({
        sessionId: 's1',
        device: { connected: true, staleSinceDisconnect: '2026-07-03T10:00:00.000Z' },
      }),
      'ok',
    );
    expect(s).toMatchObject({ tone: 'warning', label: 'STALE', showBanner: false });
  });

  it('reports NO SIGNAL (error) + banner when the sidecar poll fails', () => {
    const s = buildConnectionStatus(
      snapshot({ sessionId: 's1', device: { connected: true } }),
      'error',
    );
    expect(s).toMatchObject({ tone: 'error', label: 'NO SIGNAL', showBanner: true });
  });
});

describe('buildBattery', () => {
  it('formats a present battery percent', () => {
    const b = buildBattery(snapshot({ sessionId: 's1', device: { batteryPercent: 82 } }));
    expect(b).toEqual({ present: true, pct: 82, label: '82%', low: false });
  });

  it('flips to low state below the threshold', () => {
    const b = buildBattery(snapshot({ sessionId: 's1', device: { batteryPercent: 15 } }));
    expect(b).toMatchObject({ present: true, label: '15%', low: true });
  });

  it('is absent when no battery reading is present', () => {
    const b = buildBattery(snapshot({ sessionId: 's1', device: { connected: true } }));
    expect(b).toEqual({ present: false, pct: null, label: '—', low: false });
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
      // No exercise name in this snapshot → null tag (VW-50).
      exerciseName: null,
      bestPeakVelocityMms: 900,
      // These reps carry no concentric force (the `rep` helper sets only peak
      // velocity), so the peak-force fold is null — hidden, never faked (VW-61).
      peakForceLbs: null,
      // Full WA reps retained (source of truth) so the shared mappers can derive
      // RPE / per-rep velocity for the hero.
      reps: [rep(1, 900), rep(2, 800)],
    });
    expect(state.restStartMs).toBe(2_000);
  });

  it('tags each closed set with the exercise active when it closed (VW-50)', () => {
    let state = initialAccumulatorState();
    const device: SnapshotDevice = { connected: true, weightLbs: 100, trainingMode: 'weight' };
    const set: SnapshotActiveSet = { reps: [rep(1, 900)] };

    // Exercise A: one set opens then closes.
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', exerciseName: 'Exercise A', device, activeSet: set }),
      0,
    );
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', exerciseName: 'Exercise A', device }),
      500,
    );
    // Exercise B (same session): a second set opens then closes.
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', exerciseName: 'Exercise B', device, activeSet: set }),
      1_000,
    );
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', exerciseName: 'Exercise B', device }),
      1_500,
    );

    // Both sets are in one session log, each tagged with the exercise that owned it —
    // so a consumer can count per-exercise without the log bleeding across exercises.
    expect(state.setLog.map((s) => s.exerciseName)).toEqual(['Exercise A', 'Exercise B']);
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

describe('reduceSnapshot — peak concentric force fold (VW-61)', () => {
  function closeSetWith(reps: Rep[]) {
    let state = initialAccumulatorState();
    const device: SnapshotDevice = { connected: true, weightLbs: 100, trainingMode: 'weight' };
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', device, activeSet: { reps } }), 0);
    return reduceSnapshot(state, snapshot({ sessionId: 's1', device }), 500);
  }

  it('folds the MAX per-rep concentric force across the set', () => {
    const state = closeSetWith([repWithForce(1, 420), repWithForce(2, 511), repWithForce(3, 388)]);
    expect(state.setLog[0].peakForceLbs).toBe(511);
  });

  it('reads concentric force only — a bigger eccentric peak never counts', () => {
    // Eccentric peak (900) dwarfs every concentric peak; the fold must ignore it.
    const state = closeSetWith([repWithForce(1, 420, 900), repWithForce(2, 450, 880)]);
    expect(state.setLog[0].peakForceLbs).toBe(450);
  });

  it('is null when no rep logged concentric force (never faked)', () => {
    const state = closeSetWith([rep(1, 900), rep(2, 800)]);
    expect(state.setLog[0].peakForceLbs).toBeNull();
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

describe('buildHeroSets — canonical WorkoutSetView timeline', () => {
  it('emits completed sets carrying their retained reps, then the active set', () => {
    const device: SnapshotDevice = { weightLbs: 100, trainingMode: 'weight' };
    let state = initialAccumulatorState();
    // One set opens then closes → logged.
    state = reduceSnapshot(
      state,
      snapshot({ sessionId: 's1', device, activeSet: { reps: [rep(1, 900), rep(2, 800)] } }),
      0,
    );
    state = reduceSnapshot(state, snapshot({ sessionId: 's1', device }), 500);

    // A new active set is now open with a rep target.
    const rows = buildHeroSets(
      snapshot({
        sessionId: 's1',
        device,
        activeSet: {
          reps: [rep(1, 850)],
          watch: { notifyOn: [{ type: 'rep_count_reached', value: 8 }] },
        },
      }),
      state.setLog,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ setNumber: 1, kind: 'completed', weightLbs: 100 });
    expect(rows[0].reps).toEqual([rep(1, 900), rep(2, 800)]); // full reps carried
    expect(rows[1]).toMatchObject({ setNumber: 2, kind: 'active', targetReps: 8 });
    // PREV column source: the active row points back at the completed set.
    expect(rows[1].previous).toEqual({ reps: 2, weightLbs: 100 });
  });
});
