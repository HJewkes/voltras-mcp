// Under VMCP_CUES_MIDSET=risk, an intra-set line reaches the speaker only on a green set (VW-614).

import type * as ChildProcessModule from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RiskBand, SetRiskReading } from '../../../analytics/set-risk.js';
import type { ChannelEvent, ChannelPublisher } from '../../../state/channel-publisher.js';
import { LiveState } from '../../../state/live-state.js';
import { openTestStore, type SessionStore } from '../../../store/__tests__/open-test-store.js';
import { makeCueSettings } from '../../cue-settings.js';
import { installCueLayer } from '../install.js';
import { reps, slowdown, started, targetReached } from './delivery-fixtures.js';

const spawned = vi.hoisted(() => ({ lines: [] as string[] }));

// A `say` stand-in that records the line and exits at once, so the speech queue keeps moving.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (_command: string, args: readonly string[]) => {
      spawned.lines.push(args[args.length - 1] ?? '');
      const child = Object.assign(new EventEmitter(), { kill: () => true });
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
  };
});

const SET_ID = 'set-risk';
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

let store: SessionStore;
let live: LiveState;
let spokenSources: string[];

function reading(band: RiskBand): SetRiskReading {
  return {
    band,
    points: band === 'green' ? 0 : 6,
    factors: { exercise: 0, intensity: 0, load: 0, fatigue: 0 },
    vetoes: band === 'red' ? ['heavy_loaded_compound'] : [],
    permitsIntraSet: band === 'green',
  };
}

function liveWithActiveSet(): LiveState {
  const state = new LiveState();
  state.startSession({
    sessionId: 'sess-risk',
    startedAt: '2026-01-01T00:00:00.000Z',
    exerciseId: 'row',
    setIds: [],
    status: 'active',
  });
  state.startSet({
    setId: SET_ID,
    sessionId: 'sess-risk',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
    exerciseId: 'row',
  });
  return state;
}

function silentPublisher(): ChannelPublisher {
  const publisher: ChannelPublisher = { publish: () => undefined, forSlot: () => publisher };
  return publisher;
}

function install(cueDelivery: 'off' | 'on'): ChannelPublisher {
  const state = { config: { cueDelivery }, store, slots: new Map([['primary', { live }]]) };
  return installCueLayer(silentPublisher(), state, {
    settings: makeCueSettings({ cues: 'on', cuesMidSet: 'risk' }),
    voiceListenerRef: null,
    coachLine: (line) => spokenSources.push(line.source),
    platform: 'darwin',
  });
}

/** The set's start, two reps, then a third on which the rep target and the slowdown both fire. */
async function liftOneSet(tee: ChannelPublisher): Promise<void> {
  for (const event of [started(SET_ID), ...reps(SET_ID, 2)]) {
    tee.publish(event);
    await settle();
  }
  const sameRep: ChannelEvent[] = [
    ...reps(SET_ID, 1, 3),
    targetReached(SET_ID, 3),
    slowdown(SET_ID, 3),
  ];
  for (const event of sameRep) tee.publish(event);
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  store = openTestStore();
  live = liveWithActiveSet();
  spokenSources = [];
  spawned.lines = [];
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  await store.close();
});

describe('VMCP_CUES_MIDSET=risk through the cue-delivery layer', () => {
  it('speaks an intra-set line on a set pinned green', async () => {
    // Arrange
    live.attachSetRiskReading(SET_ID, reading('green'));
    const tee = install('on');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro', 'slowdown']);
  });

  it('speaks no intra-set line on a set pinned red', async () => {
    // Arrange
    live.attachSetRiskReading(SET_ID, reading('red'));
    const tee = install('on');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro']);
  });

  it('speaks no intra-set line when the set has no reading pinned', async () => {
    // Arrange
    const tee = install('on');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro']);
  });

  it('leaves the legacy tee silent mid-set even on a green set', async () => {
    // Arrange
    live.attachSetRiskReading(SET_ID, reading('green'));
    const tee = install('off');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro']);
  });
});
