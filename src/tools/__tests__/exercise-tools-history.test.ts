// `exercise.search` and `exercise.get` over the real catalog with the history lifts
// loaded (VW-558, H1): a live session never sees a history lift, but its id still resolves.

import { setCatalog } from '@voltras/workout-analytics';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
}));

const { registerExerciseTools } = await import('../exercise-tools.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');
const { HISTORY_SEED_EXERCISES } = await import('../../exercises/history-seed-catalog.js');
const { SEED_CABLE_EXERCISES } = await import('../../exercises/seed-catalog.js');

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';

type Handler = (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function registerHandlers(): Record<'exercise.search' | 'exercise.get', Handler> {
  const handlers = new Map<string, Handler>();
  const placeholders = new Map(
    ['exercise.search', 'exercise.get', 'exercise.confirm_setup'].map((name) => [
      name,
      {
        update: ({ callback }: { callback?: Handler }) => {
          if (callback) handlers.set(name, callback);
        },
      },
    ]),
  );
  const state = { exercises: new ExerciseService(), store: {} } as unknown as ServerState;
  registerExerciseTools(
    {} as Parameters<typeof registerExerciseTools>[0],
    state,
    placeholders as unknown as Map<string, RegisteredTool>,
  );
  return {
    'exercise.search': handlers.get('exercise.search')!,
    'exercise.get': handlers.get('exercise.get')!,
  };
}

describe('exercise tools with the history catalog loaded', () => {
  let tools: ReturnType<typeof registerHandlers>;
  beforeAll(() => {
    setCatalog([...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES]);
    tools = registerHandlers();
  });

  it('searches "deadlift" to the cable Romanian deadlift alone', async () => {
    const result = await tools['exercise.search']({ query: 'deadlift' });

    const ids = (JSON.parse(result.content[0]!.text) as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual(['cable-romanian-deadlift']);
  });

  it('gets a history lift by its id', async () => {
    const result = await tools['exercise.get']({ id: 'barbell-deadlift' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      id: 'barbell-deadlift',
      cableEquivalent: false,
    });
  });
});
