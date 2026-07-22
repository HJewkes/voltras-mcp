/**
 * Tests for the PROVISIONAL fatigue-card / diverging-hero mapper
 * (`spa/panels/fatigue-view.ts`).
 *
 * Builds REAL WA reps (with per-sample streams) via the model API so the mapper
 * exercises the same code path the live `/api/snapshot` reps take — the point of
 * the spike is to prove the per-sample stream reaches the client and shapes into
 * the contract.
 */
import { describe, expect, it } from 'vitest';
import {
  addSampleToSet,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';
import { initialAccumulatorState, type Snapshot } from '../spa/adapter.js';
import { type LiveViewSources } from '../spa/panels/live-view.js';
import {
  mapStoreToDivergingHeroModel,
  mapStoreToFatigueModel,
} from '../spa/panels/fatigue-view.js';

// --- Rep/set builders (real WA reps with samples) ----------------------------

interface RepSpec {
  concVel: number;
  rom: number;
  eccVel?: number;
  concMs?: number;
}

function repSamples(spec: RepSpec, seq: number, t0: number): WorkoutSample[] {
  const { concVel, rom, eccVel = concVel * 0.5, concMs = 500 } = spec;
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + concMs,
      phase: MovementPhase.CONCENTRIC,
      position: rom,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + concMs + 100,
      phase: MovementPhase.ECCENTRIC,
      position: rom,
      velocity: eccVel,
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + concMs + 1100,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: eccVel,
      force: 80,
    },
  ];
}

function buildReps(specs: RepSpec[]): Rep[] {
  let set = createSet();
  let seq = 0;
  let t = 1000;
  for (const spec of specs) {
    for (const sample of repSamples(spec, seq, t)) set = addSampleToSet(set, sample);
    seq += 4;
    t += (spec.concMs ?? 500) + 1500;
  }
  return [...set.reps];
}

function snapshotWithActive(reps: Rep[]): Snapshot {
  return {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [],
    sets: { active: { reps }, completed: [] },
  };
}

function sources(over: Partial<LiveViewSources> = {}): LiveViewSources {
  return {
    snapshot: null,
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
    ...over,
  };
}

// --- mapStoreToFatigueModel ---------------------------------------------------

describe('mapStoreToFatigueModel', () => {
  it('returns null when there is no active set', () => {
    expect(mapStoreToFatigueModel(sources())).toBeNull();
    const idle = snapshotWithActive([]);
    idle.sets.active = null;
    expect(mapStoreToFatigueModel(sources({ snapshot: idle }))).toBeNull();
  });

  it('surfaces the per-sample velocity curves the ghost-spark needs (samples DO cross the wire)', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 480, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model).not.toBeNull();
    expect(model!.velocityCurves).toHaveLength(2);
    const curve = model!.velocityCurves[0];
    // The first concentric sample: t=0, 500 mm/s → 0.5 m/s, concentric phase.
    expect(curve.samples[0]).toEqual({ tMs: 0, velocityMps: 0.5, phase: 'concentric' });
    // The curve carries both phases → at least one concentric and one eccentric segment.
    expect(curve.phaseSegments.map((s) => s.phase)).toEqual(['concentric', 'eccentric']);
  });

  it('builds the per-rep ROM progression in metres', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 90 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.romProgression).toEqual([
      { repNumber: 1, romM: 0.1 },
      { repNumber: 2, romM: 0.09 },
    ]);
  });

  it('derives the working-ROM standard (trimmed peak) and the 0.75 short threshold, in metres', () => {
    // rep 1 (setup) + last (in-progress) trimmed; the peak of the middle reps is the standard.
    const reps = buildReps([
      { concVel: 500, rom: 10 },
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 90 },
      { concVel: 500, rom: 5 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.romWorkingStandardM).toBeCloseTo(0.1, 5);
    expect(model!.romShortThresholdM).toBeCloseTo(0.075, 5);
  });

  it('leaves the working standard null until 3 reps establish a middle', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.romWorkingStandardM).toBeNull();
    expect(model!.romShortThresholdM).toBeNull();
  });

  it('exposes RPE + reps-in-reserve, and passes the target tempo through', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 400, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(
      sources({
        snapshot: snapshotWithActive(reps),
        prescription: { sets: 3, tempo: [3, 0, 1, 0] },
      }),
    );
    expect(model!.rpe).not.toBeNull();
    expect(model!.repsInReserve).toBeCloseTo(10 - model!.rpe!, 5);
    expect(model!.targetTempoSeconds).toEqual([3, 0, 1, 0]);
    // tempoSeconds is the current-rep tuple [ecc, pauseBottom, con, pauseTop].
    expect(model!.tempoSeconds).toHaveLength(4);
  });

  it('keeps the verdict null on the installed WA (provisional — populated post WA bump)', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 400, rom: 100 },
      { concVel: 300, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.verdict).toBeNull();
  });
});

// --- mapStoreToDivergingHeroModel --------------------------------------------

describe('mapStoreToDivergingHeroModel', () => {
  /** A minimal WA rep whose MEAN concentric velocity is `meanMms` mm/s. */
  function meanRep(meanMms: number, repNumber: number): Rep {
    return {
      repNumber,
      concentric: { peakVelocity: meanMms, _totalVelocity: meanMms, _movementSampleCount: 1 },
      eccentric: {},
    } as unknown as Rep;
  }

  function slot(slotId: string, reps: Rep[]): Snapshot['devices'][number] {
    return {
      slotId,
      device: { connected: true, weightLbs: 100 },
      sets: { active: { reps }, completed: [] },
    };
  }

  function dualSnapshot(left: Rep[], right: Rep[]): Snapshot {
    return {
      session: { sessionId: 's1' },
      devices: [slot('left', left), slot('right', right)],
      sets: { active: null, completed: [] },
    };
  }

  it('returns a null side for an unbound slot (honest awaiting limb)', () => {
    const snap: Snapshot = {
      session: null,
      devices: [slot('left', [meanRep(500, 1)])],
      sets: { active: null, completed: [] },
    };
    const hero = mapStoreToDivergingHeroModel(sources({ snapshot: snap }));
    expect(hero.left).not.toBeNull();
    expect(hero.right).toBeNull();
  });

  it('builds each limb from its OWN reps and shares one velocity scale', () => {
    const hero = mapStoreToDivergingHeroModel(
      sources({
        snapshot: dualSnapshot(
          [meanRep(600, 1), meanRep(500, 2)],
          [meanRep(550, 1), meanRep(540, 2)],
        ),
      }),
    );
    expect(hero.left!.repVelocitiesMps).toEqual([0.6, 0.5]);
    expect(hero.right!.repVelocitiesMps).toEqual([0.55, 0.54]);
    // Left drops 600→500 (deeper), right barely moves — each computed from its own reps.
    expect(hero.left!.velocityLossPct!).toBeGreaterThan(hero.right!.velocityLossPct!);
    // Shared scale = the fastest bar across both limbs.
    expect(hero.scaleMaxMps).toBeCloseTo(0.6, 5);
  });

  it('reports no scale when neither side has data', () => {
    const hero = mapStoreToDivergingHeroModel(sources({ snapshot: dualSnapshot([], []) }));
    expect(hero.scaleMaxMps).toBeNull();
  });
});
