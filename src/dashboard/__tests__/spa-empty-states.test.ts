// Unit tests for the live page's null / idle states (VW-68).
//
// Focus: the pure predicate + projections behind the designed empty stage — when the stage
// has nothing honest to show (`stageIsEmpty`), when the rail suppresses its stub row, and the
// coarse connection hint the idle copy branches on. Component copy is the titan story's visual
// check; here we test the logic that drives it. Pure projection — no DOM, no I/O.

import { describe, expect, it } from 'vitest';

import { initialAccumulatorState, type Snapshot } from '../spa/adapter.js';
import {
  deriveRailExercises,
  stageIsEmpty,
  type CompletedSet,
  type DashboardModel,
  type LiveModel,
  type SessionModel,
} from '../spa/live-page/model.js';
import { mapStoreToDashboardModel, type LiveViewSources } from '../spa/panels/live-view.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    exerciseName: 'Cable Chest Press',
    title: null,
    weightLbs: 140,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: null,
    targetReps: null,
    ...over,
  };
}

function model(over: Partial<DashboardModel> = {}): DashboardModel {
  return { live: null, session: sessionModel(), restElapsedMs: null, ...over };
}

function completed(exerciseName: string, repCount = 8): CompletedSet {
  return { exerciseName, weightLbs: 140, mode: 'weight', repCount, reps: [], peakForceLbs: null };
}

/** A minimal live overlay for the "mid-set" branch. */
const liveOverlay: LiveModel = {
  velocity: 0.4,
  force: 480,
  phase: 'concentric',
  phaseElapsedMs: 400,
  lastRep: null,
  repVelocities: [0.5],
  velocityLossPct: null,
  peakForce: null,
};

describe('stageIsEmpty (VW-68)', () => {
  it('is true with no set streaming, none logged, and no rest clock', () => {
    expect(stageIsEmpty(model())).toBe(true);
  });

  it('is false while a set is streaming', () => {
    expect(stageIsEmpty(model({ live: liveOverlay }))).toBe(false);
  });

  it('is false once a set has been logged (the rest recap has content)', () => {
    expect(
      stageIsEmpty(
        model({ session: sessionModel({ completedSets: [completed('Cable Chest Press')] }) }),
      ),
    ).toBe(false);
  });

  it('is false while a rest clock is running', () => {
    expect(stageIsEmpty(model({ restElapsedMs: 5000 }))).toBe(false);
  });
});

describe('deriveRailExercises empty-rail tidy (VW-68)', () => {
  it('emits no rows when there is NO session (— fallback, no plan/log/stream)', () => {
    // The mapper's no-session fallback name — the operator's barren connected-idle case.
    expect(deriveRailExercises(model({ session: sessionModel({ exerciseName: '—' }) }))).toEqual(
      [],
    );
  });

  it('still emits the active row for a real session before its first set (named, no plan)', () => {
    const rows = deriveRailExercises(model({ session: sessionModel({ exerciseName: 'Bench' }) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Bench');
  });

  it('emits the active row once a set is streaming', () => {
    const rows = deriveRailExercises(model({ live: liveOverlay }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Cable Chest Press');
  });

  it('emits the active row once a set has been logged', () => {
    const rows = deriveRailExercises(
      model({ session: sessionModel({ completedSets: [completed('Cable Chest Press')] }) }),
    );
    expect(rows).toHaveLength(1);
  });
});

// --- Connection hint (VW-68), reusing buildConnectionStatus via the mapper -----------------

function snapshotWith(devices: Snapshot['devices']): Snapshot {
  return { session: null, devices, sets: { active: null } };
}

function sources(over: Partial<LiveViewSources> = {}): LiveViewSources {
  return {
    snapshot: snapshotWith([]),
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
    ...over,
  };
}

describe('mapStoreToDashboardModel connection hint (VW-68)', () => {
  it('reports not-connected (WAITING) when no device is present', () => {
    const m = mapStoreToDashboardModel(sources());
    expect(m?.connection?.connected).toBe(false);
    expect(m?.connection?.label).toBe('WAITING');
  });

  it('reports connected (LIVE) when a device is connected and the poll is ok', () => {
    const m = mapStoreToDashboardModel(
      sources({ snapshot: snapshotWith([{ slotId: 'primary', device: { connected: true } }]) }),
    );
    expect(m?.connection?.connected).toBe(true);
    expect(m?.connection?.label).toBe('LIVE');
  });

  it('reports OFFLINE when the device flag says disconnected', () => {
    const m = mapStoreToDashboardModel(
      sources({ snapshot: snapshotWith([{ slotId: 'primary', device: { connected: false } }]) }),
    );
    expect(m?.connection?.connected).toBe(false);
    expect(m?.connection?.label).toBe('OFFLINE');
  });

  it('reports NO SIGNAL when the sidecar poll has errored', () => {
    const m = mapStoreToDashboardModel(
      sources({
        snapshot: snapshotWith([{ slotId: 'primary', device: { connected: true } }]),
        pollStatus: 'error',
      }),
    );
    expect(m?.connection?.connected).toBe(false);
    expect(m?.connection?.label).toBe('NO SIGNAL');
  });
});
