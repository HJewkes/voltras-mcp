// Integration test: `accountability.preview` (VW-291) over the real MCP
// transport — `createClientConnection` + a real `Client`/`InMemoryTransport`
// pair, the same wiring `runServer` uses, so the placeholder hot-swap and
// `wrapHandler` framing are exercised, not just the handler function.
//
// `VOLTRA_ADAPTER=mock` never touches BLE at bootstrap (`selectAdapter`
// resolves to `VoltraManager.forMock()`), so this needs no SDK mock — neither
// test calls a `device.*` tool.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createClientConnection } from '../../client-connection.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { assertCopyRules } from '../../accountability/__tests__/copy-rules.js';

const MONDAY_ENTERED_AT = '2026-09-14T09:00:00.000Z'; // a Monday
const THURSDAY_NOON = '2026-09-17T12:00:00';
const WEDNESDAY_NOON = '2026-09-16T12:00:00';

interface Harness {
  client: Client;
  state: ServerState;
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-accountability-preview-'));
  const savedEnv = { ...process.env };
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'preview.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  const state = await bootstrapState(loadConfig());
  process.env = savedEnv;

  const connection = createClientConnection();
  connection.activate(state);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'voltras-mcp-it', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), connection.server.connect(serverTransport)]);

  const cleanup = async (): Promise<void> => {
    await client.close();
    await connection.server.close();
    state.manager.dispose();
    await state.store.close();
    rmSync(dbDir, { recursive: true, force: true });
  };

  return { client, state, cleanup };
}

async function preview(client: Client, at: string): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name: 'accountability.preview', arguments: { at } })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** Seeds one program/block/week/template/planned-exercise so `plan.next_workout` resolves. */
async function seedPlannedWorkout(state: ServerState): Promise<void> {
  await state.store.putTrainingProgram({
    id: 'program-1',
    name: 'Upper/Lower',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  await state.store.putTrainingBlock({
    id: 'block-1',
    programId: 'program-1',
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 1,
  });
  await state.store.putTrainingWeek({ id: 'week-1', blockId: 'block-1', orderIndex: 0 });
  await state.store.putWorkoutTemplate({
    id: 'template-1',
    weekId: 'week-1',
    name: 'Upper A',
    orderIndex: 0,
  });
  await state.store.putPlannedExercise({
    id: 'planned-1',
    workoutTemplateId: 'template-1',
    exerciseId: 'cable-chest-press',
    orderIndex: 0,
    targetSets: 3,
  });
}

describe('accountability.preview (integration)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("renders miss-recovery text naming the next workout's lead exercise", async () => {
    await seedPlannedWorkout(h.state);
    await h.state.store.putAccountabilityState({
      userId: LOCAL_USER_ID,
      state: 'missed',
      enteredAt: MONDAY_ENTERED_AT,
      consecutiveMisses: 1,
      ghostSends: [],
      lastInboundAt: null,
      proactiveSends: [],
      holdingUntil: null,
    });

    const result = await preview(h.client, THURSDAY_NOON);

    expect(result.decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
    expect(result.kind).toBe('miss_recovery');
    const text = result.text as string;
    expect(typeof text).toBe('string');
    expect(() => assertCopyRules(text)).not.toThrow();
    // Unique to the miss-recovery/holding templates, never to a ghost nudge —
    // catches the kind and the render disagreeing on which template ships.
    expect(text).toMatch(/is not in the records/i);
    expect(text).toContain('Cable Chest Press');
    expect((result.inputsUsed as { nextWorkout: { templateName: string } }).nextWorkout).toEqual(
      expect.objectContaining({ templateName: 'Upper A' }),
    );
  });

  it('returns null text on a silent decision', async () => {
    const result = await preview(h.client, WEDNESDAY_NOON);

    expect(result.decision).toMatchObject({ action: 'silent' });
    expect(result.kind).toBeNull();
    expect(result.text).toBeNull();
    expect(result.inputsUsed).toBeNull();
  });
});
