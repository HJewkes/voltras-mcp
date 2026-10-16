// The plan tree names the same next workout `plan.next_workout` does (VW-949).
//
// Seeded from the steady persona: a lifter with weeks of finished workouts, the
// shape that opened the plan page on its oldest finished workout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PERSONA_NOW, seedInMemory } from '../../docs/__tests__/persona-fixture.js';
import { fetchPlanTree } from '../plan-api.js';
import { flattenTemplates } from '../spa/planner/planner-model.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { nextWorkout } = await import('../../tools/plan-tools.js');

let store: SessionStore;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PERSONA_NOW);
  store = (await seedInMemory('steady')).store;
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('plan tree nextTemplateId', () => {
  it('names the workout plan.next_workout returns for a lifter with history', async () => {
    const state = { store, exercises: { getById: () => undefined } } as unknown as ServerState;

    const tree = await fetchPlanTree(store, () => undefined);
    const next = await nextWorkout(state, {});

    expect('template' in next).toBe(true);
    const nextId = 'template' in next ? next.template.id : null;
    expect(tree.nextTemplateId).toBe(nextId);
    const templates = flattenTemplates(tree);
    expect(templates[0]?.template.completed).toBe(true);
    expect(tree.nextTemplateId).not.toBe(templates[0]?.template.id);
  });
});
