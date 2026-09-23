// VW-536: `set.update` relabels a set while another writer persists its reps.
//
// The race lives above the port, so it is driven through the tool handler, in
// the two variants of `store-concurrency.test.ts`: `Promise.all` on one store
// instance, and two store instances on one temp file. The handler reads first,
// so the rep writer lands between its read and its write.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredRep,
  type StoredSet,
} from '../../store/types.js';
import { registerSetTools } from '../set-tools.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const AT = '2026-09-20T18:00:00.000Z';
const SET_TOOLS = ['set.start', 'set.end', 'set.live_metrics', 'set.update', 'set.get'];

type Invoke = (name: string, args: unknown) => Promise<unknown>;

/** Register the set tools against `store` and hand back a caller for them. */
function setToolsOn(store: SessionStore): Invoke {
  const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
  const placeholders = new Map(
    SET_TOOLS.map((name) => [
      name,
      {
        update: (u: { callback: (args: unknown) => Promise<unknown> }) =>
          callbacks.set(name, u.callback),
      },
    ]),
  );
  const state = { store } as unknown as ServerState;
  registerSetTools({} as never, state, placeholders as never);
  return (name, args) => callbacks.get(name)!(args);
}

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
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function setWithReps(repCount: number): StoredSet {
  return {
    id: 'set-1',
    sessionId: 'sess-1',
    userId: LOCAL_USER_ID,
    startedAt: AT,
    endedAt: AT,
    partial: false,
    reps: Array.from(
      { length: repCount },
      (_u, i): StoredRep => ({
        id: `set-1-rep-${String(i)}`,
        setId: 'set-1',
        index: i,
        repNumber: i + 1,
        concentric: EMPTY_PHASE,
        eccentric: EMPTY_PHASE,
      }),
    ),
  };
}

const READ_REPS = 3;
const PERSISTED_REPS = 7;

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-set-update-'));
  const store = SqliteSessionStore.open(join(dir, 'store.sqlite'));
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function seed(store: SessionStore): Promise<void> {
  await store.putSession({ id: 'sess-1', startedAt: AT });
  await store.putSet(setWithReps(READ_REPS));
}

describe('set.update racing a rep write (VW-536)', () => {
  it('never reverts persisted reps, on one connection', async () => {
    const store = openStore();
    await seed(store);
    const invoke = setToolsOn(store);

    await Promise.all([
      invoke('set.update', { setId: 'set-1', lifter: 'Jordan' }),
      store.putSet(setWithReps(PERSISTED_REPS)),
    ]);

    expect((await store.getSet('set-1'))?.reps).toHaveLength(PERSISTED_REPS);
  });

  it('never reverts persisted reps written by a second connection', async () => {
    const [a, b] = [openStore(), openStore()];
    await seed(a);
    const invoke = setToolsOn(a);

    await Promise.all([
      invoke('set.update', { setId: 'set-1', lifter: 'Jordan' }),
      b.putSet(setWithReps(PERSISTED_REPS)),
    ]);

    expect((await b.getSet('set-1'))?.reps).toHaveLength(PERSISTED_REPS);
  });
});
