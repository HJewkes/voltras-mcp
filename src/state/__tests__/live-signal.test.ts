// Unit tests for the VMCP-01.59 Phase 0 live-signal derivation.
//
// Drives synthetic frame sequences (con → hold → ecc → idle) through the phase
// clock + emitter and asserts the derived schema: phaseElapsedMs rises
// monotonically within a phase and resets to 0 on each flip, flips fire ahead
// of / distinctly from phase frames, and the ~20 Hz throttle drops sub-50 ms
// phase frames while never dropping a flip.

import { describe, expect, it } from 'vitest';

import {
  LiveSignalEmitter,
  LiveSignalHub,
  PhaseClock,
  mapPhase,
  mmToM,
  mmsToMps,
  type LiveFrameInput,
  type LiveSignalEvent,
} from '../live-signal.js';

function frame(overrides: Partial<LiveFrameInput> & { t: number }): LiveFrameInput {
  return {
    phase: 'con',
    position: 0,
    velocity: 0,
    force: 0,
    repInProgress: null,
    ...overrides,
  };
}

describe('mapPhase', () => {
  it('maps the numeric phase indices onto fitness labels', () => {
    expect(mapPhase(0)).toBe('idle');
    expect(mapPhase(1)).toBe('con');
    expect(mapPhase(2)).toBe('hold');
    expect(mapPhase(3)).toBe('ecc');
  });

  it('collapses the UNKNOWN sentinel and anything unrecognised to idle', () => {
    expect(mapPhase(-1)).toBe('idle');
    expect(mapPhase(99)).toBe('idle');
  });
});

describe('unit conversions', () => {
  it('converts mm/s to m/s preserving mm granularity', () => {
    expect(mmsToMps(480)).toBe(0.48);
    expect(mmsToMps(1234)).toBe(1.234);
  });

  it('converts mm ROM to m', () => {
    expect(mmToM(520)).toBe(0.52);
  });
});

describe('PhaseClock', () => {
  it('seeds on the first frame without emitting a flip', () => {
    const clock = new PhaseClock();
    const { phase, flip } = clock.advance(frame({ t: 1000, phase: 'con' }));
    expect(flip).toBeNull();
    expect(phase.phaseElapsedMs).toBe(0);
    expect(phase.phase).toBe('con');
  });

  it('accumulates phaseElapsedMs monotonically within a phase', () => {
    const clock = new PhaseClock();
    clock.advance(frame({ t: 1000, phase: 'con' }));
    expect(clock.advance(frame({ t: 1090, phase: 'con' })).phase.phaseElapsedMs).toBe(90);
    expect(clock.advance(frame({ t: 1180, phase: 'con' })).phase.phaseElapsedMs).toBe(180);
  });

  it('flips and resets the phase clock to 0 the instant the phase changes', () => {
    const clock = new PhaseClock();
    clock.advance(frame({ t: 1000, phase: 'con', repInProgress: 5 }));
    clock.advance(frame({ t: 1180, phase: 'con', repInProgress: 5 }));
    const { phase, flip } = clock.advance(frame({ t: 1200, phase: 'hold', repInProgress: 5 }));
    expect(flip).toEqual({ t: 1200, from: 'con', to: 'hold', repIndex: 5 });
    expect(phase.phaseElapsedMs).toBe(0);
  });

  it('carries the instantaneous fitness values through untouched', () => {
    const clock = new PhaseClock();
    const { phase } = clock.advance(
      frame({ t: 1000, phase: 'con', position: 312, velocity: 0.48, force: 74, repInProgress: 3 }),
    );
    expect(phase).toMatchObject({ position: 312, velocity: 0.48, force: 74, repInProgress: 3 });
  });
});

describe('LiveSignalEmitter', () => {
  function collect(): { hub: LiveSignalHub; events: LiveSignalEvent[] } {
    const hub = new LiveSignalHub();
    const events: LiveSignalEvent[] = [];
    hub.subscribe((e) => events.push(e));
    return { hub, events };
  }

  it('emits a phase frame per sample through a full con→hold→ecc→idle rep', () => {
    const { hub, events } = collect();
    const emitter = new LiveSignalEmitter(hub);
    // 90 ms cadence keeps each frame above the 50 ms throttle floor.
    emitter.frame(frame({ t: 0, phase: 'con', repInProgress: 1 }));
    emitter.frame(frame({ t: 90, phase: 'con', repInProgress: 1 }));
    emitter.frame(frame({ t: 180, phase: 'hold', repInProgress: 1 }));
    emitter.frame(frame({ t: 270, phase: 'ecc', repInProgress: 1 }));
    emitter.frame(frame({ t: 360, phase: 'idle', repInProgress: 1 }));

    const flips = events.filter((e) => e.type === 'phaseflip');
    const phases = events.filter((e) => e.type === 'phase');
    expect(phases).toHaveLength(5);
    // Three flips: con→hold, hold→ecc, ecc→idle (the first frame seeds, no flip).
    expect(flips.map((e) => e.type === 'phaseflip' && `${e.data.from}->${e.data.to}`)).toEqual([
      'con->hold',
      'hold->ecc',
      'ecc->idle',
    ]);
  });

  it('never drops a flip even when the phase frame is throttled', () => {
    const { hub, events } = collect();
    const emitter = new LiveSignalEmitter(hub);
    emitter.frame(frame({ t: 0, phase: 'con' })); // seeds + emits phase
    // 20 ms later (< 50 ms floor) the phase flips: phase frame throttled, but
    // the flip MUST still fire so the client can snap immediately.
    emitter.frame(frame({ t: 20, phase: 'hold' }));

    expect(events.map((e) => e.type)).toEqual(['phase', 'phaseflip']);
  });

  it('drops sub-50 ms phase frames as a safety cap but keeps native cadence', () => {
    const { hub, events } = collect();
    const emitter = new LiveSignalEmitter(hub);
    emitter.frame(frame({ t: 0, phase: 'con' }));
    emitter.frame(frame({ t: 20, phase: 'con' })); // throttled (20 ms gap)
    emitter.frame(frame({ t: 40, phase: 'con' })); // throttled (40 ms gap)
    emitter.frame(frame({ t: 90, phase: 'con' })); // 90 ms since last emit → passes

    expect(events.filter((e) => e.type === 'phase')).toHaveLength(2);
  });

  it('fans rep + set lifecycle echoes through the hub', () => {
    const { hub, events } = collect();
    const emitter = new LiveSignalEmitter(hub);
    emitter.set({ kind: 'started', setId: 's1', sessionId: 'sess1' });
    emitter.rep({ repIndex: 4, vCon: 0.41, rom: 0.52, peakVelocity: 0.63, peakForceSoFar: 205 });

    expect(events).toEqual([
      { type: 'set', data: { kind: 'started', setId: 's1', sessionId: 'sess1' } },
      {
        type: 'rep',
        data: { repIndex: 4, vCon: 0.41, rom: 0.52, peakVelocity: 0.63, peakForceSoFar: 205 },
      },
    ]);
  });
});

describe('LiveSignalHub', () => {
  it('isolates a throwing subscriber from its peers', () => {
    const hub = new LiveSignalHub();
    const seen: string[] = [];
    hub.subscribe(() => {
      throw new Error('bad consumer');
    });
    hub.subscribe((e) => seen.push(e.type));
    hub.emit({ type: 'set', data: { kind: 'started', setId: 's', sessionId: 'z' } });
    hub.emit({ type: 'set', data: { kind: 'ended', setId: 's', sessionId: 'z' } });
    expect(seen).toEqual(['set', 'set']);
  });

  it('stops delivering after unsubscribe and tracks the subscriber count', () => {
    const hub = new LiveSignalHub();
    const seen: LiveSignalEvent[] = [];
    const off = hub.subscribe((e) => seen.push(e));
    expect(hub.subscriberCount).toBe(1);
    off();
    expect(hub.subscriberCount).toBe(0);
    hub.emit({ type: 'set', data: { kind: 'ended', setId: 's', sessionId: 'z' } });
    expect(seen).toHaveLength(0);
  });
});
