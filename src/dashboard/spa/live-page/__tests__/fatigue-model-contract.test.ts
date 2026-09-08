/**
 * MECHANICAL GUARD 1 of 2 for the SPA↔titan fatigue contract (VMCP-03.06): the mapper's
 * output, re-assembled field by field into an OBJECT LITERAL typed `LiveFatigueModel`.
 *
 * Why a literal. Assigning the mapper's already-typed return value proves nothing —
 * TypeScript skips excess-property checking for anything but a fresh object literal, and a
 * field titan drops or renames just stops being read. Spelling every field into a literal
 * makes tsc check the shape in both directions: a removed/renamed titan field fails as an
 * unknown property here, a new REQUIRED titan field fails as a missing one.
 *
 * WHY THIS FILE LIVES UNDER `spa/`: `src/dashboard/__tests__` is typechecked by neither
 * config — the root tsconfig excludes every `.test.ts`, and the SPA one includes only files
 * under `spa`. A guard placed there would be inert. `tsc -p src/dashboard/spa/tsconfig.json`
 * covers this directory, which is the whole point.
 *
 * The optional-field half of the guard is `fatigue-model-optionals.test.ts`.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveFatiguePanel } from '@titan-design/react-ui';
import {
  addSampleToSet,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

import { initialAccumulatorState, type Snapshot } from '../../adapter';
import { mapStoreToFatigueModel } from '../../panels/fatigue-view';
import type { LiveViewSources } from '../../panels/live-view';
import type { LiveFatigueModel } from '../fatigue-model';

/** One rep: a concentric rise to `romM` then an eccentric return. Values already m/s and m. */
function repSamples(velocityMps: number, romM: number, seq: number, t0: number): WorkoutSample[] {
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: velocityMps,
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + 500,
      phase: MovementPhase.CONCENTRIC,
      position: romM,
      velocity: velocityMps,
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + 600,
      phase: MovementPhase.ECCENTRIC,
      position: romM,
      velocity: velocityMps * 0.5,
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + 1600,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: velocityMps * 0.5,
      force: 80,
    },
  ];
}

/** A fading three-rep set — enough reps for a verdict AND a working-ROM standard. */
function fixtureReps(): Rep[] {
  let set = createSet();
  let t = 1000;
  let seq = 0;
  for (const [velocityMps, romM] of [
    [0.5, 0.4],
    [0.46, 0.39],
    [0.4, 0.35],
  ]) {
    for (const sample of repSamples(velocityMps, romM, seq, t)) set = addSampleToSet(set, sample);
    seq += 4;
    t += 3000;
  }
  return [...set.reps];
}

function withReps(reps: Rep[]): LiveViewSources {
  const snapshot: Snapshot = {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [],
    sets: { active: { reps }, completed: [] },
  };
  return {
    snapshot,
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: { sets: 3, repsLow: 8, repsHigh: 12, tempo: [3, 0, 1, 0] },
  };
}

function fixtureSources(): LiveViewSources {
  return withReps(fixtureReps());
}

/**
 * ONE rep carrying every phase in turn: concentric, a deliberate HOLD under load, undirected
 * IDLE dead time, then the eccentric. Feeds the #211 assertions below.
 */
function heldRep(): Rep[] {
  let set = createSet();
  const phases: Array<[MovementPhase, number, number, number]> = [
    [MovementPhase.CONCENTRIC, 1000, 0, 0.5],
    [MovementPhase.CONCENTRIC, 1500, 0.4, 0.5],
    [MovementPhase.HOLD, 1600, 0.4, 0],
    [MovementPhase.IDLE, 2000, 0.4, 0],
    [MovementPhase.ECCENTRIC, 2100, 0.4, 0.2],
    [MovementPhase.ECCENTRIC, 2600, 0, 0.2],
  ];
  phases.forEach(([phase, timestamp, position, velocity], sequence) => {
    set = addSampleToSet(set, { sequence, timestamp, phase, position, velocity, force: 90 });
  });
  return [...set.reps];
}

describe('the fatigue mapper against titan’s LiveFatigueModel (VMCP-03.06)', () => {
  it('produces every field titan declares, and no field it does not', () => {
    const mapped = mapStoreToFatigueModel(fixtureSources());
    expect(mapped).not.toBeNull();

    // The guard. Every property is spelled out, so tsc checks this literal against titan's
    // type — NOT against a local copy that could quietly disagree with it.
    const snapshot: LiveFatigueModel = {
      rpe: mapped!.rpe,
      repsInReserve: mapped!.repsInReserve,
      verdict: mapped!.verdict,
      romProgression: mapped!.romProgression,
      plannedReps: mapped!.plannedReps,
      romWorkingStandardM: mapped!.romWorkingStandardM,
      romShortThresholdM: mapped!.romShortThresholdM,
      velocityCurves: mapped!.velocityCurves,
      tempoSeconds: mapped!.tempoSeconds,
      targetTempoSeconds: mapped!.targetTempoSeconds,
      // SPA-only, beyond titan's card — see `fatigue-model.ts`.
      contributingLimbCount: mapped!.contributingLimbCount,
      asymmetry: mapped!.asymmetry,
    };

    expect(snapshot).toEqual(mapped);
  });

  it('fills the fixture snapshot from real analytics, not defaults', () => {
    const mapped = mapStoreToFatigueModel(fixtureSources())!;

    expect(mapped.romProgression).toEqual([
      { repNumber: 1, romM: 0.4 },
      { repNumber: 2, romM: 0.39 },
      { repNumber: 3, romM: 0.35 },
    ]);
    expect(mapped.velocityCurves).toHaveLength(3);
    expect(mapped.plannedReps).toBe(8);
    expect(mapped.targetTempoSeconds).toEqual([3, 0, 1, 0]);
    expect(mapped.verdict).not.toBeNull();
    expect(mapped.romWorkingStandardM).not.toBeNull();
    // Single-device fixture: imbalance is not a thing here, so it reads as an honest gap.
    expect(mapped.contributingLimbCount).toBe(0);
    expect(mapped.asymmetry).toBeNull();
  });

  it('flows plannedReps through to the ROM chart’s dashed to-do slots', () => {
    // The bug this ticket codifies, seen at the pixel: an unset `plannedReps` renders no
    // to-do slots at all, so a 3-of-8 set reads as finished. The fixture logs 3 reps
    // against a plan of 8, so the chart must draw 5 dashed placeholders.
    const model = mapStoreToFatigueModel(fixtureSources())!;
    const html = renderToStaticMarkup(
      createElement(LiveFatiguePanel, { model, velocity: { velocities: [0.5, 0.46, 0.4] } }),
    );
    expect(html.match(/data-testid="rom-slot-todo"/g)).toHaveLength(
      model.plannedReps! - model.romProgression.length,
    );

    const { plannedReps: _dropped, ...withoutPlan } = model;
    const unplanned = renderToStaticMarkup(
      createElement(LiveFatiguePanel, {
        model: withoutPlan,
        velocity: { velocities: [0.5, 0.46, 0.4] },
      }),
    );
    expect(unplanned).not.toContain('rom-slot-todo');
  });

  it('keeps the HOLD phase distinct from idle at this boundary (#211)', () => {
    // #211 widened `SamplePhase` to carry `hold`; importing titan's type must not lose it.
    // Assert on the phase of the samples that CARRY each value, so folding HOLD back into
    // 'idle' (the pre-#211 behaviour) fails here rather than reading as "still in the union".
    const reps = heldRep();
    const model = mapStoreToFatigueModel(withReps(reps))!;
    const samples = model.velocityCurves[0].samples;

    // Sample 3 is the deliberate hold under load; sample 4 is undirected dead time. They are
    // different facts and the ghost-spark's zero-axis gives them different greys.
    expect(samples[2].phase).toBe('hold');
    expect(samples[3].phase).toBe('idle');
    expect(model.velocityCurves[0].phaseSegments.map((s) => s.phase)).toEqual([
      'concentric',
      'hold',
      'idle',
      'eccentric',
    ]);
  });
});
