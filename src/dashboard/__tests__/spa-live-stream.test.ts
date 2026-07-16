// Unit tests for the SSE live-overlay controller (VMCP-01.59), focused on the
// VW-45 set-level peak-concentric-force field: it climbs as reps land, survives
// interim live frames, and resets to 0 when the set ends.
//
// The controller talks to `EventSource` + `requestAnimationFrame`, neither of
// which exists in the node test env, so a minimal `MockEventSource` captures the
// per-event handlers and lets a test dispatch signal frames; rAF is stubbed to a
// no-op so the interpolation loop never runs (every handler force-commits).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiveStreamController, type LiveModel } from '../spa/live-stream.js';
import type { LivePhaseSignal, LiveRepSignal, LiveSetSignal } from '../../state/live-signal.js';

/** A single captured-handler EventSource stand-in (one listener per event type). */
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

  /** Dispatch a named SSE event carrying `data` as its JSON payload. */
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function phaseFrame(): LivePhaseSignal {
  return {
    t: Date.now(),
    phase: 'con',
    phaseElapsedMs: 300,
    position: 120,
    velocity: 0.42,
    force: 480,
    repInProgress: 2,
  };
}

function repSignal(peakForceSoFar: number): LiveRepSignal {
  return { repIndex: 1, vCon: 0.41, rom: 0.55, peakVelocity: 0.6, peakForceSoFar };
}

const setEnded: LiveSetSignal = { kind: 'ended', setId: 's1', sessionId: 'sess1' };

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLiveStreamController — live.peakForce (VW-45)', () => {
  function start(): { models: LiveModel[]; es: MockEventSource; dispose: () => void } {
    const models: LiveModel[] = [];
    const dispose = createLiveStreamController((m) => models.push(m));
    const es = MockEventSource.instances.at(-1)!;
    return { models, es, dispose };
  }

  it('surfaces the peak force and updates it as later reps land', () => {
    const { models, es, dispose } = start();
    es.emit('phase', phaseFrame()); // anchor the stream
    es.emit('rep', repSignal(120));
    expect(models.at(-1)!.peakForce).toBe(120);
    es.emit('rep', repSignal(185));
    expect(models.at(-1)!.peakForce).toBe(185);
    dispose();
  });

  it('keeps the peak across interim live frames within a set', () => {
    const { models, es, dispose } = start();
    es.emit('phase', phaseFrame());
    es.emit('rep', repSignal(185));
    // A live phase frame between reps must not wipe the standing peak.
    es.emit('phase', phaseFrame());
    expect(models.at(-1)!.peakForce).toBe(185);
    dispose();
  });

  it('resets the peak to 0 when the set ends', () => {
    const { models, es, dispose } = start();
    es.emit('phase', phaseFrame());
    es.emit('rep', repSignal(185));
    expect(models.at(-1)!.peakForce).toBe(185);
    es.emit('set', setEnded);
    // The next set's first frame re-anchors; the peak now reads 0 until a rep lands.
    es.emit('phase', phaseFrame());
    expect(models.at(-1)!.peakForce).toBe(0);
    dispose();
  });
});
