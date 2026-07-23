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

/**
 * Build reps with an EXPLICIT per-sample concentric velocity profile (for the
 * grind-signature / tempo-deviation signals). Each spec's `concVels` become evenly
 * spaced concentric samples spanning `concMs`, followed by a short eccentric.
 */
function buildDetailedReps(
  specs: Array<{ concVels: number[]; rom: number; concMs: number; eccVel?: number }>,
): Rep[] {
  let set = createSet();
  let seq = 0;
  let t = 1000;
  for (const spec of specs) {
    const n = spec.concVels.length;
    const dt = n > 1 ? spec.concMs / (n - 1) : spec.concMs;
    spec.concVels.forEach((v, i) => {
      set = addSampleToSet(set, {
        sequence: seq++,
        timestamp: t + Math.round(i * dt),
        phase: MovementPhase.CONCENTRIC,
        position: n > 1 ? Math.round((spec.rom * i) / (n - 1)) : spec.rom,
        velocity: v,
        force: 100,
      });
    });
    const eccVel = spec.eccVel ?? 100;
    const tEcc = t + spec.concMs + 100;
    set = addSampleToSet(set, {
      sequence: seq++,
      timestamp: tEcc,
      phase: MovementPhase.ECCENTRIC,
      position: spec.rom,
      velocity: eccVel,
      force: 80,
    });
    set = addSampleToSet(set, {
      sequence: seq++,
      timestamp: tEcc + 1000,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: eccVel,
      force: 80,
    });
    t = tEcc + 1400;
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

  it('flows a REAL multi-dimension verdict end to end (velocity-ok + cut ROM → form breaking down)', () => {
    // Constant velocity (loss 0 → velocity ok) but the last rep is cut to 60% of the
    // working standard — the cheat rep the strict-precedence verdict must catch.
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 60 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.verdict).not.toBeNull();
    expect(model!.verdict).toEqual({
      state: 'form-breakdown',
      tone: 'alarm',
      dimensions: { velocityLoss: 'ok', rom: 'alarm', tempo: 'ok' },
    });
  });

  it('still yields a null verdict for a cold-start set (< 2 reps)', () => {
    const reps = buildReps([{ concVel: 500, rom: 100 }]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model).not.toBeNull();
    expect(model!.verdict).toBeNull();
  });

  it('populates per-rep tempoDeviation + grindSignature (real 0..1 numbers with a prescription)', () => {
    // concMs 500 → concentric 0.5 s; prescribed concentric 1 s → deviation |0.5−1|/1 = 0.5.
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 480, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(
      sources({
        snapshot: snapshotWithActive(reps),
        prescription: { sets: 3, tempo: [3, 0, 1, 0] },
      }),
    );
    const curve = model!.velocityCurves[0];
    expect(curve.tempoDeviation).toBeCloseTo(0.5, 3);
    expect(curve.grindSignature).toBeGreaterThanOrEqual(0);
    expect(curve.grindSignature).toBeLessThanOrEqual(1);
  });

  it('leaves tempoDeviation null when the plan prescribes no tempo (nothing to deviate from)', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 480, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.velocityCurves[0].tempoDeviation).toBeNull();
    // grindSignature is always computed (no prescription needed).
    expect(typeof model!.velocityCurves[0].grindSignature).toBe('number');
  });

  it('a smooth-but-slow rep reads HIGH tempoDeviation but LOW grindSignature', () => {
    // 2.5 s concentric vs prescribed 1 s → deviation clamps to 1.0; velocity holds near
    // its own peak through the middle → grind ~0.
    const smooth = { concVels: [120, 150, 160, 158, 150, 140], rom: 100, concMs: 2500 };
    const reps = buildDetailedReps([smooth, smooth]);
    const model = mapStoreToFatigueModel(
      sources({
        snapshot: snapshotWithActive(reps),
        prescription: { sets: 3, tempo: [3, 0, 1, 0] },
      }),
    );
    const curve = model!.velocityCurves[1];
    expect(curve.tempoDeviation).toBeCloseTo(1.0, 3);
    expect(curve.grindSignature).toBeLessThan(0.2);
  });

  it('a collapsing rep reads HIGH grindSignature (mid-concentric velocity trough)', () => {
    const smooth = { concVels: [120, 150, 160, 158, 150, 140], rom: 100, concMs: 800 };
    const collapse = { concVels: [200, 600, 620, 150, 140, 560], rom: 100, concMs: 800 };
    const reps = buildDetailedReps([smooth, collapse]);
    const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
    expect(model!.velocityCurves[1].grindSignature).toBeGreaterThan(0.5);
    // The smooth rep in the same set stays low — the signal is shape, not absolute speed.
    expect(model!.velocityCurves[0].grindSignature).toBeLessThan(0.2);
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
