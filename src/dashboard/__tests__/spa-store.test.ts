/**
 * Dashboard client store (VMCP-03.02). Covers the store actions that replaced the
 * 13-`useState` `useDashboardModel` hook — snapshot application (with the
 * `reduceSnapshot` fold moved into `applySnapshot`), the staleness tick, the
 * historical batch merge, and live-slice isolation. Pure/headless: drives the
 * vanilla store directly, no React.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DISPLAY_UNIT_KEY, dashboardStore, STALE_THRESHOLD_MS } from '../spa/store';
import {
  initialAccumulatorState,
  type Snapshot,
  type SnapshotActiveSet,
  type SnapshotDevice,
} from '../spa/adapter';
import type { LiveModel } from '../spa/live-stream';
import type { LiveIsometricSignal } from '../../state/live-signal';
import type { Rep } from '@voltras/workout-analytics';

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
  peakForce: 0,
});

/** Reset every data field between tests (the store is a module singleton). */
beforeEach(() => {
  dashboardStore.setState({
    snapshot: null,
    accumulator: initialAccumulatorState(),
    status: 'ok',
    nowMs: 0,
    lastSuccessMs: 0,
    prescription: null,
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
  it('applyHistorical merges the prescription patch', () => {
    dashboardStore.getState().applyHistorical({ prescription: { sets: 3 } });
    expect(dashboardStore.getState().prescription).toEqual({ sets: 3 });
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

/** A minimal `window.localStorage` stand-in for the node test environment (no real DOM). */
function fakeWindow(seed: Record<string, string> = {}) {
  const backing = { ...seed };
  return {
    localStorage: {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
    },
    backing,
  };
}

describe('dashboardStore — displayUnit slice (VW-63)', () => {
  afterEach(() => {
    // Leave the module-singleton store the way every other describe block expects it.
    dashboardStore.getState().setDisplayUnit('lbs');
    delete (globalThis as { window?: unknown }).window;
  });

  it('defaults to lbs with no persisted preference', () => {
    expect(dashboardStore.getState().displayUnit).toBe('lbs');
  });

  it('setDisplayUnit updates the slice without touching other slices', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    const before = dashboardStore.getState();
    dashboardStore.getState().setDisplayUnit('kg');
    const after = dashboardStore.getState();
    expect(after.displayUnit).toBe('kg');
    expect(after.snapshot).toBe(before.snapshot);
  });

  it('setDisplayUnit persists the choice to localStorage', () => {
    const win = fakeWindow();
    (globalThis as { window?: unknown }).window = win;
    dashboardStore.getState().setDisplayUnit('kg');
    expect(win.backing[DISPLAY_UNIT_KEY]).toBe('kg');
  });

  it('restores a persisted kg preference when the module (re)initializes', async () => {
    (globalThis as { window?: unknown }).window = fakeWindow({ [DISPLAY_UNIT_KEY]: 'kg' });
    vi.resetModules();
    const fresh = await import('../spa/store');
    expect(fresh.dashboardStore.getState().displayUnit).toBe('kg');
  });

  it('falls back to lbs when the persisted value is neither lbs nor kg', async () => {
    (globalThis as { window?: unknown }).window = fakeWindow({ [DISPLAY_UNIT_KEY]: 'stones' });
    vi.resetModules();
    const fresh = await import('../spa/store');
    expect(fresh.dashboardStore.getState().displayUnit).toBe('lbs');
  });
});

describe('dashboardStore — live slice isolation', () => {
  it('setLive updates only the live slice; shell-read references stay stable', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    dashboardStore.getState().applyHistorical({ prescription: { sets: 3 } });
    const before = dashboardStore.getState();

    dashboardStore.getState().setLive(liveModel(0.5));
    const after = dashboardStore.getState();

    expect(after.live?.velocity).toBe(0.5);
    // A ~20 Hz live write must not churn the objects the shell selectors read,
    // or the whole dashboard would re-render at 20 Hz.
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.accumulator).toBe(before.accumulator);
    expect(after.prescription).toBe(before.prescription);
  });
});

describe('dashboardStore — isometric slice (VW-198)', () => {
  afterEach(() => {
    dashboardStore.setState({ isometricBySlot: {}, isometric: null });
  });

  function signal(over: Partial<LiveIsometricSignal> = {}): LiveIsometricSignal {
    return { slot: 'primary', phase: 'ready', trial: 1, holdMs: 5000, side: null, ...over };
  }

  it('setIsometric stores a non-stop signal and derives the single-slot view', () => {
    dashboardStore.getState().setIsometric(signal({ phase: 'go' }));
    expect(dashboardStore.getState().isometric).toEqual(signal({ phase: 'go' }));
  });

  it('a `stop` phase clears the slot instead of storing it', () => {
    dashboardStore.getState().setIsometric(signal({ phase: 'hold' }));
    expect(dashboardStore.getState().isometric).not.toBeNull();
    dashboardStore.getState().setIsometric(signal({ phase: 'stop' }));
    expect(dashboardStore.getState().isometric).toBeNull();
    expect(dashboardStore.getState().isometricBySlot).toEqual({});
  });

  it('passing null clears the slot directly', () => {
    dashboardStore.getState().setIsometric(signal());
    dashboardStore.getState().setIsometric(null);
    expect(dashboardStore.getState().isometric).toBeNull();
  });

  it('keeps two slots independent, falling back to the first when primary is absent', () => {
    dashboardStore.getState().setIsometric(signal({ slot: 'left', phase: 'go' }), 'left');
    dashboardStore.getState().setIsometric(signal({ slot: 'right', phase: 'hold' }), 'right');
    expect(dashboardStore.getState().isometric).toEqual(signal({ slot: 'left', phase: 'go' }));

    dashboardStore.getState().setIsometric(signal({ slot: 'left', phase: 'stop' }), 'left');
    expect(dashboardStore.getState().isometric).toEqual(signal({ slot: 'right', phase: 'hold' }));
  });

  it('setIsometric does not touch other slices', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    const before = dashboardStore.getState();
    dashboardStore.getState().setIsometric(signal());
    const after = dashboardStore.getState();
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.accumulator).toBe(before.accumulator);
  });
});

describe('dashboardStore — ui slice (route, VMCP-03.02 part 1)', () => {
  afterEach(() => {
    dashboardStore.getState().setRoute({ name: 'live' });
  });

  it('defaults to the live route with no window (SSR/test env)', () => {
    expect(dashboardStore.getState().route).toEqual({ name: 'live' });
  });

  it('setRoute updates the slice, and two independent readers see the same value', () => {
    dashboardStore.getState().setRoute({ name: 'plan' });
    // Stands in for `main.tsx`'s two consumers (the shell chrome and the routed
    // page) each pulling their own snapshot of the store — both must land on the
    // same route the `hashchange` listener just wrote, not a copy each latched
    // independently.
    const shellRead = dashboardStore.getState().route;
    const pageRead = dashboardStore.getState().route;
    expect(shellRead).toEqual({ name: 'plan' });
    expect(pageRead).toBe(shellRead);
  });

  it('setRoute does not touch other slices', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    const before = dashboardStore.getState();
    dashboardStore.getState().setRoute({ name: 'summary', sessionId: 'latest' });
    const after = dashboardStore.getState();
    expect(after.snapshot).toBe(before.snapshot);
  });
});

describe('dashboardStore — planner slice (plannerBusy, VMCP-03.02 part 2)', () => {
  afterEach(() => {
    dashboardStore.getState().setPlannerBusy(false);
  });

  it('defaults to not busy', () => {
    expect(dashboardStore.getState().plannerBusy).toBe(false);
  });

  it('setPlannerBusy updates the slice, and two independent readers see the same value', () => {
    dashboardStore.getState().setPlannerBusy(true);
    // Stands in for `PlannedExerciseRow` and `ProgramBar` — plain siblings under
    // `PlanBuilderPage` that used to get `busy` drilled down as a prop (through
    // `WorkoutEditor`, which had no other use for it) and now each pull their own
    // snapshot straight off the store.
    const rowRead = dashboardStore.getState().plannerBusy;
    const programBarRead = dashboardStore.getState().plannerBusy;
    expect(rowRead).toBe(true);
    expect(programBarRead).toBe(rowRead);
  });

  it('setPlannerBusy does not touch other slices', () => {
    dashboardStore.getState().applySnapshot(snapshot({ sessionId: 's1' }), 1000);
    const before = dashboardStore.getState();
    dashboardStore.getState().setPlannerBusy(true);
    const after = dashboardStore.getState();
    expect(after.snapshot).toBe(before.snapshot);
  });
});
