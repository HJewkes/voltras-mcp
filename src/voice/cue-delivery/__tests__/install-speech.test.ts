// Behind VMCP_CUE_DELIVERY, only one cue layer ever reaches the speaker.

import type * as ChildProcessModule from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelEvent, ChannelPublisher } from '../../../state/channel-publisher.js';
import { LiveState } from '../../../state/live-state.js';
import { openTestStore, type SessionStore } from '../../../store/__tests__/open-test-store.js';
import { makeCueSettings } from '../../cue-settings.js';
import { FOCUS_LINE_SOURCE } from '../delivery-emitter.js';
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

const SET_ID = 'set-speech';
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

let store: SessionStore;
let spokenSources: string[];

function silentPublisher(): ChannelPublisher {
  const publisher: ChannelPublisher = { publish: () => undefined, forSlot: () => publisher };
  return publisher;
}

function install(cueDelivery: 'off' | 'on'): ChannelPublisher {
  const state = {
    config: { cueDelivery },
    store,
    slots: new Map([['primary', { live: new LiveState() }]]),
  };
  return installCueLayer(silentPublisher(), state, {
    settings: makeCueSettings({ cues: 'on', cuesMidSet: 'on' }),
    voiceListenerRef: null,
    coachLine: (line) => spokenSources.push(line.source),
    platform: 'darwin',
  });
}

/**
 * One set: its start, two reps, then a third rep on which the rep target and the slowdown
 * both fire. The legacy tee speaks every category once; the delivery layer speaks one line
 * per moment and ranks slowdown first, so the two layers say different things.
 */
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
  // The legacy tee reads the host platform itself, so pin it for both layers alike.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  store = openTestStore();
  spokenSources = [];
  spawned.lines = [];
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  await store.close();
});

describe('installCueLayer speech', () => {
  it('flag off: only the legacy tee speaks, every category once', async () => {
    // Arrange
    const tee = install('off');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro', 'target_hit', 'slowdown']);
    expect(spokenSources).not.toContain(FOCUS_LINE_SOURCE);
    expect(spawned.lines).toHaveLength(3);
  });

  it('flag on: only the delivery layer speaks, one line per moment, and the legacy tee never does', async () => {
    // Arrange
    const tee = install('on');

    // Act
    await liftOneSet(tee);

    // Assert
    expect(spokenSources).toEqual(['set_intro', 'slowdown']);
    expect(spawned.lines).toHaveLength(2);
  });
});
