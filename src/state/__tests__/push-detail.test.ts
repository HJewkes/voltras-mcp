// VW-832: compact `rep_finalized` / `set_ended` at the client channel, and
// `VMCP_PUSH_DETAIL=full` as an untouched passthrough.

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import { buildRepFinalizedPayload, buildSetEndedPayload } from '../channel-payloads.js';
import type { ChannelEvent, ChannelPublisher } from '../channel-publisher.js';
import type { ActiveSet, DeviceSnapshot } from '../live-state.js';
import { compactChannelEvent, installPushDetail, REP_TABLE_COLUMNS } from '../push-detail.js';
import type { StoredSet } from '../../store/types.js';

const SET_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function phase(peakMps: number, startTime: number, startPos: number, endPos: number) {
  const samples: Rep['concentric']['samples'] = [0, 1, 2, 3, 4, 5].map((i) => ({
    sequence: i,
    timestamp: startTime + i * 70,
    phase: 1 as Rep['concentric']['samples'][number]['phase'],
    position: startPos + ((endPos - startPos) * i) / 5,
    velocity: peakMps * (0.5 + i / 12),
    force: 120 + i * 7,
  }));
  return {
    samples,
    startTime,
    endTime: startTime + 437,
    startPosition: startPos,
    endPosition: endPos,
    _totalVelocity: peakMps * 4.123,
    _totalForce: 812.37,
    _totalLoad: 0,
    _movementSampleCount: samples.length,
    _totalHoldDuration: 23,
    _peakVelocityTime: startTime + 211,
    _lastMovementVelocity: peakMps * 0.613,
    peakVelocity: peakMps,
    peakForce: 162.4,
    peakLoad: 0,
  };
}

function rep(repNumber: number, concPeak: number): Rep {
  const start = repNumber * 2000;
  return {
    repNumber,
    concentric: phase(concPeak, start, 0.0123, 0.6871),
    eccentric: phase(concPeak * 1.137, start + 900, 0.6871, 0.0119),
  };
}

const device: DeviceSnapshot = { connected: true, weightLbs: 135, trainingMode: 'WeightTraining' };
const activeSet: ActiveSet = {
  setId: SET_ID,
  sessionId: SESSION_ID,
  startedAt: '2026-01-05T10:00:00.000Z',
  reps: [],
  status: 'active',
};

function eightRepSet(): StoredSet {
  return {
    id: SET_ID,
    sessionId: SESSION_ID,
    startedAt: '2026-01-05T10:00:00.000Z',
    endedAt: '2026-01-05T10:00:41.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 135,
    reps: [0.912, 0.887, 0.871, 0.853, 0.826, 0.801, 0.774, 0.731].map((peak, i) => ({
      ...rep(i + 1, peak),
      id: `rep-${i + 1}`,
      setId: SET_ID,
      index: i,
    })),
  };
}

/** An eight-rep set the device closed; `deviceCount` other than 8 makes the counts disagree. */
function deviceClosedSetEnded(deviceCount = 8): ChannelEvent {
  return buildSetEndedPayload(
    eightRepSet(),
    'device_signal',
    undefined,
    {
      repCount: deviceCount,
      totalPullMovingTimeMs: 18234,
      targetWeightTenths: 1350,
      schemaVersion: 2,
    },
    8,
  );
}

function recordingPublisher(): ChannelPublisher & { events: ChannelEvent[] } {
  const events: ChannelEvent[] = [];
  const publisher = {
    events,
    publish: (event: ChannelEvent) => void events.push(event),
    forSlot: (slotId: string): ChannelPublisher => ({
      publish: (event) => void events.push({ ...event, meta: { slot: slotId, ...event.meta } }),
      forSlot: () => publisher,
    }),
  };
  return publisher;
}

describe('compact rep_finalized', () => {
  it('keeps the meta attributes, the summary line and peak force, and fits in 320 characters', () => {
    const full = buildRepFinalizedPayload(rep(3, 0.871), 2, activeSet, device, 4);
    const fullContent = JSON.parse(full.content);

    const compact = compactChannelEvent(full);

    expect(compact.meta).toBe(full.meta);
    expect(fullContent.rep.peak_force).toBeGreaterThan(0);
    expect(JSON.parse(compact.content)).toEqual({
      summary: fullContent.summary,
      peak_force: fullContent.rep.peak_force,
    });
    expect(compact.content.length).toBeLessThanOrEqual(320);
  });
});

describe('compact set_ended', () => {
  it('fits an eight-rep device-closed set in 1,000 characters', () => {
    const compact = compactChannelEvent(deviceClosedSetEnded());

    expect(compact.content.length).toBeLessThanOrEqual(1000);
  });

  it('replaces the per-rep objects with one table row per rep', () => {
    const full = JSON.parse(deviceClosedSetEnded().content);

    const compact = JSON.parse(compactChannelEvent(deviceClosedSetEnded()).content);

    expect(compact.reps).toBeUndefined();
    expect(compact.rep_table.columns).toEqual([...REP_TABLE_COLUMNS]);
    expect(compact.rep_table.rows).toHaveLength(8);
    const first = full.reps[0];
    expect(compact.rep_table.rows[0]).toEqual([
      first.rep_number,
      first.concentric.peak_velocity,
      first.concentric.mean_velocity,
      first.eccentric.peak_velocity,
      Number(first.rom_m.toFixed(3)),
      first.tempo_ratio,
    ]);
  });

  it('drops training_mode, the null active_mode and the ids the meta carries from the set block', () => {
    const full = JSON.parse(deviceClosedSetEnded().content);

    const event = compactChannelEvent(deviceClosedSetEnded());
    const compact = JSON.parse(event.content);

    expect(event.meta).toMatchObject({ set_id: SET_ID, session_id: SESSION_ID });
    expect(Object.keys(compact.set)).toEqual(
      Object.keys(full.set).filter(
        (key) => !['set_id', 'session_id', 'training_mode', 'active_mode'].includes(key),
      ),
    );
    expect(compact.set).toMatchObject({ closed_by: 'device', partial_reason: null });
  });

  it('keeps the summary first and every other block as the builder wrote it', () => {
    const full = JSON.parse(deviceClosedSetEnded(7).content);

    const compact = JSON.parse(compactChannelEvent(deviceClosedSetEnded(7)).content);

    expect(Object.keys(compact)[0]).toBe('summary');
    expect(compact.summary).toBe(full.summary);
    expect(compact.vbt_summary).toEqual(full.vbt_summary);
    expect(compact.rep_count_disagreement).toBeDefined();
    expect(compact.rep_count_disagreement).toEqual(full.rep_count_disagreement);
    expect(compact.device_set_summary).toEqual(full.device_set_summary);
  });
});

describe('installPushDetail', () => {
  it('returns the connection publisher itself under full detail', () => {
    const transport = recordingPublisher();

    expect(installPushDetail(transport, 'full')).toBe(transport);
  });

  it('delivers every builder payload unchanged under full detail', () => {
    const transport = recordingPublisher();
    const events = [
      buildRepFinalizedPayload(rep(1, 0.912), 0, activeSet, device, 2),
      deviceClosedSetEnded(),
    ];

    const publisher = installPushDetail(transport, 'full');
    for (const event of events) publisher.publish(event);

    expect(transport.events).toEqual(events);
    expect(transport.events.map((event) => event.content)).toEqual(
      events.map((event) => event.content),
    );
  });

  it('compacts slot-scoped publishes and keeps the slot attribute', () => {
    const transport = recordingPublisher();

    installPushDetail(transport, 'compact')
      .forSlot('left')
      .publish(buildRepFinalizedPayload(rep(2, 0.887), 1, activeSet, device, 3));

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].meta.slot).toBe('left');
    expect(Object.keys(JSON.parse(transport.events[0].content))).toEqual(['summary', 'peak_force']);
  });

  it('leaves events it has no compact form for untouched', () => {
    const transport = recordingPublisher();
    const other: ChannelEvent = {
      meta: { source: 'voltras', event_type: 'set_started' },
      content: '{"summary":"Set started"}',
    };

    installPushDetail(transport, 'compact').publish(other);

    expect(transport.events).toEqual([other]);
  });

  it('lets a tee installed above it see the full payload while the client gets the compact one', () => {
    const transport = recordingPublisher();
    const teed: ChannelEvent[] = [];
    const compact = installPushDetail(transport, 'compact');
    const tee: ChannelPublisher = {
      publish: (event) => {
        compact.publish(event);
        teed.push(event);
      },
      forSlot: () => tee,
    };
    const full = deviceClosedSetEnded();

    tee.publish(full);

    expect(teed[0].content).toBe(full.content);
    expect(transport.events[0].content.length).toBeLessThan(full.content.length);
  });
});
