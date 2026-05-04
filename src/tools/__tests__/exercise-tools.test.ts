// Unit tests for `registerExerciseTools`.
//
// Wave 3D (Task 13) — `exercise.search` and `exercise.get` delegate fully to
// `state.exercises` (the `ExerciseService` wrapper from Wave 2B). These tests
// assert the wave-3 transport seam: the registered handlers swap into the
// `STARTING` placeholder slots, parse input via the wave-2 schemas, call the
// service, and serialize the result through `wrapHandler` / `textResult`.
//
// AC-22 (R22): the catalog wrapper must be invoked unchanged, and only the
// public `Exercise` fields appear in the output (no extra fields injected).
//
// The `@voltras/node-sdk` namespace is stubbed because helpers.ts → errors.ts
// transitively imports `VoltraSDKError`; the stub keeps the static import
// chain hermetic without pulling optional native peers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
}));

const { registerExerciseTools } = await import('../exercise-tools.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');

import type { Exercise } from '../../exercises/exercise-service.js';
import type { ServerState } from '../../state/server-state.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

const benchPress: Exercise = {
  id: 'bench-press',
  name: 'Bench Press',
  muscleGroups: ['chest'],
  movementPattern: 'push',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'barbell' }],
  cableEquivalent: false,
  qualityScore: 95,
};

const inclineBench: Exercise = {
  id: 'incline-bench-press',
  name: 'Incline Bench Press',
  muscleGroups: ['chest'],
  movementPattern: 'push',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'barbell' }],
  cableEquivalent: false,
  qualityScore: 90,
};

interface FakePlaceholder {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void;
}

interface ToolResultShape {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Build a minimal ServerState with a stubbed `exercises` service. */
function buildHarness(): {
  search: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  state: ServerState;
  placeholders: Map<string, RegisteredTool>;
  invoke: (name: 'exercise.search' | 'exercise.get', args: unknown) => Promise<ToolResultShape>;
} {
  const search = vi.fn();
  const getById = vi.fn();
  const exercises = new ExerciseService();
  exercises.search = search as unknown as ExerciseService['search'];
  exercises.getById = getById as unknown as ExerciseService['getById'];

  const state = { exercises } as unknown as ServerState;
  const placeholders = new Map<string, FakePlaceholder>();
  for (const name of ['exercise.search', 'exercise.get']) {
    const ph: FakePlaceholder = {
      update({ callback }): void {
        if (callback) ph.callback = callback;
      },
    };
    placeholders.set(name, ph);
  }
  // The McpServer-typed Map is what the production signature accepts — the
  // shape we exercise (`update({ callback })`) is the same.
  const typedPlaceholders = placeholders as unknown as Map<string, RegisteredTool>;
  // McpServer stub passed through registerExerciseTools — never used because
  // every handler attaches via `placeholder.update({ callback })`.
  const fakeServer = {} as Parameters<typeof registerExerciseTools>[0];

  registerExerciseTools(fakeServer, state, typedPlaceholders);

  const invoke = async (
    name: 'exercise.search' | 'exercise.get',
    args: unknown,
  ): Promise<ToolResultShape> => {
    const ph = placeholders.get(name);
    if (!ph?.callback) throw new Error(`No callback registered for ${name}`);
    return (await ph.callback(args)) as ToolResultShape;
  };

  return { search, getById, state, placeholders: typedPlaceholders, invoke };
}

describe('registerExerciseTools', () => {
  describe('exercise.search', () => {
    let harness: ReturnType<typeof buildHarness>;
    beforeEach(() => {
      harness = buildHarness();
    });

    it('delegates to state.exercises.search and returns its result', async () => {
      const expected = [benchPress, inclineBench];
      harness.search.mockReturnValue(expected);

      const result = await harness.invoke('exercise.search', { query: 'bench' });

      expect(harness.search).toHaveBeenCalledTimes(1);
      expect(harness.search).toHaveBeenCalledWith('bench');
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(expected);
    });

    it('passes the query verbatim (no trimming or casing)', async () => {
      harness.search.mockReturnValue([]);

      await harness.invoke('exercise.search', { query: '  Bench Press  ' });

      expect(harness.search).toHaveBeenCalledWith('  Bench Press  ');
    });

    it('returns an empty array (not an error) when search has no matches', async () => {
      harness.search.mockReturnValue([]);

      const result = await harness.invoke('exercise.search', { query: 'xyzzy' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });

    it('returns the catalog entries with no extra fields beyond Exercise (AC-22)', async () => {
      harness.search.mockReturnValue([benchPress]);

      const result = await harness.invoke('exercise.search', { query: 'bench' });

      const parsed = JSON.parse(result.content[0].text) as Exercise[];
      expect(parsed).toEqual([benchPress]);
      expect(Object.keys(parsed[0]).sort()).toEqual(Object.keys(benchPress).sort());
    });

    it('returns INVALID_INPUT for an empty query string', async () => {
      const result = await harness.invoke('exercise.search', { query: '' });

      expect(harness.search).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT when the query field is missing', async () => {
      const result = await harness.invoke('exercise.search', {});

      expect(harness.search).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
    });
  });

  describe('exercise.get', () => {
    let harness: ReturnType<typeof buildHarness>;
    beforeEach(() => {
      harness = buildHarness();
    });

    it('delegates to state.exercises.getById and returns the matching entry', async () => {
      harness.getById.mockReturnValue(benchPress);

      const result = await harness.invoke('exercise.get', { id: 'bench-press' });

      expect(harness.getById).toHaveBeenCalledTimes(1);
      expect(harness.getById).toHaveBeenCalledWith('bench-press');
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual(benchPress);
    });

    it('returns the catalog entry with no extra fields beyond Exercise (AC-22)', async () => {
      harness.getById.mockReturnValue(benchPress);

      const result = await harness.invoke('exercise.get', { id: 'bench-press' });

      const parsed = JSON.parse(result.content[0].text) as Exercise;
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(benchPress).sort());
    });

    it('returns NOT_FOUND when the id is unknown', async () => {
      harness.getById.mockReturnValue(undefined);

      const result = await harness.invoke('exercise.get', { id: 'does-not-exist' });

      expect(harness.getById).toHaveBeenCalledWith('does-not-exist');
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe('NOT_FOUND');
      expect(parsed.message).toContain('does-not-exist');
    });

    it('returns INVALID_INPUT for an empty id', async () => {
      const result = await harness.invoke('exercise.get', { id: '' });

      expect(harness.getById).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT when the id field is missing', async () => {
      const result = await harness.invoke('exercise.get', {});

      expect(harness.getById).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
    });
  });

  describe('registration wiring', () => {
    it('attaches handlers to both placeholder slots via update()', () => {
      const harness = buildHarness();
      // Both handlers are reachable via `invoke` only after registerExerciseTools
      // wires them into the placeholders Map. Cast back to FakePlaceholder to
      // observe the swapped-in callback.
      const search = harness.placeholders.get('exercise.search') as unknown as FakePlaceholder;
      const get = harness.placeholders.get('exercise.get') as unknown as FakePlaceholder;
      expect(typeof search.callback).toBe('function');
      expect(typeof get.callback).toBe('function');
    });
  });
});
