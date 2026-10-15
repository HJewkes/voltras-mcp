// VW-661: `session.volume` reads the VW-561 weight table, landmark and dose,
// through the real exercise catalog. Sets are synthetic and mock-sourced.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setCatalog, type Phase } from '@voltras/workout-analytics';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { registerMetricsTools } = await import('../metrics-tools.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');
const { MUSCLE_MAP_VERSION } = await import('../../exercises/muscle-map.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { ToolResult } from '../helpers.js';

interface SessionVolume {
  setsByMuscle: Record<string, number>;
  doseSetsByMuscle: Record<string, number>;
  muscleMapVersion: string;
  model: string;
}

const PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 1,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0.5,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...PHASE },
    eccentric: { ...PHASE },
  };
}

function oneSetOf(exerciseId: string): StoredSet {
  return {
    id: `${exerciseId}-1`,
    sessionId: 'sess-1',
    startedAt: '2026-09-08T18:00:00.000Z',
    endedAt: '2026-09-08T18:00:40.000Z',
    partial: false,
    weightLbs: 100,
    exerciseId,
    source: 'mock',
    reps: [makeRep(exerciseId, 0), makeRep(exerciseId, 1)],
  };
}

async function sessionVolumeOf(sets: StoredSet[]): Promise<SessionVolume> {
  const state = {
    store: { getSetsForSession: vi.fn(async () => sets) },
    exercises: new ExerciseService(),
  } as unknown as ServerState;
  let handler: ((args: unknown) => Promise<ToolResult>) | undefined;
  const placeholder = {
    update: ({ callback }: { callback: (args: unknown) => Promise<ToolResult> }) => {
      handler = callback;
    },
  } as unknown as RegisteredTool;
  registerMetricsTools({} as McpServer, state, new Map([['metrics.compute', placeholder]]));

  const result = await handler!({ pipeline: 'session.volume', sessionId: 'sess-1' });
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  return JSON.parse(result.content[0].text) as SessionVolume;
}

describe('session.volume on the muscle weight table', () => {
  beforeAll(() => setCatalog(SEED_CABLE_EXERCISES));

  it('counts an overhead press set to front delts only, with its dose spread to side delts and triceps', async () => {
    const volume = await sessionVolumeOf([oneSetOf('cable-shoulder-press')]);

    expect(volume.setsByMuscle).toEqual({ front_delts: 1 });
    expect(volume.doseSetsByMuscle).toEqual({ front_delts: 1, triceps: 0.5, side_delts: 0.5 });
    expect(volume.model).toBe('target-only');
    expect(volume.muscleMapVersion).toBe(MUSCLE_MAP_VERSION);
  });

  it('gives a chest press no delt set, and half a front delt set in the dose read', async () => {
    const volume = await sessionVolumeOf([oneSetOf('cable-chest-press')]);

    expect(volume.setsByMuscle).toEqual({ chest: 1 });
    expect(volume.doseSetsByMuscle.front_delts).toBe(0.5);
  });

  it('counts a Romanian deadlift to hamstrings, with half a glute set in the dose and no lats', async () => {
    const volume = await sessionVolumeOf([oneSetOf('cable-romanian-deadlift')]);

    expect(volume.setsByMuscle).toEqual({ hamstrings: 1 });
    expect(volume.doseSetsByMuscle).toEqual({ hamstrings: 1, glutes: 0.5 });
  });

  it('counts a pull-through to glutes', async () => {
    const volume = await sessionVolumeOf([oneSetOf('cable-pull-through')]);

    expect(volume.setsByMuscle).toEqual({ glutes: 1 });
  });
});
