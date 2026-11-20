// The one rep-band rule (VW-937) shared by `computeProgressionDelta`'s tally and the
// completion page's rep marks, plus a parity check that the two never drift apart.

import { describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { classifyRepsAgainstBand, type RepBandClass } from '../rep-band.js';
import { repMarks } from '../../dashboard/spa/planner/session-summary-model.js';
import type {
  SessionSummaryExercise,
  SessionSummarySet,
} from '../../dashboard/read-models/session-summary-view.js';
import {
  loadSummary,
  SUMMARY_FIXTURES,
} from '../../dashboard/__tests__/fixtures/session-summary/load.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: Error,
  TrainingMode: {},
  TrainingModeNames: {},
}));

const { computeProgressionDelta } = await import('../../tools/plan-tools.js');

describe('classifying reps against a band', () => {
  it.each([
    [7, 'under'],
    [8, 'in'],
    [11, 'in'],
    [12, 'over'],
    [14, 'over'],
  ] as const)('%i reps against 8-12 is %s', (reps, expected) => {
    expect(classifyRepsAgainstBand(reps, 8, 12)).toBe(expected);
  });

  it('treats a band with no top as a single target that reaching tops out', () => {
    expect(classifyRepsAgainstBand(5, 5, undefined)).toBe('over');
    expect(classifyRepsAgainstBand(4, 5, undefined)).toBe('under');
  });
});

const PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0.6,
  peakForce: 0,
  peakLoad: 0,
};

function storedRep(setId: string, index: number): StoredRep {
  const rep = { repNumber: index + 1, concentric: PHASE, eccentric: PHASE } as Rep;
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

function storedSet(set: SessionSummarySet): StoredSet {
  return {
    id: set.id,
    sessionId: 'fixture',
    startedAt: set.startedAt,
    endedAt: set.endedAt,
    partial: false,
    setPurpose: set.setPurpose,
    ...(set.weightLbs === null ? {} : { weightLbs: set.weightLbs }),
    reps: Array.from({ length: set.repCount }, (_, i) => storedRep(set.id, i)),
  } as StoredSet;
}

function plannedRow(exercise: SessionSummaryExercise, low: number): StoredPlannedExercise {
  const high = exercise.progression?.targetRepsHigh ?? undefined;
  return {
    id: 'pe-fixture',
    workoutTemplateId: 'tmpl-fixture',
    exerciseId: exercise.exerciseId ?? 'fixture',
    orderIndex: 0,
    targetSets: exercise.progression?.targetSets ?? 0,
    targetRepsLow: low,
    ...(high === undefined ? {} : { targetRepsHigh: high }),
  };
}

const COUNT_WORD: Record<string, RepBandClass> = {
  hit: 'over',
  'landed in band': 'in',
  missed: 'under',
};

/** The tally count the server's own reasoning reports, e.g. `2/3 sets missed`. */
function serverCount(reasoning: string): { mark: RepBandClass; count: number; of: number } {
  const match = /^(\d+)\/(\d+) sets (hit|landed in band|missed)/.exec(reasoning);
  if (match === null) throw new Error(`unparsed reasoning: ${reasoning}`);
  return { mark: COUNT_WORD[match[3]], count: Number(match[1]), of: Number(match[2]) };
}

const SCORED = SUMMARY_FIXTURES.flatMap((name) =>
  loadSummary(name)
    .exercises.filter((e) => e.progression?.targetRepsLow != null)
    .map((exercise) => [`${name}: ${exercise.name}`, exercise] as const),
);

describe('the page rep marks agree with the server tally', () => {
  it('covers at least one prescribed exercise per fixture', () => {
    expect(new Set(SCORED.map(([label]) => label.split(':')[0])).size).toBe(
      SUMMARY_FIXTURES.length,
    );
  });

  it.each(SCORED)('%s', (_label, exercise) => {
    const low = exercise.progression?.targetRepsLow ?? 0;
    const suggestion = computeProgressionDelta(
      plannedRow(exercise, low),
      exercise.sets.map(storedSet),
      'fixture',
    );
    const server = serverCount(suggestion.reasoning);
    const marks = repMarks(exercise);

    expect(marks).toHaveLength(server.of);
    expect(marks.filter((m) => m.mark === server.mark)).toHaveLength(server.count);
    expect(suggestion.delta).toBe(exercise.progression?.delta);
    expect(suggestion.reasoning).toBe(exercise.progression?.reasoning);
  });
});
