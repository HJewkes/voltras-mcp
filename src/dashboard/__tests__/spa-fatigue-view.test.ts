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

  it('carries plannedReps from the prescription, and leaves it undefined without a plan', () => {
    const reps = buildReps([{ concVel: 500, rom: 100 }]);
    const snapshot = snapshotWithActive(reps);

    // The ROM chart draws `plannedReps − done` dashed to-do slots. It is an OPTIONAL prop
    // on titan's model, so a mapper that never sets it type-checks clean and silently
    // renders every set as complete — hence an explicit test on both branches.
    const planned = mapStoreToFatigueModel(
      sources({ snapshot, prescription: { sets: 3, repsLow: 8, repsHigh: 12 } }),
    );
    expect(planned!.plannedReps).toBe(8);

    // No plan attached ⇒ no target exists. The gap must read as a gap: never 0, and never
    // backfilled from the reps logged so far.
    const unplanned = mapStoreToFatigueModel(sources({ snapshot }));
    expect(unplanned!.plannedReps).toBeUndefined();
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

// --- regression: reps that carry no per-sample stream -------------------------

describe('mapStoreToFatigueModel — reps without a per-sample stream', () => {
  /**
   * REGRESSION (VMCP-04.05). WA types `samples` as a required array, but this data
   * arrives as JSON over `/api/snapshot` and is typed by ASSERTION, not validation.
   * A summary-only rep therefore threw `concentric.samples is not iterable` — and it
   * went unnoticed because this mapper had no app caller until the diverging dual
   * stage wired it in, while every test above built reps WITH samples.
   *
   * The fixtures here deliberately omit `samples` entirely rather than passing `[]`:
   * `[]` is what a correct producer sends, and asserting on it would not have caught
   * the bug.
   */
  const summaryRep = (peakMms: number, repNumber: number): Rep =>
    ({
      repNumber,
      concentric: { peakVelocity: peakMms, _totalVelocity: peakMms, _movementSampleCount: 1 },
      eccentric: {},
    }) as unknown as Rep;

  it('does not throw, and reports no curve samples', () => {
    const model = mapStoreToFatigueModel(
      sources({ snapshot: snapshotWithActive([summaryRep(700, 1), summaryRep(650, 2)]) }),
    );
    expect(model).not.toBeNull();
    expect(model!.velocityCurves).toHaveLength(2);
    expect(model!.velocityCurves[0].samples).toEqual([]);
  });

  it('reports a ZERO grind signature rather than inventing one', () => {
    // No samples means no shape to read. Zero is the honest answer; anything else
    // would be a fabricated verdict off data that never arrived.
    const model = mapStoreToFatigueModel(
      sources({ snapshot: snapshotWithActive([summaryRep(700, 1)]) }),
    );
    expect(model!.velocityCurves[0].grindSignature).toBe(0);
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

  function slot(slotId: string, reps: Rep[], deviceId?: string): Snapshot['devices'][number] {
    return {
      slotId,
      device: { connected: true, weightLbs: 100, ...(deviceId ? { deviceId } : {}) },
      sets: { active: { reps }, completed: [] },
    };
  }

  function dualSnapshot(left: Rep[], right: Rep[]): Snapshot {
    return {
      session: { sessionId: 's1' },
      devices: [slot('left', left, 'V-LEFT01'), slot('right', right, 'V-RIGHT1')],
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

  it('carries the bound device label per side; null when the slot has no device identity', () => {
    const snap: Snapshot = {
      session: { sessionId: 's1' },
      // left bound with a device id; right bound but no device id yet.
      devices: [slot('left', [meanRep(500, 1)], 'V-LEFT01'), slot('right', [meanRep(500, 1)])],
      sets: { active: null, completed: [] },
    };
    const hero = mapStoreToDivergingHeroModel(sources({ snapshot: snap }));
    expect(hero.left!.label).toBe('V-LEFT01');
    expect(hero.right!.label).toBeNull();
  });

  it('wires targetReps from the prescription and liveRepIndex to the latest rep across limbs', () => {
    const hero = mapStoreToDivergingHeroModel(
      sources({
        // left is one rep ahead of right → liveRepIndex tracks the furthest-along limb.
        snapshot: dualSnapshot(
          [meanRep(600, 1), meanRep(500, 2), meanRep(480, 3)],
          [meanRep(550, 1)],
        ),
        prescription: { sets: 3, repsLow: 8, repsHigh: 12 },
      }),
    );
    expect(hero.targetReps).toBe(8);
    expect(hero.liveRepIndex).toBe(2); // 0-based index of the 3rd (latest) rep
  });

  it('reports a null liveRepIndex before any rep lands, and null targetReps without a plan', () => {
    const hero = mapStoreToDivergingHeroModel(sources({ snapshot: dualSnapshot([], []) }));
    expect(hero.liveRepIndex).toBeNull();
    expect(hero.targetReps).toBeNull();
  });
});

// --- mapStoreToFatigueModel, dual Voltra (VMCP-04.04) -------------------------

describe('mapStoreToFatigueModel (dual Voltra)', () => {
  /** A device entry mid-set. `slotId` is the fixture's stand-in for the resolved side. */
  function limb(
    slotId: string,
    reps: Rep[],
    deviceId = `V-${slotId}`,
  ): Snapshot['devices'][number] {
    return {
      slotId,
      device: { connected: true, weightLbs: 100, deviceId },
      sets: { active: { reps }, completed: [] },
    };
  }

  /**
   * A dual snapshot. The top-level `sets.active` mirrors the FIRST limb, exactly as
   * the server reports it (top-level = the primary slot's set only).
   */
  function dual(devices: Snapshot['devices']): Snapshot {
    return {
      session: { sessionId: 's1', exerciseName: 'Cable Row' },
      devices,
      sets: { active: devices[0]?.sets?.active ?? { reps: [] }, completed: [] },
    };
  }

  it('leaves the single-Voltra path unchanged (one live limb = the top-level set)', () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 450, rom: 100 },
      { concVel: 400, rom: 90 },
    ]);
    const noDevices = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }))!;
    const oneDevice = mapStoreToFatigueModel(sources({ snapshot: dual([limb('left', reps)]) }))!;

    // Every athlete-level quantity is identical whether or not per-slot sets are present.
    expect(oneDevice.rpe).toEqual(noDevices.rpe);
    expect(oneDevice.verdict).toEqual(noDevices.verdict);
    expect(oneDevice.romProgression).toEqual(noDevices.romProgression);
    expect(oneDevice.romWorkingStandardM).toEqual(noDevices.romWorkingStandardM);
    expect(oneDevice.velocityCurves).toEqual(noDevices.velocityCurves);
    expect(oneDevice.tempoSeconds).toEqual(noDevices.tempoSeconds);
    // A single limb has no imbalance to state, and the card can tell that from the count.
    expect(noDevices.asymmetry).toBeNull();
    expect(oneDevice.asymmetry).toBeNull();
    expect(noDevices.contributingLimbCount).toBe(0);
    expect(oneDevice.contributingLimbCount).toBe(1);
  });

  it('folds the two limbs into ONE set, taking the limiting (slower) observation per rep', () => {
    // Rep 1: left is slower (500 < 600) → its 100 mm ROM survives.
    // Rep 2: right is slower (300 < 400) → its 60 mm ROM survives.
    const left = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 400, rom: 100 },
    ]);
    const right = buildReps([
      { concVel: 600, rom: 60 },
      { concVel: 300, rom: 60 },
    ]);
    const model = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('left', left), limb('right', right)]) }),
    )!;

    expect(model.contributingLimbCount).toBe(2);
    // ONE shared set of 2 reps — not 4 concatenated, and not one arm's stream.
    expect(model.romProgression).toEqual([
      { repNumber: 1, romM: 0.1 },
      { repNumber: 2, romM: 0.06 },
    ]);
    expect(model.velocityCurves).toHaveLength(2);
  });

  it('never lets a fresh limb mask a collapsing one (the fold is not an average)', () => {
    const collapsing = buildReps([
      { concVel: 600, rom: 100 },
      { concVel: 200, rom: 100 },
      { concVel: 150, rom: 100 },
    ]);
    const fresh = buildReps([
      { concVel: 600, rom: 100 },
      { concVel: 595, rom: 100 },
      { concVel: 590, rom: 100 },
    ]);
    const shared = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('left', collapsing), limb('right', fresh)]) }),
    )!;
    const collapsingOnly = mapStoreToFatigueModel(
      sources({ snapshot: snapshotWithActive(collapsing) }),
    )!;
    // The shared card reads the failing side, not the comfortable one.
    expect(shared.verdict).toEqual(collapsingOnly.verdict);
  });

  it('keeps rep numbers only one limb reached (no fabricated counterpart)', () => {
    const left = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 480, rom: 100 },
      { concVel: 460, rom: 100 },
    ]);
    const right = buildReps([{ concVel: 520, rom: 100 }]);
    const model = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('left', left), limb('right', right)]) }),
    )!;
    expect(model.romProgression.map((p) => p.repNumber)).toEqual([1, 2, 3]);
  });

  it('states the L/R imbalance magnitude and which side is stronger', () => {
    const left = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
    ]);
    const right = buildReps([
      { concVel: 600, rom: 100 },
      { concVel: 600, rom: 100 },
    ]);
    const model = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('left', left), limb('right', right)]) }),
    )!;
    // 0.5 vs 0.6 m/s → |Δ| / stronger = 16.7%, right side ahead.
    expect(model.asymmetry).toEqual({
      pct: 16.7,
      strongerSide: 'right',
      strongerLabel: 'Right',
    });
  });

  it('reports a 0% imbalance for two matched limbs', () => {
    const reps = () =>
      buildReps([
        { concVel: 500, rom: 100 },
        { concVel: 500, rom: 100 },
      ]);
    const model = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('left', reps()), limb('right', reps())]) }),
    )!;
    expect(model.asymmetry!.pct).toBe(0);
  });

  it('reports NO imbalance when the live limbs do not resolve to a left and a right', () => {
    const reps = () => buildReps([{ concVel: 500, rom: 100 }]);
    // Two live devices bound to non-limb slots — we do not guess which arm is which.
    const model = mapStoreToFatigueModel(
      sources({ snapshot: dual([limb('primary', reps()), limb('secondary', reps())]) }),
    )!;
    expect(model.contributingLimbCount).toBe(2);
    expect(model.asymmetry).toBeNull();
  });

  it('reports NO imbalance while a side has not logged a rep yet', () => {
    const model = mapStoreToFatigueModel(
      sources({
        snapshot: dual([limb('left', buildReps([{ concVel: 500, rom: 100 }])), limb('right', [])]),
      }),
    )!;
    expect(model.contributingLimbCount).toBe(2);
    expect(model.asymmetry).toBeNull();
    // …but the side that IS lifting still drives the shared card.
    expect(model.romProgression).toEqual([{ repNumber: 1, romM: 0.1 }]);
  });
});
