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

function fixtureSources(): LiveViewSources {
  const snapshot: Snapshot = {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [],
    sets: { active: { reps: fixtureReps() }, completed: [] },
  };
  return {
    snapshot,
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: { sets: 3, repsLow: 8, repsHigh: 12, tempo: [3, 0, 1, 0] },
  };
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
    const curve = mapStoreToFatigueModel(fixtureSources())!.velocityCurves[0];
    const phases: LiveFatigueModel['velocityCurves'][number]['phaseSegments'][number]['phase'][] = [
      'concentric',
      'eccentric',
      'hold',
      'idle',
    ];
    expect(phases).toContain(curve.phaseSegments[0].phase);
  });
});
