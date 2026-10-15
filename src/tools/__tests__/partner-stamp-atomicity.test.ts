// VW-583: a bilateral close stamps its group onto the partner set while another
// writer persists the partner's reps and relabels it.
//
// Driven through `set.end` against a real store, in the two variants of
// `set-update-atomicity.test.ts`: the competing writer on the same store, and
// on a second store over the same temp file. An interleave hook fires the
// competing write at the partner stamp: right after the partner row is read,
// or just before it is written when nothing reads it first.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, type StoredRep, type StoredSet } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSetTools } = await import('../set-tools.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { RestTimerRegistry } = await import('../../state/rest-timer.js');
const { BilateralReconciler } = await import('../../state/bilateral-reconciler.js');
const { SlotBindingsStore } = await import('../../state/slot-bindings.js');

const SESSION_ID = 'sess-1';
const PARTNER_ID = 'set-partner';
const AT = '2026-09-20T18:00:00.000Z';
const PARTNER_START = '2026-09-20T18:00:00.500Z';
const READ_REPS = 3;
const PERSISTED_REPS = 7;
const SET_TOOLS = ['set.start', 'set.end', 'set.live_metrics', 'set.update', 'set.get'];

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

function partnerRow(repCount: number): StoredSet {
  return {
    id: PARTNER_ID,
    sessionId: SESSION_ID,
    userId: LOCAL_USER_ID,
    startedAt: PARTNER_START,
    endedAt: '2026-09-20T18:00:30.000Z',
    partial: false,
    weightLbs: 30,
    slot: 'secondary',
    reps: Array.from(
      { length: repCount },
      (_u, i): StoredRep => ({
        id: `${PARTNER_ID}-rep-${String(i)}`,
        setId: PARTNER_ID,
        index: i,
        repNumber: i + 1,
        concentric: EMPTY_PHASE,
        eccentric: EMPTY_PHASE,
      }),
    ),
  };
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-partner-stamp-'));
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The partner's other writer: persist more reps, then relabel the set. */
async function competingWrite(writer: SessionStore): Promise<void> {
  await writer.putSet(partnerRow(PERSISTED_REPS));
  await writer.patchSetLifter(PARTNER_ID, 'Jordan');
}

/** `store`, with `competingWrite` fired once at the partner stamp. */
function interleavedAtPartnerStamp(store: SessionStore, writer: SessionStore): SessionStore {
  let fired = false;
  const fireOnce = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await competingWrite(writer);
  };
  return new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      const method = (value as (...args: unknown[]) => Promise<unknown>).bind(target);
      if (prop === 'getSet') {
        return async (id: string) => {
          const read = await method(id);
          if (id === PARTNER_ID) await fireOnce();
          return read;
        };
      }
      if (prop === 'patchSetBilateralGroup') {
        return async (id: string, ...rest: unknown[]) => {
          if (id === PARTNER_ID) await fireOnce();
          return method(id, ...rest);
        };
      }
      return method;
    },
  });
}

function stateOver(store: SessionStore): ServerState {
  const live = new LiveState();
  live.startSession({ sessionId: SESSION_ID, startedAt: AT, setIds: [], status: 'active' });
  live.applySettings({ connected: true, weightLbs: 30, trainingMode: 'WeightTraining' });
  const client = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    endSet: vi.fn().mockResolvedValue(undefined),
    isRowingActive: false,
    connectedDeviceId: 'device-left',
  };
  const publisher = { publish: vi.fn(), forSlot: () => publisher };
  const slots = new Map([
    ['primary', { slotId: 'primary', client, live, modeRevertGuard: new ModeRevertGuard() }],
  ]);
  const reconciler = new BilateralReconciler();
  reconciler.record({
    slotId: 'secondary',
    setId: PARTNER_ID,
    sessionId: SESSION_ID,
    startedAtMs: Date.parse(PARTNER_START),
    repCount: READ_REPS,
    weightLbs: 30,
  });
  return {
    config: { restTimer: 'off', effortCue: 'off' },
    manager: {},
    slots,
    store,
    exercises: {},
    channels: publisher,
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
    bilateralReconciler: reconciler,
    slotBindings: SlotBindingsStore.open(join(dir!, 'slot-bindings.json')),
  } as unknown as ServerState;
}

/** Close a set on `primary` that pairs with the seeded partner, and return its row. */
async function closePairedSet(state: ServerState): Promise<StoredSet> {
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
  registerSetTools({ tool: vi.fn() } as never, state, placeholders as never);
  const live = state.slots.get('primary')!.live;
  await callbacks.get('set.start')!({});
  live.set!.startedAt = AT;
  await callbacks.get('set.end')!({});
  const rows = await state.store.getSetsForSession(SESSION_ID);
  const closing = rows.find((row) => row.id !== PARTNER_ID);
  expect(closing).toBeDefined();
  return closing!;
}

async function seed(store: SessionStore): Promise<void> {
  await store.putSession({ id: SESSION_ID, startedAt: AT });
  await store.putSet(partnerRow(READ_REPS));
}

async function expectPartnerKeptAndStamped(reader: SessionStore, closing: StoredSet) {
  const partner = await reader.getSet(PARTNER_ID);
  expect(partner?.reps).toHaveLength(PERSISTED_REPS);
  expect(partner?.lifter).toBe('Jordan');
  expect(closing.bilateralGroupId).toBeTruthy();
  expect(partner?.bilateralGroupId).toBe(closing.bilateralGroupId);
  expect(partner?.groupSource).toBe('live');
}

describe('partner group stamp racing a partner write (VW-583)', () => {
  it('keeps the partner reps and label written on the same connection', async () => {
    const store = openStore();
    await seed(store);

    const closing = await closePairedSet(stateOver(interleavedAtPartnerStamp(store, store)));

    await expectPartnerKeptAndStamped(store, closing);
  });

  it('keeps the partner reps and label written by a second connection', async () => {
    const [a, b] = [openStore(), openStore()];
    await seed(a);

    const closing = await closePairedSet(stateOver(interleavedAtPartnerStamp(a, b)));

    await expectPartnerKeptAndStamped(b, closing);
  });
});
