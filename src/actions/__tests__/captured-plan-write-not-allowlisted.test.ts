// Capturing every plan tool for the action layer allowlists none of them (VW-594).
//
// `registerPlanTools` joined the captured modules so `plan.respond_deload_advisory`
// could be allowlisted; every other plan write is captured with it and must still
// be refused, before its handler runs.
//
// Mock adapter, in-memory store, synthetic input.

import { afterEach, beforeEach, expect, it } from 'vitest';

import { captureActionHandlers } from '../capture-handlers.js';
import { executeAction } from '../execute.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';

const savedEnv = { ...process.env };
let state: ServerState;

beforeEach(async () => {
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
});

afterEach(async () => {
  await state.store.close();
  process.env = { ...savedEnv };
});

it('refuses a captured plan write that is not allowlisted with 403 and writes nothing', async () => {
  // Arrange
  const tools = captureActionHandlers(state);
  expect(tools.has('plan.program.create')).toBe(true);

  // Act
  const outcome = await executeAction(
    {
      name: 'plan.program.create',
      actionId: 'synthetic-action-1',
      actor: 'user',
      surface: 'wall',
      input: { name: 'Synthetic' },
    },
    { store: state.store, tools, now: () => new Date() },
  );

  // Assert
  expect(outcome.status).toBe(403);
  expect(await state.store.listTrainingPrograms()).toEqual([]);
});
