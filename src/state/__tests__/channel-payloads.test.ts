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
});
