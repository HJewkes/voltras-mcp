/**
 * Snapshot read-model — the pure derivation behind `GET /api/snapshot`. Verifies
 * that gathered device/session/set state plus the active exercise's catalog entry
 * shape into the exact wire payload (missing session/set → explicit null, muscle
 * groups joined), with no HTTP in the loop. This is the behavior-preservation
 * proof for the extraction out of `server.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSnapshotView,
  resolveActiveExerciseMuscles,
  type DeviceEntry,
  type ExerciseMeta,
} from '../read-models/snapshot';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../../state/live-state';

const device = (over: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({
  connected: true,
  deviceId: 'V-097082',
  ...over,
});

const session = (over: Partial<ActiveSession> = {}): ActiveSession => ({
  sessionId: 'sess-A',
  startedAt: '2026-05-09T12:00:00.000Z',
  setIds: [],
  status: 'active',
  ...over,
});

const activeSet = (over: Partial<ActiveSet> = {}): ActiveSet => ({
  setId: 'set-A',
  sessionId: 'sess-A',
  startedAt: '2026-05-09T12:00:05.000Z',
  reps: [],
  status: 'active',
  ...over,
});

describe('resolveActiveExerciseMuscles', () => {
  it('maps a catalog entry to primary + secondary muscle arrays', () => {
    const meta: ExerciseMeta = {
      muscleGroups: ['chest'],
      secondaryMuscleGroups: ['shoulders', 'triceps'],
    };
    expect(resolveActiveExerciseMuscles(meta)).toEqual({
      primaryMuscles: ['chest'],
      secondaryMuscles: ['shoulders', 'triceps'],
    });
  });

  it('defaults a missing secondary list to an empty array', () => {
    expect(resolveActiveExerciseMuscles({ muscleGroups: ['back'] })).toEqual({
      primaryMuscles: ['back'],
      secondaryMuscles: [],
    });
  });

  it('returns null when no exercise was resolved', () => {
    expect(resolveActiveExerciseMuscles(undefined)).toBeNull();
  });
});

describe('buildSnapshotView', () => {
  it('shapes gathered state into the full { session, devices, sets, activeExercise } payload', () => {
    const devices: DeviceEntry[] = [
      { slotId: 'primary', device: device({ weightLbs: 50, damperLevel: 4 }) },
    ];
    const view = buildSnapshotView({
      devices,
      session: session({ sessionId: 'sess-A' }),
      activeSet: activeSet({ setId: 'set-A' }),
      activeExercise: { muscleGroups: ['chest'], secondaryMuscleGroups: ['triceps'] },
    });
    expect(view.session?.sessionId).toBe('sess-A');
    expect(view.devices).toHaveLength(1);
    expect(view.devices[0]?.slotId).toBe('primary');
    expect(view.sets.active?.setId).toBe('set-A');
    expect(view.activeExercise).toEqual({
      primaryMuscles: ['chest'],
      secondaryMuscles: ['triceps'],
    });
  });

  it('collapses a missing session and set to explicit null (the wire contract)', () => {
    const view = buildSnapshotView({
      devices: [{ slotId: 'primary', device: device({ connected: false }) }],
      session: undefined,
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.session).toBeNull();
    expect(view.sets.active).toBeNull();
    expect(view.activeExercise).toBeNull();
    expect(view.devices).toHaveLength(1);
  });

  // VW-70: completed sets are a durable wire field so a consumer that didn't
  // watch the live active→null transition can still render the rail/recap.
  it('defaults sets.completed to [] when no completed sets are supplied', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session(),
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.sets.completed).toEqual([]);
  });

  it('surfaces the session completed sets on the wire (VW-70)', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session({ sessionId: 'sess-A' }),
      activeSet: undefined,
      completedSets: [
        { set: activeSet({ setId: 'set-1', status: 'ended' }), device: device({ weightLbs: 20 }) },
        { set: activeSet({ setId: 'set-2', status: 'ended' }), device: device({ weightLbs: 25 }) },
      ],
      activeExercise: undefined,
    });
    expect(view.sets.completed.map((c) => c.set.setId)).toEqual(['set-1', 'set-2']);
    expect(view.sets.completed[1]?.device?.weightLbs).toBe(25);
  });

  // Regression (VW-38): `session.start` drops `exerciseName` whenever an
  // `exerciseId` is given (R21), so an id-started session reached the dashboard
  // nameless and every consumer rendered a `—` placeholder.
  it('surfaces the catalog name for a session started by exerciseId', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session({ exerciseId: 'cable-chest-press' }),
      activeSet: undefined,
      activeExercise: { name: 'Cable Chest Press', muscleGroups: ['chest'] },
    });
    expect(view.session?.exerciseName).toBe('Cable Chest Press');
    expect(view.session?.exerciseId).toBe('cable-chest-press');
  });

  it('leaves exerciseName absent when the id resolves to no catalog entry', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session({ exerciseId: 'not-in-catalog' }),
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.session?.exerciseName).toBeUndefined();
    expect(view.session?.exerciseId).toBe('not-in-catalog');
  });

  it('keeps a name the session already carries instead of the catalog name', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session({ exerciseId: 'cable-chest-press', exerciseName: 'Guided Load (auto)' }),
      activeSet: undefined,
      activeExercise: { name: 'Cable Chest Press', muscleGroups: ['chest'] },
    });
    expect(view.session?.exerciseName).toBe('Guided Load (auto)');
  });

  it('reports activeExercise=null when no exercise metadata was resolved', () => {
    const view = buildSnapshotView({
      devices: [],
      session: session({ exerciseId: 'cable-chest-press' }),
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.activeExercise).toBeNull();
  });

  it('carries every gathered slot through into devices[] in order', () => {
    const view = buildSnapshotView({
      devices: [
        { slotId: 'primary', device: device({ deviceId: 'V-097082' }) },
        { slotId: 'secondary', device: device({ connected: false, deviceId: 'V-212006' }) },
      ],
      session: undefined,
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.devices.map((d) => d.slotId)).toEqual(['primary', 'secondary']);
  });

  it('preserves the device snapshot objects untouched (no reshaping)', () => {
    const d = device({ weightLbs: 42, damperLevel: 4 });
    const view = buildSnapshotView({
      devices: [{ slotId: 'primary', device: d }],
      session: undefined,
      activeSet: undefined,
      activeExercise: undefined,
    });
    expect(view.devices[0]?.device).toBe(d);
  });
});
