// Unit tests for the channel-payload builders.
//
// These helpers are the single source of truth for what PT Claude sees on
// each channel event, so the assertions here pin every load-bearing field
// in `meta` (XML attributes) and `content` (JSON body) for the three
// lifecycle events: rep_finalized, set_started, set_ended.
//
// The SDK is not pulled in — channel-payloads.ts depends only on
// `@voltras/workout-analytics` types and our own ActiveSet/StoredSet/
// DeviceSnapshot shapes, so tests run fast and don't need any vi.mock.

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import {
  buildConnectionChangedPayload,
  buildRepFinalizedPayload,
  buildSetEndedPayload,
  buildSetStartedPayload,
  meanConcentricPeakVelocity,
  summarizePreviousSet,
} from '../channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from '../live-state.js';
import type { StoredSet } from '../../store/types.js';

function makePhase(
  overrides: Partial<{
    samples: number;
    peakVelocity: number;
    totalVelocity: number;
    movementSampleCount: number;
    startTime: number;
    endTime: number;
    holdMs: number;
    startPos: number;
    endPos: number;
  }>,
): Rep['concentric'] {
  const samples = overrides.samples ?? 0;
  const sampleArr: Rep['concentric']['samples'] = [];
  for (let i = 0; i < samples; i++) {
    sampleArr.push({
      sequence: i,
      timestamp: (overrides.startTime ?? 0) + i * 50,
      phase: 1 as Rep['concentric']['samples'][number]['phase'],
      position: 0,
      velocity: 0,
      force: 0,
    });
  }
  return {
    samples: sampleArr,
    startTime: overrides.startTime ?? 0,
    endTime: overrides.endTime ?? 0,
    startPosition: overrides.startPos ?? 0,
    endPosition: overrides.endPos ?? 0,
    _totalVelocity: overrides.totalVelocity ?? 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: overrides.movementSampleCount ?? 0,
    _totalHoldDuration: overrides.holdMs ?? 0,
    peakVelocity: overrides.peakVelocity ?? 0,
    peakForce: 0,
    peakLoad: 0,
  };
}

function makeRep(repNumber: number, concPeak: number, eccPeak: number): Rep {
  return {
    repNumber,
    concentric: makePhase({
      samples: 4,
      peakVelocity: concPeak,
      totalVelocity: concPeak * 4,
      movementSampleCount: 4,
      startTime: 1000,
      endTime: 1400,
      startPos: 0.0,
      endPos: 0.6,
    }),
    eccentric: makePhase({
      samples: 4,
      peakVelocity: eccPeak,
      totalVelocity: eccPeak * 4,
      movementSampleCount: 4,
      startTime: 1400,
      endTime: 1900,
      startPos: 0.6,
      endPos: 0.0,
    }),
  };
}

describe('buildRepFinalizedPayload', () => {
  const set: ActiveSet = {
    setId: 'set-abc',
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
  };
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 135,
    trainingMode: 'WeightTraining',
  };

  it('emits meta with source/event_type/set_id/rep_count + scalar peak velocities and weight', () => {
    const rep = makeRep(1, 0.85, 0.62);
    const { meta } = buildRepFinalizedPayload(rep, 0, set, device, 2);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'rep_finalized',
      set_id: 'set-abc',
      rep_count: '1',
      peak_concentric_velocity: '0.850',
      peak_eccentric_velocity: '0.620',
      weight_lbs: '135',
    });
  });

  it('omits peak velocity meta keys when the underlying values are zero', () => {
    const rep = makeRep(1, 0, 0);
    const { meta } = buildRepFinalizedPayload(rep, 0, set, device, 2);
    expect(meta.peak_concentric_velocity).toBeUndefined();
    expect(meta.peak_eccentric_velocity).toBeUndefined();
  });

  it('omits weight_lbs meta when the device has no recorded weight', () => {
    const rep = makeRep(1, 0.5, 0.4);
    const noWeight: DeviceSnapshot = { connected: true };
    const { meta } = buildRepFinalizedPayload(rep, 0, set, noWeight, 2);
    expect(meta.weight_lbs).toBeUndefined();
  });

  it('emits content as JSON with summary first + rep phase data + set_context', () => {
    const rep = makeRep(2, 0.71, 0.55);
    const { content } = buildRepFinalizedPayload(rep, 1, set, device, 3);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Rep 2: 0.71 m/s peak conc, 135 lbs');
    expect(parsed.rep.rep_number).toBe(2);
    expect(parsed.rep.concentric).toEqual({
      peak_velocity: 0.71,
      mean_velocity: 0.71,
      duration_ms: 400,
    });
    expect(parsed.rep.eccentric).toEqual({
      peak_velocity: 0.55,
      mean_velocity: 0.55,
      duration_ms: 500,
    });
    expect(parsed.rep.peak_force).toBe(0);
    expect(parsed.rep.rom_m).toBeCloseTo(0.6, 3);
    expect(parsed.set_context).toEqual({
      weight_lbs: 135,
      training_mode: 'WeightTraining',
      rep_count_so_far: 2,
    });
  });

  it('uses a weight-less summary when device weight is unknown', () => {
    const rep = makeRep(1, 0.5, 0.4);
    const noWeight: DeviceSnapshot = { connected: true };
    const { content } = buildRepFinalizedPayload(rep, 0, set, noWeight, 2);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Rep 1: 0.50 m/s peak conc');
    expect(parsed.set_context.weight_lbs).toBeNull();
    expect(parsed.set_context.training_mode).toBeNull();
  });
});

describe('meanConcentricPeakVelocity', () => {
  it('averages concentric peak velocity across reps with concentric samples', () => {
    const reps = [makeRep(1, 0.6, 0.4), makeRep(2, 0.7, 0.5), makeRep(3, 0.8, 0.6)];
    expect(meanConcentricPeakVelocity(reps)).toBeCloseTo(0.7, 3);
  });

  it('returns null when no rep has any concentric movement', () => {
    const phaseless: Rep = {
      repNumber: 1,
      concentric: makePhase({}),
      eccentric: makePhase({}),
    };
    expect(meanConcentricPeakVelocity([phaseless])).toBeNull();
  });

  it('returns null for empty rep array', () => {
    expect(meanConcentricPeakVelocity([])).toBeNull();
  });
});

describe('summarizePreviousSet', () => {
  it('extracts setId, rep_count, weight, mean concentric velocity', () => {
    const stored: StoredSet = {
      id: 'prev-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: [
        { ...makeRep(1, 0.8, 0.5), id: 'r1', setId: 'prev-1', index: 0 },
        { ...makeRep(2, 0.6, 0.4), id: 'r2', setId: 'prev-1', index: 1 },
      ],
    };
    expect(summarizePreviousSet(stored)).toEqual({
      set_id: 'prev-1',
      rep_count: 2,
      weight_lbs: 100,
      mean_concentric_velocity: 0.7,
    });
  });
});

describe('buildSetStartedPayload', () => {
  const set: ActiveSet = {
    setId: 'set-2',
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:05:00.000Z',
    reps: [],
    status: 'active',
  };
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 135,
    trainingMode: 'WeightTraining',
  };

  it('emits meta with weight_lbs and training_mode when set on the device', () => {
    const { meta } = buildSetStartedPayload(set, device, 2, null);
    expect(meta).toEqual({
      source: 'voltras',
      event_type: 'set_started',
      set_id: 'set-2',
      session_id: 'sess-1',
      weight_lbs: '135',
      training_mode: 'WeightTraining',
    });
  });

  it('content has summary + set + previous_set_summary (null when first set)', () => {
    const { content } = buildSetStartedPayload(set, device, 1, null);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toContain('135 lbs');
    expect(parsed.summary).toContain('WeightTraining');
    expect(parsed.summary).toContain('(set 1 of session)');
    expect(parsed.set).toEqual({
      set_id: 'set-2',
      session_id: 'sess-1',
      weight_lbs: 135,
      training_mode: 'WeightTraining',
      started_at: '2025-01-01T00:05:00.000Z',
    });
    expect(parsed.previous_set_summary).toBeNull();
  });

  it('content surfaces previous_set_summary when one is provided', () => {
    const prev = {
      set_id: 'prev-1',
      rep_count: 5,
      weight_lbs: 135,
      mean_concentric_velocity: 0.78,
    };
    const { content } = buildSetStartedPayload(set, device, 2, prev);
    expect(JSON.parse(content).previous_set_summary).toEqual(prev);
  });
});

describe('buildSetEndedPayload', () => {
  function buildStored(reps: Rep[], partial?: { reason: string }): StoredSet {
    return {
      id: 'set-end',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:30.000Z',
      partial: partial !== undefined,
      ...(partial !== undefined ? { partialReason: partial.reason } : {}),
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: reps.map((r, i) => ({ ...r, id: `r${i}`, setId: 'set-end', index: i })),
    };
  }

  it('meta includes rep_count, duration_ms, partial_reason when applicable', () => {
    const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.7, 0.5)];
    const stored = buildStored(reps);
    const { meta } = buildSetEndedPayload(stored);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_ended',
      set_id: 'set-end',
      rep_count: '2',
      duration_ms: '90000',
    });
    expect(meta.partial_reason).toBeUndefined();

    const partial = buildStored(reps, { reason: 'disconnect' });
    expect(buildSetEndedPayload(partial).meta.partial_reason).toBe('disconnect');
  });

  it('content has summary + set + reps array + vbt_summary', () => {
    const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.5, 0.4)];
    const stored = buildStored(reps);
    const { content } = buildSetEndedPayload(stored);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toContain('2 reps');
    expect(parsed.summary).toContain('90s');
    expect(parsed.summary).toContain('velocity loss');
    expect(parsed.set).toMatchObject({
      set_id: 'set-end',
      session_id: 'sess-1',
      weight_lbs: 100,
      training_mode: 'WeightTraining',
      partial_reason: null,
    });
    expect(parsed.reps).toHaveLength(2);
    expect(parsed.reps[0]).toMatchObject({
      rep_number: 1,
      concentric: { peak_velocity: 0.85, mean_velocity: 0.85 },
      eccentric: { peak_velocity: 0.5, mean_velocity: 0.5 },
    });
    expect(parsed.reps[0].rom_m).toBeCloseTo(0.6, 3);
    expect(parsed.vbt_summary).toEqual({
      first_rep_v: 0.85,
      last_rep_v: 0.5,
      // (0.85 - 0.5) / 0.85 * 100 = 41.176... => 41.2
      velocity_loss_pct: 41.2,
      mean_velocity: 0.675,
    });
  });

  it('vbt_summary.velocity_loss_pct is null when fewer than 2 reps', () => {
    const reps = [makeRep(1, 0.6, 0.4)];
    const { content } = buildSetEndedPayload(buildStored(reps));
    const parsed = JSON.parse(content);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
    expect(parsed.vbt_summary.first_rep_v).toBe(0.6);
    expect(parsed.vbt_summary.last_rep_v).toBe(0.6);
  });

  it('vbt_summary fields are all null for an empty rep set (partial-disconnect with zero reps)', () => {
    const stored = buildStored([], { reason: 'disconnect' });
    const { content } = buildSetEndedPayload(stored);
    const parsed = JSON.parse(content);
    expect(parsed.reps).toEqual([]);
    expect(parsed.vbt_summary).toEqual({
      first_rep_v: null,
      last_rep_v: null,
      velocity_loss_pct: null,
      mean_velocity: null,
    });
  });

  describe('cause = "device_signal" → set_ended_by_device', () => {
    it('emits meta.event_type=set_ended_by_device with the same scalar fields as set_ended', () => {
      const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.5, 0.4)];
      const stored = buildStored(reps, { reason: 'device_signal' });
      const { meta } = buildSetEndedPayload(stored, 'device_signal');
      expect(meta).toMatchObject({
        source: 'voltras',
        event_type: 'set_ended_by_device',
        set_id: 'set-end',
        session_id: 'sess-1',
        rep_count: '2',
        duration_ms: '90000',
        partial_reason: 'device_signal',
      });
    });

    it('summary text headlines "Set ended by device" and tails the user-pressed-Stop note', () => {
      const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.5, 0.4)];
      const stored = buildStored(reps, { reason: 'device_signal' });
      const { content } = buildSetEndedPayload(stored, 'device_signal');
      const parsed = JSON.parse(content);
      expect(parsed.summary).toContain('Set ended by device');
      expect(parsed.summary).toContain('2 reps');
      expect(parsed.summary).toContain('90s');
      expect(parsed.summary).toContain('user pressed Stop on the unit');
    });

    it('content payload is structurally identical to set_ended (reps + vbt_summary + set)', () => {
      const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.5, 0.4)];
      const stored = buildStored(reps, { reason: 'device_signal' });
      const toolPayload = JSON.parse(buildSetEndedPayload(stored, 'tool').content);
      const devicePayload = JSON.parse(buildSetEndedPayload(stored, 'device_signal').content);
      // Same shape — the same model can parse either with one schema.
      expect(Object.keys(devicePayload).sort()).toEqual(Object.keys(toolPayload).sort());
      expect(devicePayload.reps).toEqual(toolPayload.reps);
      expect(devicePayload.vbt_summary).toEqual(toolPayload.vbt_summary);
      expect(devicePayload.set.partial_reason).toBe('device_signal');
    });

    it('summary still surfaces velocity loss when the set has at least 2 reps', () => {
      const reps = [makeRep(1, 0.85, 0.5), makeRep(2, 0.5, 0.4)];
      const stored = buildStored(reps, { reason: 'device_signal' });
      const { content } = buildSetEndedPayload(stored, 'device_signal');
      const parsed = JSON.parse(content);
      // velocity_loss_pct is computed identically to the tool path.
      expect(parsed.vbt_summary.velocity_loss_pct).toBeCloseTo(41.2, 1);
      expect(parsed.summary).toContain('41.2% velocity loss');
    });
  });
});

describe('buildConnectionChangedPayload', () => {
  it('connected: meta carries state + device_id, summary names the device when known', () => {
    const device: DeviceSnapshot = {
      connected: true,
      deviceId: 'voltra-XYZ',
      deviceName: 'Voltra Pro',
      batteryPercent: 85,
    };
    const { meta, content } = buildConnectionChangedPayload('connected', device, null);
    expect(meta).toEqual({
      source: 'voltras',
      event_type: 'connection_changed',
      state: 'connected',
      device_id: 'voltra-XYZ',
    });
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Voltra connected (Voltra Pro).');
    expect(parsed.device).toEqual({
      device_id: 'voltra-XYZ',
      device_name: 'Voltra Pro',
      connected: true,
      battery_percent: 85,
    });
    expect(parsed.active_set_at_disconnect).toBeNull();
  });

  it('connected: summary omits the device-name parens when deviceName is absent', () => {
    const device: DeviceSnapshot = { connected: true };
    const { content } = buildConnectionChangedPayload('connected', device, null);
    expect(JSON.parse(content).summary).toBe('Voltra connected.');
  });

  it('disconnected with no active set: omits mid_set meta and reports null active set', () => {
    const device: DeviceSnapshot = {
      connected: false,
      deviceId: 'voltra-XYZ',
      disconnectedAt: '2025-05-01T12:00:00.000Z',
    };
    const { meta, content } = buildConnectionChangedPayload('disconnected', device, null);
    expect(meta.mid_set).toBeUndefined();
    expect(meta.disconnected_at).toBe('2025-05-01T12:00:00.000Z');
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Voltra disconnected.');
    expect(parsed.active_set_at_disconnect).toBeNull();
  });

  it('disconnected mid-set: emits mid_set=true and renders the summary with rep + set id prefix', () => {
    const device: DeviceSnapshot = {
      connected: false,
      deviceId: 'voltra-XYZ',
      disconnectedAt: '2025-05-01T12:00:00.000Z',
      weightLbs: 135,
      trainingMode: 'WeightTraining',
    };
    const activeSet = {
      set_id: 'set-abcd1234efgh5678',
      rep_count_so_far: 4,
      weight_lbs: 135,
      training_mode: 'WeightTraining',
    };
    const { meta, content } = buildConnectionChangedPayload('disconnected', device, activeSet);
    expect(meta).toMatchObject({
      event_type: 'connection_changed',
      state: 'disconnected',
      mid_set: 'true',
      device_id: 'voltra-XYZ',
      disconnected_at: '2025-05-01T12:00:00.000Z',
    });
    const parsed = JSON.parse(content);
    // set_id_short is set_id.slice(0, 8).
    expect(parsed.summary).toBe('Voltra disconnected mid-set (rep 4 of set set-abcd, 135 lbs).');
    expect(parsed.active_set_at_disconnect).toEqual(activeSet);
  });

  it("intermediate 'connecting' state renders 'Voltra connecting.' summary", () => {
    const device: DeviceSnapshot = { connected: false };
    const { meta, content } = buildConnectionChangedPayload('connecting', device, null);
    expect(meta.state).toBe('connecting');
    // No mid_set / disconnected_at attrs on intermediate states.
    expect(meta.mid_set).toBeUndefined();
    expect(meta.disconnected_at).toBeUndefined();
    expect(JSON.parse(content).summary).toBe('Voltra connecting.');
  });

  it("intermediate 'authenticating' state renders 'Voltra authenticating.' summary", () => {
    const device: DeviceSnapshot = { connected: false };
    const { content } = buildConnectionChangedPayload('authenticating', device, null);
    expect(JSON.parse(content).summary).toBe('Voltra authenticating.');
  });

  it('omits device_id from meta when the device snapshot has none', () => {
    const device: DeviceSnapshot = { connected: true };
    const { meta } = buildConnectionChangedPayload('connected', device, null);
    expect(meta.device_id).toBeUndefined();
  });
});
