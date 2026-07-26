// Per-slot demux of the live SSE overlay (VW-48 P2 / VMCP-04.03).
//
// A bilateral session puts two Voltras on ONE stream, each payload stamped with
// its originating `slot`. These tests pin the property that makes that safe: every
// piece of interpolation state — anchor, last rep, peak force, commit throttle and
// the staleness clock — is per slot, so one arm's frames can never re-time or
// overwrite the other's readout.
//
// As in `spa-live-stream.test.ts`, `EventSource` and rAF are stubbed; here the rAF
// stub CAPTURES the tick so a test can step the interpolation loop deliberately.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiveStreamController, PRIMARY_SLOT, type LiveModel } from '../spa/live-stream.js';
import { dashboardStore } from '../spa/store.js';
import type { LivePhaseSignal, LiveRepSignal, LiveSetSignal } from '../../state/live-signal.js';

class MockEventSource {
  static instances: MockEventSource[] = [];
  private readonly listeners = new Map<string, (e: MessageEvent<string>) => void>();
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, fn);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void {}

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function phaseFrame(slot: string, over: Partial<LivePhaseSignal> = {}): LivePhaseSignal {
  return {
    slot,
    t: Date.now(),
    phase: 'con',
    phaseElapsedMs: 300,
    position: 120,
    velocity: 0.42,
    force: 480,
    repInProgress: 2,
    ...over,
  };
}

function repSignal(slot: string, peakForceSoFar: number, repIndex = 1): LiveRepSignal {
  return { slot, repIndex, vCon: 0.41, rom: 0.55, peakVelocity: 0.6, peakForceSoFar };
}

/** Captured rAF tick, so tests can advance the interpolation loop on demand. */
let pendingTick: (() => void) | null = null;

interface Emission {
  slot: string;
  model: LiveModel;
}

function start(): { seen: Emission[]; es: MockEventSource; dispose: () => void } {
  const seen: Emission[] = [];
  const dispose = createLiveStreamController((model, slot) => seen.push({ slot, model }));
  return { seen, es: MockEventSource.instances.at(-1)!, dispose };
}

/** The most recent model emitted for `slot`, or undefined if it never spoke. */
function latest(seen: Emission[], slot: string): LiveModel | undefined {
  return seen.filter((e) => e.slot === slot).at(-1)?.model;
}

beforeEach(() => {
  MockEventSource.instances = [];
  pendingTick = null;
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    pendingTick = cb;
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createLiveStreamController — slot demux (VW-48 P2)', () => {
  it('routes interleaved two-slot frames to independent models', () => {
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left', { velocity: 0.2, force: 100, repInProgress: 1 }));
    es.emit('phase', phaseFrame('right', { velocity: 0.9, force: 700, repInProgress: 3 }));
    es.emit('phase', phaseFrame('left', { velocity: 0.25, force: 110, repInProgress: 1 }));

    expect(latest(seen, 'left')).toMatchObject({ velocity: 0.25, force: 110, repInProgress: 1 });
    expect(latest(seen, 'right')).toMatchObject({ velocity: 0.9, force: 700, repInProgress: 3 });
    dispose();
  });

  it('keeps peak force and last rep per slot', () => {
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left'));
    es.emit('phase', phaseFrame('right'));
    es.emit('rep', repSignal('left', 185, 1));
    es.emit('rep', repSignal('right', 240, 4));

    expect(latest(seen, 'left')!.peakForce).toBe(185);
    expect(latest(seen, 'left')!.lastRep?.repIndex).toBe(1);
    expect(latest(seen, 'right')!.peakForce).toBe(240);
    expect(latest(seen, 'right')!.lastRep?.repIndex).toBe(4);
    dispose();
  });

  it('does not let one slot re-anchor the other slot phase clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left', { phaseElapsedMs: 300 }));
    // 400 ms later the right arm anchors fresh at 0 while left keeps accruing.
    vi.setSystemTime(1_400);
    es.emit('phase', phaseFrame('right', { phaseElapsedMs: 0 }));
    // Step the shared rAF loop past the commit throttle so both slots re-emit.
    vi.setSystemTime(1_500);
    pendingTick!();

    expect(latest(seen, 'left')!.phaseElapsedMs).toBe(300 + 500);
    expect(latest(seen, 'right')!.phaseElapsedMs).toBe(100);
    dispose();
  });

  it('ends a set on one slot without disturbing the other', () => {
    const { seen, es, dispose } = start();
    const ended: LiveSetSignal = { slot: 'left', kind: 'ended', setId: 's1', sessionId: 'x' };

    es.emit('phase', phaseFrame('left'));
    es.emit('phase', phaseFrame('right', { velocity: 0.9 }));
    es.emit('rep', repSignal('left', 185));
    es.emit('set', ended);
    // The left tempo bar stops (anchor cleared) but its final-rep readout stays,
    // and the right arm is untouched and still moving.
    es.emit('phase', phaseFrame('right', { velocity: 0.95 }));

    expect(latest(seen, 'left')!.peakForce).toBe(185);
    expect(latest(seen, 'right')!.velocity).toBe(0.95);
    dispose();
  });

  it('leaves a silent slot model frozen while the other streams', () => {
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left', { velocity: 0.2 }));
    const leftAtRest = latest(seen, 'left')!;
    for (let i = 0; i < 5; i++) {
      es.emit('phase', phaseFrame('right', { velocity: 0.5 + i / 10 }));
    }

    // The silent arm emitted nothing further, and its last model is untouched.
    expect(seen.filter((e) => e.slot === 'left')).toHaveLength(1);
    expect(latest(seen, 'left')).toBe(leftAtRest);
    expect(latest(seen, 'left')!.velocity).toBe(0.2);
    dispose();
  });

  it('admits a slot that first appears mid-session', () => {
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left'));
    es.emit('rep', repSignal('left', 185));
    expect(latest(seen, 'right')).toBeUndefined();

    // The second Voltra binds partway through and starts streaming.
    es.emit('phase', phaseFrame('right', { velocity: 0.7 }));

    expect(latest(seen, 'right')).toMatchObject({ velocity: 0.7, peakForce: 0, lastRep: null });
    // The incumbent slot's accumulated state survives the newcomer.
    expect(latest(seen, 'left')!.peakForce).toBe(185);
    dispose();
  });

  it('goes stale per slot: a quiet arm disconnects while the other stays live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left'));
    // Past the 3 s staleness window for left only; right speaks now.
    vi.setSystemTime(5_000);
    es.emit('phase', phaseFrame('right'));
    pendingTick!();

    expect(latest(seen, 'left')!.connected).toBe(false);
    expect(latest(seen, 'right')!.connected).toBe(true);
    dispose();
  });

  it('a heartbeat refreshes every slot — stream liveness is shared', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { seen, es, dispose } = start();

    es.emit('phase', phaseFrame('left'));
    es.emit('phase', phaseFrame('right'));
    vi.setSystemTime(5_000);
    es.emit('hb', {});
    pendingTick!();

    expect(latest(seen, 'left')!.connected).toBe(true);
    expect(latest(seen, 'right')!.connected).toBe(true);
    dispose();
  });

  it('falls back to the primary slot for payloads carrying no slot', () => {
    const { seen, es, dispose } = start();
    const legacy = { ...phaseFrame('ignored') } as Partial<LivePhaseSignal>;
    delete legacy.slot;

    es.emit('phase', legacy);

    expect(seen.at(-1)!.slot).toBe(PRIMARY_SLOT);
    dispose();
  });
});

describe('dashboardStore — liveBySlot', () => {
  beforeEach(() => {
    dashboardStore.getState().setLive(null, 'primary');
    dashboardStore.getState().setLive(null, 'left');
    dashboardStore.getState().setLive(null, 'right');
  });

  const model = (velocity: number): LiveModel => ({
    connected: true,
    phase: 'con',
    phaseElapsedMs: 100,
    velocity,
    position: 100,
    force: 200,
    repInProgress: 1,
    lastRep: null,
    peakForce: 0,
  });

  it('keys overlays by slot and keeps them independent', () => {
    dashboardStore.getState().setLive(model(0.3), 'left');
    dashboardStore.getState().setLive(model(0.8), 'right');

    const { liveBySlot } = dashboardStore.getState();
    expect(liveBySlot.left?.velocity).toBe(0.3);
    expect(liveBySlot.right?.velocity).toBe(0.8);
  });

  it('writes default to the primary slot and drive the derived `live` view', () => {
    dashboardStore.getState().setLive(model(0.5));

    expect(dashboardStore.getState().liveBySlot[PRIMARY_SLOT]?.velocity).toBe(0.5);
    expect(dashboardStore.getState().live?.velocity).toBe(0.5);
  });

  it('derives `live` from the first slot seen when there is no primary', () => {
    dashboardStore.getState().setLive(model(0.3), 'left');
    dashboardStore.getState().setLive(model(0.8), 'right');

    expect(dashboardStore.getState().live?.velocity).toBe(0.3);
  });

  it('prefers the primary slot over any other for `live`', () => {
    dashboardStore.getState().setLive(model(0.3), 'left');
    dashboardStore.getState().setLive(model(0.9), PRIMARY_SLOT);

    expect(dashboardStore.getState().live?.velocity).toBe(0.9);
  });

  it('clearing one slot leaves the other and re-derives `live`', () => {
    dashboardStore.getState().setLive(model(0.3), 'left');
    dashboardStore.getState().setLive(model(0.8), 'right');

    dashboardStore.getState().setLive(null, 'left');

    expect(dashboardStore.getState().liveBySlot.left).toBeUndefined();
    expect(dashboardStore.getState().live?.velocity).toBe(0.8);
  });

  it('clearing an unknown slot is a no-op that does not churn the slice', () => {
    dashboardStore.getState().setLive(model(0.3), 'left');
    const before = dashboardStore.getState().liveBySlot;

    dashboardStore.getState().setLive(null, 'right');

    expect(dashboardStore.getState().liveBySlot).toBe(before);
  });
});
