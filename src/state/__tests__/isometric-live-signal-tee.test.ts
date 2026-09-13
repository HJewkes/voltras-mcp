// Unit tests for the isometric_phase (VW-198) / isometric_result (VW-264)
// → live-signal tee.

import { describe, expect, it } from 'vitest';

import type { ChannelEvent, ChannelPublisher } from '../channel-publisher.js';
import { buildIsometricPhasePayload, buildIsometricResultPayload } from '../channel-payloads.js';
import { installIsometricLiveTee } from '../isometric-live-signal-tee.js';
import { LiveSignalHub, type LiveSignalEvent } from '../live-signal.js';

function isometricPhaseEvent(
  input: Parameters<typeof buildIsometricPhasePayload>[0],
  extraMeta: Record<string, string> = {},
): ChannelEvent {
  const { meta, content } = buildIsometricPhasePayload(input);
  return { meta: { ...meta, ...extraMeta }, content };
}

function fakePublisher(): { publisher: ChannelPublisher; published: ChannelEvent[] } {
  const published: ChannelEvent[] = [];
  function forSlot(slotId: string): ChannelPublisher {
    return {
      publish: (event) => published.push({ ...event, meta: { slot: slotId, ...event.meta } }),
      forSlot,
    };
  }
  const publisher: ChannelPublisher = { publish: (event) => published.push(event), forSlot };
  return { publisher, published };
}

function collectEmitted(hub: LiveSignalHub): LiveSignalEvent[] {
  const emitted: LiveSignalEvent[] = [];
  hub.subscribe((e) => emitted.push(e));
  return emitted;
}

describe('installIsometricLiveTee', () => {
  it('returns the inner publisher unchanged when no hub is wired', () => {
    const { publisher } = fakePublisher();
    expect(installIsometricLiveTee(publisher, undefined)).toBe(publisher);
  });

  it('always forwards to the inner publisher, byte-identical', () => {
    const { publisher, published } = fakePublisher();
    const hub = new LiveSignalHub();
    const tee = installIsometricLiveTee(publisher, hub);
    const event = isometricPhaseEvent({ phase: 'go', trial: 1, holdMs: 5000 }, { slot: 'primary' });
    tee.publish(event);
    expect(published).toEqual([event]);
  });

  it('decodes an isometric_phase event into an isometric live-signal', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish(
      isometricPhaseEvent(
        { phase: 'hold', trial: 2, holdMs: 5000, side: 'left' },
        { slot: 'left' },
      ),
    );
    expect(emitted).toEqual([
      {
        type: 'isometric',
        data: { slot: 'left', phase: 'hold', trial: 2, holdMs: 5000, side: 'left' },
      },
    ]);
  });

  it('defaults slot to primary and side to null when absent', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish(isometricPhaseEvent({ phase: 'ready', trial: 1, holdMs: 5000 }));
    expect(emitted).toEqual([
      {
        type: 'isometric',
        data: { slot: 'primary', phase: 'ready', trial: 1, holdMs: 5000, side: null },
      },
    ]);
  });

  it('ignores every other channel event type', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish({ meta: { event_type: 'set_started', slot: 'primary' }, content: '{}' });
    expect(emitted).toEqual([]);
  });

  it('ignores a malformed isometric_phase event (bad phase / non-numeric trial)', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish({
      meta: { event_type: 'isometric_phase', phase: 'bogus', trial: '1', hold_ms: '5000' },
      content: '{}',
    });
    tee.publish({
      meta: { event_type: 'isometric_phase', phase: 'go', trial: 'nope', hold_ms: '5000' },
      content: '{}',
    });
    expect(emitted).toEqual([]);
  });

  it('forSlot rebases both the passthrough and the tee onto the new slot', () => {
    const { publisher, published } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub).forSlot('right');
    const { meta, content } = buildIsometricPhasePayload({ phase: 'go', trial: 1, holdMs: 5000 });
    tee.publish({ meta, content });
    expect(published[0]?.meta.slot).toBe('right');
    expect(emitted).toEqual([
      {
        type: 'isometric',
        data: { slot: 'right', phase: 'go', trial: 1, holdMs: 5000, side: null },
      },
    ]);
  });

  it('a throwing hub listener does not break passthrough delivery', () => {
    const { publisher, published } = fakePublisher();
    const hub = new LiveSignalHub();
    hub.subscribe(() => {
      throw new Error('boom');
    });
    const tee = installIsometricLiveTee(publisher, hub);
    expect(() =>
      tee.publish(
        isometricPhaseEvent({ phase: 'stop', trial: 1, holdMs: 5000 }, { slot: 'primary' }),
      ),
    ).not.toThrow();
    expect(published).toHaveLength(1);
  });
});

describe('installIsometricLiveTee — isometric_result (VW-264)', () => {
  const RESULT_INPUT: Parameters<typeof buildIsometricResultPayload>[0] = {
    tool: 'isometric.measure_imbalance',
    sides: [
      { side: 'left', slot: 'left', peakForceLbs: 180.44 },
      { side: 'right', slot: 'right', peakForceLbs: 151.2 },
    ],
    asymmetryPct: 16.1789,
    verdict: 'meaningful',
    reason: 'Asymmetry 16.2% exceeds this athlete’s own intra-limb CV.',
    occurredAt: 1_700_000_000_000,
  };

  it('decodes a result event into an isometric_result live-signal, rounded to one place', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish(buildIsometricResultPayload(RESULT_INPUT));
    expect(emitted).toEqual([
      {
        type: 'isometric_result',
        data: {
          tool: 'isometric.measure_imbalance',
          sides: [
            { side: 'left', slot: 'left', peakForceLbs: 180.4 },
            { side: 'right', slot: 'right', peakForceLbs: 151.2 },
          ],
          asymmetryPct: 16.2,
          verdict: 'meaningful',
          reason: RESULT_INPUT.reason,
          comparability: null,
          setupReason: null,
          occurredAt: 1_700_000_000_000,
        },
      },
    ]);
  });

  it('carries the setup gate through untouched when the assessment reports one', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish(
      buildIsometricResultPayload({
        ...RESULT_INPUT,
        verdict: null,
        comparability: 'setup_confounded',
        setupReason: 'cable travel differs between the sides',
      }),
    );
    const [event] = emitted;
    expect(event?.type).toBe('isometric_result');
    expect(event?.type === 'isometric_result' && event.data.comparability).toBe('setup_confounded');
    expect(event?.type === 'isometric_result' && event.data.setupReason).toBe(
      'cable travel differs between the sides',
    );
  });

  it('ignores a result event whose content is not parseable', () => {
    const { publisher } = fakePublisher();
    const hub = new LiveSignalHub();
    const emitted = collectEmitted(hub);
    const tee = installIsometricLiveTee(publisher, hub);
    tee.publish({ meta: { event_type: 'isometric_result' }, content: 'not json' });
    tee.publish({ meta: { event_type: 'isometric_result' }, content: '{"isometric_result":{}}' });
    expect(emitted).toEqual([]);
  });
});
