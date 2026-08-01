// Unit tests for src/tools/mrv-guard-tools.ts (VW-91 / B04).
//
// This tool is a thin diagnostic wrapper, so what is worth testing is the
// wrapping, not the judgement: that the handler is installed on the
// placeholder, that the schema's three session ids are mandatory, that
// `.strict()` rejects an unknown key, and that the combined verdict reaches
// the caller intact.

import { beforeEach, describe, expect, it } from 'vitest';
import type { MrvGuardVerdict, Phase } from '@voltras/workout-analytics';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { registerMrvGuardTools } from '../mrv-guard-tools.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

const TOOL_NAME = 'mrvguard.check';

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

function makeRep(setId: string, index: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, startTime: start, endTime: start + 1000, endPosition: 0.5 },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + 1000,
      endTime: start + 3000,
      startPosition: 0.5,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

function makeSet(id: string, sessionId: string, repCount: number): StoredSet {
  const now = new Date().toISOString();
  return {
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    id,
    sessionId,
    startedAt: now,
    endedAt: now,
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(id, i)),
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

  registerMrvGuardTools(
    undefined as unknown as Parameters<typeof registerMrvGuardTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerMrvGuardTools>[2],
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

const ARGS = {
  exerciseId: 'bench-press',
  session1Id: 'sess-1',
  session2Id: 'sess-2',
  session3Id: 'sess-3',
};

describe('mrvguard.check', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    for (const s of ['sess-1', 'sess-2', 'sess-3']) {
      await h.store.putSession({ id: s, startedAt: new Date().toISOString() });
    }
  });

  it('flags two consecutive underperforming sessions', async () => {
    // Arrange: 6 → 4 → 3 reps at matched load
    await h.store.putSet(makeSet('a', 'sess-1', 6));
    await h.store.putSet(makeSet('b', 'sess-2', 4));
    await h.store.putSet(makeSet('c', 'sess-3', 3));

    // Act
    const r = await h.invoke(ARGS);

    // Assert
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { guard: MrvGuardVerdict };
    expect(body.guard.mrvFlagged).toBe(true);
  });

  it('rejects a call missing the third session', async () => {
    // Arrange / Act
    const r = await h.invoke({
      exerciseId: 'bench-press',
      session1Id: 'sess-1',
      session2Id: 'sess-2',
    });

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
    // Arrange: no sets recorded for the left side, so the side-scoped read finds nothing
    await h.store.putSet(makeSet('a', 'sess-1', 6));
    await h.store.putSet(makeSet('b', 'sess-2', 4));
    await h.store.putSet(makeSet('c', 'sess-3', 3));

    // Act
    const r = await h.invoke({ ...ARGS, side: 'left' });

    // Assert
    const body = parseResult(r) as { guard: MrvGuardVerdict };
    expect(body.guard.mrvFlagged).toBe(false);
    expect(body.guard.reasoning).toContain('inconclusive');
  });
});
