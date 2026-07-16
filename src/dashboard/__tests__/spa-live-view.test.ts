// Unit tests for the store→live-page read-model mapper (VW-42/44/51).
//
// Focus: fields that reach the ported north-star live page from a REAL source, and
// the contract that a field with no source stays null so the view hides it rather
// than rendering a fabricated number. Pure projection — no DOM, no I/O.

import { describe, expect, it } from 'vitest';

import { initialAccumulatorState, type PrescriptionView, type Snapshot } from '../spa/adapter.js';
import { type LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import { deriveRailExercises } from '../spa/live-page/model.js';
import { mapStoreToDashboardModel, type LiveViewSources } from '../spa/panels/live-view.js';

/** A snapshot with an active session and no device/set activity. */
function snapshot(): Snapshot {
  return {
    session: { sessionId: 's1', exerciseName: 'Cable Chest Press' },
    devices: [],
    sets: { active: null },
  };
}

/** A live overlay carrying one finalized rep. */
function liveWithRep(rom: number, peakForce = 0): StoreLiveModel {
  return {
    connected: true,
    phase: 'con',
    phaseElapsedMs: 400,
    velocity: 0.42,
    position: 120,
    force: 480,
    repInProgress: 2,
    lastRep: { repIndex: 1, vCon: 0.41, rom, peakVelocity: 0.6, peakForceSoFar: peakForce },
    peakForce,
  };
}

function sources(over: Partial<LiveViewSources> = {}): LiveViewSources {
  return {
    snapshot: snapshot(),
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
    ...over,
  };
}

describe('mapStoreToDashboardModel', () => {
  describe('lastRep.rom (VW-44)', () => {
    it('surfaces the finalized rep range of motion in metres', () => {
      const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58) }));
      expect(model?.live?.lastRep?.rom).toBe(0.58);
    });

    it('reports no last rep before the first rep of a set lands', () => {
      const live: StoreLiveModel = { ...liveWithRep(0.58), lastRep: null };
      const model = mapStoreToDashboardModel(sources({ live }));
      expect(model?.live?.lastRep).toBeNull();
    });
  });

  describe('live.peakForce (VW-45)', () => {
    it('carries the set-level peak concentric force onto the live model', () => {
      const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58, 542) }));
      expect(model?.live?.peakForce).toBe(542);
    });

    it('has no live model at all when nothing is streaming', () => {
      const model = mapStoreToDashboardModel(sources({ live: null }));
      expect(model?.live).toBeNull();
    });
  });

  describe('session.plannedSets (VW-42)', () => {
    it('surfaces the prescribed set count when the session has a plan', () => {
      const prescription: PrescriptionView = { sets: 4 };
      const model = mapStoreToDashboardModel(sources({ prescription }));
      expect(model?.session.plannedSets).toBe(4);
    });

    it('leaves the set count null when the session carries no plan', () => {
      const model = mapStoreToDashboardModel(sources());
      expect(model?.session.plannedSets).toBeNull();
    });
  });
});

describe('deriveRailExercises', () => {
  it('pads the set strip with todo sets up to the prescribed count', () => {
    const model = mapStoreToDashboardModel(
      sources({ live: liveWithRep(0.58), prescription: { sets: 3 } }),
    );
    // No rep target is configured, so a `todo` set cannot state its expected reps and
    // the strip honestly stops at the active set rather than guessing.
    const [exercise] = deriveRailExercises(model!);
    expect(exercise.summary.sets).toBe(3);
    expect(exercise.setStates.filter((s) => s.status === 'todo')).toHaveLength(0);
  });

  it('falls back to the sets accounted for when no plan is attached', () => {
    const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58) }));
    const [exercise] = deriveRailExercises(model!);
    expect(exercise.summary.sets).toBe(1);
  });
});
