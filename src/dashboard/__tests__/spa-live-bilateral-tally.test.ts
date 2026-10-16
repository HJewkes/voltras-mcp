// VW-956: the Live page's working-set tally on a dual (bilateral) rig.
//
// A dual rig runs one session per slot, and the snapshot's top-level
// `sets.completed` carries only the first slot's sets. Without the pairing on
// the wire, the left side's lighter set of a 90/100 pair ranked against the
// left side's own later 100 lb set and was dropped as a warm-up. The pair is one
// effort with two sides (VW-951), so it counts once and its lighter side stays.

import { describe, expect, it } from 'vitest';
import { addSampleToSet, createSet, MovementPhase, type Rep } from '@voltras/workout-analytics';

import {
  initialAccumulatorState,
  reduceSnapshot,
  type Snapshot,
  type SnapshotCompletedSet,
} from '../spa/adapter.js';
import { deriveRailExercises, workingCompletedSets } from '../spa/live-page/model.js';
import { mapStoreToDashboardModel } from '../spa/panels/live-view.js';

function buildReps(repCount: number): Rep[] {
  let set = createSet();
  let t = 1000;
  for (let i = 0; i < repCount; i += 1) {
    set = addSampleToSet(set, {
      sequence: i * 2,
      timestamp: t,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: 0.8,
      force: 100,
    });
    set = addSampleToSet(set, {
      sequence: i * 2 + 1,
      timestamp: t + 600,
      phase: MovementPhase.ECCENTRIC,
      position: 0.5,
      velocity: 0.4,
      force: 80,
    });
    t += 2000;
  }
  return [...set.reps];
}

function closedSet(
  setId: string,
  weightLbs: number,
  side: 'left' | 'right',
  bilateralGroupId?: string,
): SnapshotCompletedSet {
  return {
    set: { setId, reps: buildReps(5) },
    device: { connected: true, weightLbs },
    side,
    ...(bilateralGroupId !== undefined ? { bilateralGroupId } : {}),
  };
}

/** Pair 1 at 90 left / 100 right, pair 2 at 100 a side, as the snapshot ships it. */
function dualSnapshot(): Snapshot {
  const left = [closedSet('L1', 90, 'left', 'pair-1'), closedSet('L2', 100, 'left', 'pair-2')];
  const right = [closedSet('R1', 100, 'right', 'pair-1'), closedSet('R2', 100, 'right', 'pair-2')];
  return {
    session: { sessionId: 'sess-left', exerciseName: 'Cable Chest Press' },
    devices: [
      { slotId: 'left', device: { connected: true }, sets: { active: null, completed: left } },
      { slotId: 'right', device: { connected: true }, sets: { active: null, completed: right } },
    ],
    sets: { active: null, completed: left },
  };
}

function modelOf(snapshot: Snapshot) {
  const accumulator = reduceSnapshot(initialAccumulatorState(), snapshot, 0);
  const model = mapStoreToDashboardModel({ snapshot, accumulator, live: null, prescription: null });
  if (model === null) throw new Error('no model');
  return model;
}

describe('Live tally on a bilateral pair (VW-956)', () => {
  it('counts a 90/100 pair as one working set with its partner side ranked alongside', () => {
    const model = modelOf(dualSnapshot());

    const working = workingCompletedSets(model.session);
    const [row] = deriveRailExercises(model);

    expect(working.map((set) => set.weightLbs)).toEqual([90, 100]);
    expect(row.summary.sets).toBe(2);
    expect(model.session.partnerSides?.map((set) => [set.side, set.weightLbs])).toEqual([
      ['right', 100],
      ['right', 100],
    ]);
  });

  it('still drops a lighter set that belongs to no pair', () => {
    const snapshot = dualSnapshot();
    const lone = closedSet('L0', 50, 'left');
    snapshot.sets.completed = [lone, ...(snapshot.sets.completed ?? [])];

    const working = workingCompletedSets(modelOf(snapshot).session);

    expect(working.map((set) => set.weightLbs)).toEqual([90, 100]);
  });
});
