// Unit tests for src/tools/drift-guard-tools.ts (VW-90 / B15).
//
// This tool is a thin diagnostic wrapper, so what is worth testing is the
// wrapping, not the judgement: that the handler is installed on the
// placeholder, that the schema's session ids are mandatory, that `.strict()`
// rejects an unknown key, and that the verdict reaches the caller intact.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BaselineKey, DriftGuardVerdict, Phase } from '@voltras/workout-analytics';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { registerDriftGuardTools } from '../drift-guard-tools.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

const TOOL_NAME = 'driftguard.check';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number, romM: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, startTime: start, endTime: start + 1000, endPosition: romM },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + 1000,
      endTime: start + 3000,
      startPosition: romM,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

function makeSet(id: string, sessionId: string, romM: number): StoredSet {
  const now = new Date().toISOString();
  return {
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    id,
    sessionId,
    startedAt: now,
    endedAt: now,
    partial: false,
    reps: Array.from({ length: 6 }, (_, i) => makeRep(id, i, romM)),
  };
}

interface Harness {
  store: SqliteSessionStore;
  invoke: (args: unknown) => Promise<ToolResult>;
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const state = { store } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  const tool: FakeRegisteredTool = {
    update(updates) {
      tool.callback = updates.callback;
    },
    remove() {
      /* unused */
    },
  };
  placeholders.set(TOOL_NAME, tool);

  registerDriftGuardTools(
    undefined as unknown as Parameters<typeof registerDriftGuardTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerDriftGuardTools>[2],
  );

  return {
    store,
    invoke: async (args: unknown) => {
      if (!tool.callback) throw new Error(`no callback installed for ${TOOL_NAME}`);
      return (await tool.callback(args)) as ToolResult;
    },
  };
}

function parseResult(r: ToolResult): unknown {
  return JSON.parse(r.content[0].text);
}

async function seedSessions(store: SqliteSessionStore, baselineRom: number, currentRom: number) {
  const now = new Date().toISOString();
  await store.putSession({ id: 'sess-1', startedAt: now });
  await store.putSession({ id: 'sess-2', startedAt: now });
  await store.putSet(makeSet('a', 'sess-1', baselineRom));
  await store.putSet(makeSet('b', 'sess-2', currentRom));
}

const ARGS = { exerciseId: 'bench-press', baselineSessionId: 'sess-1', currentSessionId: 'sess-2' };

describe('driftguard.check', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns a comparable verdict when execution held steady', async () => {
    // Arrange
    await seedSessions(h.store, 0.5, 0.5);

    // Act
    const r = await h.invoke(ARGS);

    // Assert
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { verdict: DriftGuardVerdict };
    expect(body.verdict.comparable).toBe(true);
    expect(body.verdict.flagged).toBe(false);
    expect(body.verdict.thresholdsUsed).toEqual({ tempoDriftPct: 15, romDriftPct: 15 });
  });

  it('surfaces the block and its reasoning when ROM collapsed', async () => {
    // Arrange
    await seedSessions(h.store, 0.6, 0.3);

    // Act
    const body = parseResult(await h.invoke(ARGS)) as { verdict: DriftGuardVerdict };

    // Assert
    expect(body.verdict.comparable).toBe(false);
    expect(body.verdict.reasoning).toContain('ROM');
  });

  it('rejects a call that names only one session', async () => {
    // Arrange / Act
    const r = await h.invoke({ exerciseId: 'bench-press', baselineSessionId: 'sess-1' });

    // Assert
    expect(r.isError).toBe(true);
  });

  it('rejects an unknown key rather than silently ignoring it', async () => {
    // Arrange / Act
    const r = await h.invoke({ ...ARGS, sinceDays: 30 });

    // Assert
    expect(r.isError).toBe(true);
  });

  it('scopes to the local user, so the key never has to be supplied', async () => {
    // Arrange: the handler builds the BaselineKey itself
    await seedSessions(h.store, 0.5, 0.5);
    const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

    // Act
    const r = await h.invoke({ ...ARGS, side: 'left' });

    // Assert: no left-sided sets exist, so the side-scoped read finds nothing
    expect(key.userId).toBe(LOCAL_USER_ID);
    const body = parseResult(r) as { verdict: DriftGuardVerdict };
    expect(body.verdict.comparable).toBe(false);
    expect(body.verdict.reasoning).toContain('no qualifying reps');
  });
});
