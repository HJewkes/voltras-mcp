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
  buildGuidedLoadStatePayload,
  buildModeDivergedPayload,
  buildIdleTimeoutPayload,
  buildRepFinalizedPayload,
  buildRestStatusPayload,
  buildSetEndedPayload,
  buildSetStartedPayload,
  buildSettingCoercedPayload,
  buildSetTargetReachedPayload,
  buildVelocityLossExceededPayload,
  guidedLoadPhaseToOutcome,
  meanConcentricPeakVelocity,
  summarizePreviousSet,
  summarizeSetForTrigger,
  triggerDedupeKey,
} from '../channel-payloads.js';
import type { PendingCoercionCheck } from '../coercion-watch.js';
import type { ActiveSet, DeviceSnapshot } from '../live-state.js';
import type { StoredSet } from '../../store/types.js';

// Note on units: `peakVelocity` and `totalVelocity` here are in WA's native
// scale (mm/s) — the channel-payload builders divide by 1000 on the way out
// so the serialized values land as m/s. Similarly `startPos`/`endPos` are
// in mm so `rom_m` lands as metres. Tests below pass values like `850`
// (= 0.85 m/s) and `600` (= 0.6 m ROM) accordingly.
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
    totalForce: number;
    peakVelocityTime: number;
    lastMovementVelocity: number;
    peakForce: number;
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
    _totalForce: overrides.totalForce ?? 0,
    _totalLoad: 0,
    _movementSampleCount: overrides.movementSampleCount ?? 0,
    _totalHoldDuration: overrides.holdMs ?? 0,
    _peakVelocityTime: overrides.peakVelocityTime ?? 0,
    _lastMovementVelocity: overrides.lastMovementVelocity ?? 0,
    peakVelocity: overrides.peakVelocity ?? 0,
    peakForce: overrides.peakForce ?? 0,
    peakLoad: 0,
  };
}

// `concPeak` and `eccPeak` are in mm/s (WA's native unit). Positions are in
// mm — 600 here = 0.6 m ROM after the payload-boundary conversion.
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
      startPos: 0,
      endPos: 600,
    }),
    eccentric: makePhase({
      samples: 4,
      peakVelocity: eccPeak,
      totalVelocity: eccPeak * 4,
      movementSampleCount: 4,
      startTime: 1400,
      endTime: 1900,
      startPos: 600,
      endPos: 0,
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
    // makeRep peakVelocity is in WA's native mm/s; the payload converts at
    // the boundary so meta surfaces m/s (`850 mm/s` → `'0.850'`).
    const rep = makeRep(1, 850, 620);
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
    const rep = makeRep(1, 500, 400);
    const noWeight: DeviceSnapshot = { connected: true };
    const { meta } = buildRepFinalizedPayload(rep, 0, set, noWeight, 2);
    expect(meta.weight_lbs).toBeUndefined();
  });

  it('F6 (VMCP-01.21): peak_force reads phase.peakForce, not the never-populated peakLoad', () => {
    // Hardware capture 2026-05-11: 5 reps at 20 lb of pull, every
    // `rep_finalized.rep.peak_force === 0`. Root cause: bridge built
    // WorkoutSample with `force` populated but no `load`, then read the
    // payload via getRepPeakLoad (zero) instead of getRepPeakForce
    // (populated). This regression test asserts the field now reads
    // `peakForce` so the bug stays fixed.
    const rep: Rep = {
      repNumber: 1,
      concentric: { ...makePhase({ samples: 2, peakVelocity: 600 }), peakForce: 22.5 },
      eccentric: { ...makePhase({ samples: 2, peakVelocity: 500 }), peakForce: 18 },
    };
    const { content } = buildRepFinalizedPayload(rep, 0, set, device, 1);
    const parsed = JSON.parse(content);
    expect(parsed.rep.peak_force).toBe(22.5);
  });

  it('emits content as JSON with summary first + rep phase data + set_context', () => {
    // 710 mm/s peak conc → 0.71 m/s after boundary conversion.
    const rep = makeRep(2, 710, 550);
    const { content } = buildRepFinalizedPayload(rep, 1, set, device, 3);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Rep 2: 0.71 m/s peak conc, 135 lbs');
    expect(parsed.rep.rep_number).toBe(2);
    expect(parsed.rep.concentric).toMatchObject({
      peak_velocity: 0.71,
      mean_velocity: 0.71,
      duration_ms: 400,
    });
    expect(parsed.rep.eccentric).toMatchObject({
      peak_velocity: 0.55,
      mean_velocity: 0.55,
      duration_ms: 500,
    });
    expect(parsed.rep.peak_force).toBe(0);
    expect(parsed.rep.rom_m).toBeCloseTo(0.6, 3);
    expect(parsed.set_context).toEqual({
      weight_lbs: 135,
      // VMCP-02.09: requested (cmd=0x10) surfaced explicitly; active_mode is
      // null here because the fixture carries no cmd=0x07 trainingModeRaw.
      requested_mode: 'WeightTraining',
      active_mode: null,
      training_mode: 'WeightTraining',
      rep_count_so_far: 2,
    });
  });

  // VMCP-02.09 — when the applied (cmd=0x07) byte is present and diverges from
  // the requested mode, set_context surfaces both distinctly.
  it('surfaces active_mode from trainingModeRaw, distinct from requested_mode', () => {
    const diverged: DeviceSnapshot = {
      connected: true,
      weightLbs: 135,
      trainingMode: 'Isokinetic', // requested (cmd=0x10)
      trainingModeRaw: 1, // applied (cmd=0x07) — device actually running WeightTraining
    };
    const rep = makeRep(1, 500, 400);
    const { content } = buildRepFinalizedPayload(rep, 0, set, diverged, 2);
    const parsed = JSON.parse(content);
    expect(parsed.set_context.requested_mode).toBe('Isokinetic');
    expect(parsed.set_context.active_mode).toBe('Weight Training');
    expect(parsed.set_context.training_mode).toBe('Isokinetic'); // deprecated alias = requested
  });

  it('surfaces telemetry enrichment fields on each phase + rep level', () => {
    // Hand-built rep with known internals so the boundary conversions are
    // checkable. Concentric phase: 4 movement samples, peakVelocity 800 mm/s
    // captured 200ms into the phase, _totalPower = 800 * 100 * 4 = 320_000
    // (peakForce 100, uniform), trailing movement velocity 600 mm/s.
    const rep: Rep = {
      repNumber: 3,
      concentric: makePhase({
        samples: 4,
        peakVelocity: 800,
        totalVelocity: 2800,
        totalForce: 400,
        movementSampleCount: 4,
        peakVelocityTime: 1200,
        lastMovementVelocity: 600,
        peakForce: 100,
        startTime: 1000,
        endTime: 1400,
        startPos: 0,
        endPos: 600,
      }),
      eccentric: makePhase({
        samples: 4,
        peakVelocity: 500,
        totalVelocity: 1600,
        totalForce: 320,
        movementSampleCount: 4,
        peakVelocityTime: 1600,
        lastMovementVelocity: 200,
        peakForce: 80,
        startTime: 1500,
        endTime: 1900,
        startPos: 600,
        endPos: 0,
      }),
    };
    const { content } = buildRepFinalizedPayload(rep, 2, set, device, 3);
    const parsed = JSON.parse(content);
    const conc = parsed.rep.concentric;
    expect(conc.time_to_peak_velocity_ms).toBe(200); // 1200 - 1000
    // velocity_drop: (peak 800 - last 600) / peak × 100 = 25%
    expect(conc.velocity_drop_pct).toBeCloseTo(25.0, 1);
    // velocity_envelope is 4-pt array; values land in m/s (synthetic phase
    // has zero-velocity samples, so envelope is [0, 0, 0, 0]).
    expect(conc.velocity_envelope_mps).toEqual([0, 0, 0, 0]);
    // Eccentric mirrors the same shape.
    expect(parsed.rep.eccentric.velocity_drop_pct).toBeCloseTo(60.0, 1);
    expect(parsed.rep.eccentric.time_to_peak_velocity_ms).toBe(100);
    // Rep-level: tempo_ratio = ecc.movementDuration / conc.movementDuration
    // = 0.4 / 0.4 = 1.0 (no hold in either phase).
    expect(parsed.rep.tempo_ratio).toBeCloseTo(1.0, 2);
    // hold_top_ms = eccentric.startTime - concentric.endTime = 1500 - 1400 = 100
    expect(parsed.rep.hold_top_ms).toBe(100);
  });

  // VMCP-02.46: impulse + mean-power are added at the rep level by correcting
  // WA's tenths-of-lbs (force ÷10) and mm (position ÷1000) inflation at the
  // emit boundary — the bridge's WorkoutSample passthrough is left untouched.
  it('emits impulse_lb_s + mean_power_lb_mps with the tenths/mm inflation corrected', () => {
    // Concentric: 3 samples, force held at 500 tenths (= 50 lb), position
    // 0 → 100 → 200 mm across 1000 → 1200 ms (0.2 s of movement, no hold).
    //   impulse = ∫F dt = 50 lb × 0.2 s = 10.0 lb·s
    //   work    = ∫F dx = 50 lb × 0.2 m = 10.0 lb·m
    //   power   = work / 0.2 s          = 50.0 lb·m/s
    const concentric = {
      ...makePhase({ samples: 0, startTime: 1000, endTime: 1200, movementSampleCount: 3 }),
      samples: [
        { sequence: 0, timestamp: 1000, phase: 1, position: 0, velocity: 0, force: 500 },
        { sequence: 1, timestamp: 1100, phase: 1, position: 100, velocity: 0, force: 500 },
        { sequence: 2, timestamp: 1200, phase: 1, position: 200, velocity: 0, force: 500 },
      ] as Rep['concentric']['samples'],
    };
    const rep: Rep = {
      repNumber: 1,
      concentric,
      eccentric: makePhase({ samples: 2, startTime: 1200, endTime: 1600 }),
    };
    const { content } = buildRepFinalizedPayload(rep, 0, set, device, 1);
    const parsed = JSON.parse(content);
    expect(parsed.rep.impulse_lb_s).toBeCloseTo(10.0, 3);
    expect(parsed.rep.mean_power_lb_mps).toBeCloseTo(50.0, 3);
  });

  it('emits null impulse_lb_s + mean_power_lb_mps when the concentric phase has no samples', () => {
    const rep: Rep = {
      repNumber: 1,
      concentric: makePhase({ samples: 0, startTime: 1000, endTime: 1000 }),
      eccentric: makePhase({ samples: 0 }),
    };
    const { content } = buildRepFinalizedPayload(rep, 0, set, device, 1);
    const parsed = JSON.parse(content);
    expect(parsed.rep.impulse_lb_s).toBeNull();
    expect(parsed.rep.mean_power_lb_mps).toBeNull();
  });

  it('uses a weight-less summary when device weight is unknown', () => {
    const rep = makeRep(1, 500, 400);
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
    // Native mm/s in, m/s out: mean of 600/700/800 mm/s = 700 mm/s = 0.7 m/s.
    const reps = [makeRep(1, 600, 400), makeRep(2, 700, 500), makeRep(3, 800, 600)];
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
        { ...makeRep(1, 800, 500), id: 'r1', setId: 'prev-1', index: 0 },
        { ...makeRep(2, 600, 400), id: 'r2', setId: 'prev-1', index: 1 },
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

  it('emits meta with weight_lbs and requested/training_mode when set on the device', () => {
    const { meta } = buildSetStartedPayload(set, device, 2, null);
    expect(meta).toEqual({
      source: 'voltras',
      event_type: 'set_started',
      set_id: 'set-2',
      session_id: 'sess-1',
      weight_lbs: '135',
      // VMCP-02.09: requested surfaced explicitly; training_mode kept as alias.
      // active_mode is omitted from meta when no cmd=0x07 byte is known.
      requested_mode: 'WeightTraining',
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
      requested_mode: 'WeightTraining',
      active_mode: null,
      training_mode: 'WeightTraining',
      started_at: '2025-01-01T00:05:00.000Z',
    });
    expect(parsed.previous_set_summary).toBeNull();
  });

  // VMCP-02.09 — applied (cmd=0x07) mode surfaced on both meta and content.
  it('surfaces active_mode from trainingModeRaw on meta and content', () => {
    const diverged: DeviceSnapshot = {
      connected: true,
      weightLbs: 135,
      trainingMode: 'Isokinetic',
      trainingModeRaw: 1,
    };
    const { meta, content } = buildSetStartedPayload(set, diverged, 1, null);
    expect(meta.requested_mode).toBe('Isokinetic');
    expect(meta.active_mode).toBe('Weight Training');
    const parsed = JSON.parse(content);
    expect(parsed.set.requested_mode).toBe('Isokinetic');
    expect(parsed.set.active_mode).toBe('Weight Training');
    expect(parsed.set.training_mode).toBe('Isokinetic');
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
    const reps = [makeRep(1, 850, 500), makeRep(2, 700, 500)];
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
    const reps = [makeRep(1, 850, 500), makeRep(2, 500, 400)];
    const stored = buildStored(reps);
    const { content } = buildSetEndedPayload(stored);
    const parsed = JSON.parse(content);
    expect(parsed.summary).toContain('2 reps');
    expect(parsed.summary).toContain('90s');
    expect(parsed.summary).toContain('velocity loss (peak-to-last)');
    expect(parsed.set).toMatchObject({
      set_id: 'set-end',
      session_id: 'sess-1',
      weight_lbs: 100,
      // VMCP-02.09: requested mode from the StoredSet; active_mode is always
      // null on set_ended (StoredSet does not persist the cmd=0x07 byte).
      requested_mode: 'WeightTraining',
      active_mode: null,
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
    // VMCP-02.46: serialized reps carry impulse + mean-power too. makeRep's
    // samples have zero force/position, so both compute to 0 (present, not
    // null — the concentric phase does have samples).
    expect(parsed.reps[0].impulse_lb_s).toBe(0);
    expect(parsed.reps[0].mean_power_lb_mps).toBe(0);
    expect(parsed.vbt_summary).toEqual({
      first_rep_v: 0.85,
      // rep 1 (850) is the set's fastest, so it's the peak baseline
      peak_rep_v: 0.85,
      peak_rep_number: 1,
      last_rep_v: 0.5,
      // (peak 850 - last 500) / 850 * 100 = 41.176... => 41.2 (unit-invariant)
      velocity_loss_pct: 41.2,
      mean_velocity: 0.675,
    });
  });

  it('vbt_summary.velocity_loss_pct is null when fewer than 2 reps', () => {
    const reps = [makeRep(1, 600, 400)];
    const { content } = buildSetEndedPayload(buildStored(reps));
    const parsed = JSON.parse(content);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
    expect(parsed.vbt_summary.first_rep_v).toBe(0.6);
    expect(parsed.vbt_summary.peak_rep_v).toBe(0.6);
    expect(parsed.vbt_summary.peak_rep_number).toBe(1);
    expect(parsed.vbt_summary.last_rep_v).toBe(0.6);
  });

  it('vbt_summary fields are all null for an empty rep set (partial-disconnect with zero reps)', () => {
    const stored = buildStored([], { reason: 'disconnect' });
    const { content } = buildSetEndedPayload(stored);
    const parsed = JSON.parse(content);
    expect(parsed.reps).toEqual([]);
    expect(parsed.vbt_summary).toEqual({
      first_rep_v: null,
      peak_rep_v: null,
      peak_rep_number: null,
      last_rep_v: null,
      velocity_loss_pct: null,
      mean_velocity: null,
    });
  });

  it('F14 (VMCP-01.28): vbt_summary uses last complete rep when partial trailing rep is dropped pre-payload', () => {
    // Hardware capture 2026-05-11: 5 complete reps then the inactivity
    // watchdog (or a disconnect) force-closed mid-rep-6. Pre-fix, a
    // single-sample concentric-only rep 6 was persisted (peakVelocity=982
    // mm/s) and last_rep_v reflected that bogus value, polluting the
    // peak baseline and velocity loss. Post-fix, the inactivity-timeout
    // finalize path drops the trailing in-progress rep before persistence,
    // so the StoredSet that reaches `buildSetEndedPayload` contains only 5
    // reps and last_rep_v correctly reflects rep 5's concentric peak.
    const reps = [
      makeRep(1, 700, 500), // first
      makeRep(2, 720, 520),
      makeRep(3, 760, 510),
      makeRep(4, 800, 530),
      makeRep(5, 850, 540), // last complete rep — real "last_rep_v"
    ];
    const stored = buildStored(reps, { reason: 'inactivity_timeout' });
    const { content } = buildSetEndedPayload(stored, 'tool');
    const parsed = JSON.parse(content);
    expect(parsed.reps).toHaveLength(5);
    // Rep 5's peak concentric velocity (850 mm/s → 0.85 m/s) is the
    // last_rep_v — NOT some bogus value from a never-completed rep 6.
    expect(parsed.vbt_summary.last_rep_v).toBe(0.85);
    expect(parsed.vbt_summary.first_rep_v).toBe(0.7);
    // The set was accelerating monotonically — rep 5 (850) is both the last
    // rep AND the peak baseline, so peak-to-last velocity loss is exactly 0.
    // The bogus rep-6 value would have raised the peak and pushed last_rep_v
    // below it, fabricating a loss that never happened.
    expect(parsed.vbt_summary.peak_rep_number).toBe(5);
    expect(parsed.vbt_summary.peak_rep_v).toBe(0.85);
    expect(parsed.vbt_summary.velocity_loss_pct).toBe(0);
  });

  describe('cause = "device_signal" → unified set_ended with closed_by="device"', () => {
    // F14/F15 rewrite: the formerly-distinct `set_ended_by_device` event
    // type has been folded into a single `set_ended`. The
    // `meta.closed_by` discriminator carries which path closed the set.
    // Device-signal close is no longer "partial" — it's the canonical
    // natural close.
    it('emits meta.event_type=set_ended with closed_by=device', () => {
      const reps = [makeRep(1, 850, 500), makeRep(2, 500, 400)];
      const stored = buildStored(reps); // not partial
      const { meta } = buildSetEndedPayload(stored, 'device_signal');
      expect(meta).toMatchObject({
        source: 'voltras',
        event_type: 'set_ended',
        set_id: 'set-end',
        session_id: 'sess-1',
        rep_count: '2',
        duration_ms: '90000',
        closed_by: 'device',
      });
      expect(meta.partial_reason).toBeUndefined();
    });

    it('summary text headlines "Set ended by device" and tails the user-pressed-Stop note', () => {
      const reps = [makeRep(1, 850, 500), makeRep(2, 500, 400)];
      const stored = buildStored(reps);
      const { content } = buildSetEndedPayload(stored, 'device_signal');
      const parsed = JSON.parse(content);
      expect(parsed.summary).toContain('Set ended by device');
      expect(parsed.summary).toContain('2 reps');
      expect(parsed.summary).toContain('90s');
      expect(parsed.summary).toContain('set ended automatically');
    });

    it('content payload is structurally identical to tool-driven set_ended (reps + vbt_summary + set)', () => {
      const reps = [makeRep(1, 850, 500), makeRep(2, 500, 400)];
      const stored = buildStored(reps);
      const toolPayload = JSON.parse(buildSetEndedPayload(stored, 'tool').content);
      const devicePayload = JSON.parse(buildSetEndedPayload(stored, 'device_signal').content);
      // Same shape — the same model can parse either with one schema.
      expect(Object.keys(devicePayload).sort()).toEqual(Object.keys(toolPayload).sort());
      expect(devicePayload.reps).toEqual(toolPayload.reps);
      expect(devicePayload.vbt_summary).toEqual(toolPayload.vbt_summary);
      expect(devicePayload.set.closed_by).toBe('device');
      expect(toolPayload.set.closed_by).toBe('tool');
    });

    it('summary still surfaces the velocity loss when the set has at least 2 reps', () => {
      const reps = [makeRep(1, 850, 500), makeRep(2, 500, 400)];
      const stored = buildStored(reps);
      const { content } = buildSetEndedPayload(stored, 'device_signal');
      const parsed = JSON.parse(content);
      // velocity_loss_pct is computed identically to the tool path.
      expect(parsed.vbt_summary.velocity_loss_pct).toBeCloseTo(41.2, 1);
      expect(parsed.summary).toContain('41.2% velocity loss (peak-to-last)');
    });
  });
});

describe('buildConnectionChangedPayload', () => {
  it('connected: meta carries state + summary, content carries device snapshot', () => {
    const device: DeviceSnapshot = {
      connected: true,
      batteryPercent: 85,
      weightLbs: 100,
      trainingMode: 'WeightTraining',
      damperLevel: 3,
    };
    const { meta, content } = buildConnectionChangedPayload('connected', device, null);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'connection_changed',
      state: 'connected',
    });
    // Connection without prior staleness still carries the refreshed flag —
    // any 'connected' transition with non-stale LiveState reflects fresh
    // data per the soft-reset contract.
    expect(meta.refreshed).toBe('true');
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Voltra connected.');
    expect(parsed.device).toEqual({
      connected: true,
      battery_percent: 85,
      weight_lbs: 100,
      // VMCP-02.09: requested surfaced explicitly; active_mode null (fixture has
      // no cmd=0x07 trainingModeRaw); training_mode retained as alias.
      requested_mode: 'WeightTraining',
      active_mode: null,
      training_mode: 'WeightTraining',
      damper_level: 3,
      stale_since_disconnect: null,
    });
    expect(parsed.active_set_at_disconnect).toBeNull();
  });

  it('connected with stale snapshot: omits the refreshed meta tag', () => {
    const device: DeviceSnapshot = {
      connected: true,
      isStale: true,
      staleSinceDisconnect: '2025-05-01T11:59:00.000Z',
    };
    const { meta, content } = buildConnectionChangedPayload('connected', device, null);
    expect(meta.refreshed).toBeUndefined();
    expect(JSON.parse(content).device.stale_since_disconnect).toBe('2025-05-01T11:59:00.000Z');
  });

  it('disconnected with no active set: omits mid_set meta and reports null active set', () => {
    const device: DeviceSnapshot = {
      connected: false,
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
});

describe('buildModeDivergedPayload (VMCP-02.09c)', () => {
  it('emits meta + content naming requested vs active and the divergence age', () => {
    const { meta, content } = buildModeDivergedPayload({
      requestedMode: 'Isokinetic',
      activeMode: 'Weight Training',
      divergedForMs: 4200,
      setId: 'set-9',
      sessionId: 'sess-3',
    });
    expect(meta).toEqual({
      source: 'voltras',
      event_type: 'mode_diverged',
      requested_mode: 'Isokinetic',
      active_mode: 'Weight Training',
      diverged_for_ms: '4200',
      set_id: 'set-9',
      session_id: 'sess-3',
    });
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe(
      'Mode mismatch: requested Isokinetic but the device is running Weight Training (4.2s). ' +
        'The mode change may not have taken — re-select on the unit.',
    );
    expect(parsed.divergence).toEqual({
      requested_mode: 'Isokinetic',
      active_mode: 'Weight Training',
      diverged_for_ms: 4200,
    });
    expect(parsed.set_context).toEqual({ set_id: 'set-9', session_id: 'sess-3' });
  });

  it('omits set/session meta and nulls set_context when no set is active', () => {
    const { meta, content } = buildModeDivergedPayload({
      requestedMode: 'Rowing',
      activeMode: 'unverified(5)',
      divergedForMs: 2000,
    });
    expect(meta.set_id).toBeUndefined();
    expect(meta.session_id).toBeUndefined();
    expect(JSON.parse(content).set_context).toBeNull();
  });
});

describe('triggerDedupeKey', () => {
  it('uses (type, value) for rep_count_reached', () => {
    expect(triggerDedupeKey({ type: 'rep_count_reached', value: 8 })).toBe('rep_count_reached:8');
  });

  it('uses (type, pct) for velocity_loss_exceeded', () => {
    expect(triggerDedupeKey({ type: 'velocity_loss_exceeded', pct: 25 })).toBe(
      'velocity_loss_exceeded:25',
    );
  });

  // F14/F15 rewrite removed the `idle_timeout_ms` trigger spec — inactivity
  // is now governed by `WatchConfig.inactivityTimeoutMs` and has no trigger
  // dedupe key. Test deleted.
});

describe('summarizeSetForTrigger', () => {
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 135,
    trainingMode: 'WeightTraining',
  };

  it('mirrors the set_ended payload shape (set + reps + vbt_summary)', () => {
    const set: ActiveSet = {
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [makeRep(1, 850, 500), makeRep(2, 700, 450)],
      status: 'active',
    };
    const summary = summarizeSetForTrigger(set, device);
    expect(summary.set).toEqual({
      set_id: 'set-1',
      session_id: 'sess-1',
      weight_lbs: 135,
      // VMCP-02.09: requested explicit; active_mode null (no cmd=0x07 byte in
      // the fixture); training_mode retained as alias.
      requested_mode: 'WeightTraining',
      active_mode: null,
      training_mode: 'WeightTraining',
      started_at: '2025-01-01T00:00:00.000Z',
    });
    expect(summary.reps).toHaveLength(2);
    expect(summary.reps[0]).toMatchObject({
      rep_number: 1,
      concentric: { peak_velocity: 0.85 },
    });
    expect(summary.vbt_summary.first_rep_v).toBe(0.85);
    expect(summary.vbt_summary.last_rep_v).toBe(0.7);
  });

  // VMCP-02.09 — applied (cmd=0x07) mode surfaced from trainingModeRaw,
  // distinct from the requested mode, on the trigger set_so_far block.
  it('surfaces active_mode from trainingModeRaw, distinct from requested_mode', () => {
    const set: ActiveSet = {
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [],
      status: 'active',
    };
    const diverged: DeviceSnapshot = {
      connected: true,
      weightLbs: 135,
      trainingMode: 'Isokinetic',
      trainingModeRaw: 1,
    };
    const summary = summarizeSetForTrigger(set, diverged);
    expect(summary.set.requested_mode).toBe('Isokinetic');
    expect(summary.set.active_mode).toBe('Weight Training');
    expect(summary.set.training_mode).toBe('Isokinetic');
  });

  it('reports null weight/mode when device has none', () => {
    const set: ActiveSet = {
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [],
      status: 'active',
    };
    const noDevice: DeviceSnapshot = { connected: true };
    const summary = summarizeSetForTrigger(set, noDevice);
    expect(summary.set.weight_lbs).toBeNull();
    expect(summary.set.training_mode).toBeNull();
    expect(summary.reps).toEqual([]);
  });
});

describe('buildSetTargetReachedPayload', () => {
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 135,
    trainingMode: 'WeightTraining',
  };
  function activeSet(reps: Rep[]): ActiveSet {
    return {
      setId: 'set-target-12345678',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps,
      status: 'active',
    };
  }

  it('emits advisory cue meta + content with set_so_far block', () => {
    const set = activeSet([makeRep(1, 850, 500), makeRep(2, 700, 450)]);
    const { meta, content } = buildSetTargetReachedPayload(set, device, 8, 2);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_target_reached',
      set_id: 'set-target-12345678',
      session_id: 'sess-1',
      target_rep_count: '8',
      actual_rep_count: '2',
    });
    expect(meta.auto_stopped).toBeUndefined();
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Target reached: 2/8 reps on set set-targ.');
    expect(parsed.trigger).toEqual({
      type: 'rep_count_reached',
      target: 8,
      actual: 2,
    });
    expect(parsed.set_so_far.set.set_id).toBe('set-target-12345678');
    expect(parsed.set_so_far.reps).toHaveLength(2);
  });
});

describe('buildVelocityLossExceededPayload', () => {
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 135,
    trainingMode: 'WeightTraining',
  };
  function activeSet(reps: Rep[]): ActiveSet {
    return {
      setId: 'set-vel-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps,
      status: 'active',
    };
  }

  it('exposes scalar velocity context in meta and trigger details in content', () => {
    // baseline/current arrive in WA's native mm/s; builder converts to m/s
    // for the payload labels. Pre-computed `pct` is unit-invariant and
    // passes through unchanged.
    const set = activeSet([makeRep(1, 850, 500), makeRep(2, 800, 500), makeRep(3, 550, 400)]);
    const { meta, content } = buildVelocityLossExceededPayload(
      set,
      device,
      25,
      35.3,
      850,
      550,
      1,
      3,
    );
    expect(meta).toMatchObject({
      event_type: 'velocity_loss_exceeded',
      set_id: 'set-vel-1',
      velocity_loss_pct: '35.3',
      threshold_pct: '25',
      baseline_velocity: '0.850',
      current_velocity: '0.550',
      rep_count_at_threshold: '3',
    });
    expect(meta.auto_stopped).toBeUndefined();
    const parsed = JSON.parse(content);
    expect(parsed.summary).toContain('35.3%');
    expect(parsed.summary).toContain('rep 3');
    expect(parsed.summary).not.toContain('auto-stopping');
    expect(parsed.trigger).toMatchObject({
      type: 'velocity_loss_exceeded',
      threshold_pct: 25,
      actual_pct: 35.3,
      baseline_velocity: 0.85,
      current_velocity: 0.55,
      baseline_rep_number: 1,
    });
    expect(parsed.set_so_far.reps).toHaveLength(3);
  });
});

describe('buildIdleTimeoutPayload', () => {
  const device: DeviceSnapshot = { connected: true, weightLbs: 100 };
  function activeSet(reps: Rep[]): ActiveSet {
    return {
      setId: 'set-idle-12345678',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps,
      status: 'active',
    };
  }

  it('emits the standard meta scalars with idle/threshold ms', () => {
    const set = activeSet([makeRep(1, 600, 400), makeRep(2, 500, 400)]);
    const { meta, content } = buildIdleTimeoutPayload(
      set,
      device,
      30_000,
      31_500,
      '2025-01-01T00:00:30.000Z',
    );
    expect(meta).toMatchObject({
      event_type: 'idle_timeout',
      set_id: 'set-idle-12345678',
      session_id: 'sess-1',
      idle_ms: '31500',
      threshold_ms: '30000',
      last_rep_count: '2',
    });
    expect(meta.auto_stopped).toBeUndefined();
    const parsed = JSON.parse(content);
    expect(parsed.summary).toContain('No reps for 32s');
    expect(parsed.summary).toContain('threshold 30s');
    // Inactivity watchdog is the only force-close path; summary tails it.
    expect(parsed.summary).toContain('auto-stopping');
    expect(parsed.trigger).toEqual({
      type: 'idle_timeout_ms',
      threshold_ms: 30_000,
      actual_idle_ms: 31_500,
      last_rep_at: '2025-01-01T00:00:30.000Z',
      last_rep_count: 2,
    });
    expect(parsed.set_so_far.reps).toHaveLength(2);
  });

  it('reports set_so_far=null when no reps have finalized yet', () => {
    const set = activeSet([]);
    const { meta, content } = buildIdleTimeoutPayload(
      set,
      device,
      45_000,
      45_000,
      '2025-01-01T00:00:00.000Z',
    );
    expect(meta.last_rep_count).toBe('0');
    const parsed = JSON.parse(content);
    expect(parsed.set_so_far).toBeNull();
  });
});

describe('buildSetEndedPayload — closed_by discriminator', () => {
  // F14/F15 rewrite: `auto_stop_cause` is gone (watch triggers no longer
  // force-close). The unified payload uses `meta.closed_by` to discriminate
  // close paths.
  function buildStored(reps: Rep[], partialReason?: string): StoredSet {
    return {
      id: 'set-auto',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:30.000Z',
      partial: partialReason !== undefined,
      ...(partialReason !== undefined ? { partialReason } : {}),
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: reps.map((r, i) => ({ ...r, id: `r${i}`, setId: 'set-auto', index: i })),
    };
  }

  it('closed_by="inactivity_timeout" when stored.partialReason is inactivity_timeout', () => {
    const stored = buildStored([makeRep(1, 800, 500)], 'inactivity_timeout');
    const { meta, content } = buildSetEndedPayload(stored, 'tool');
    expect(meta.closed_by).toBe('inactivity_timeout');
    expect(meta.partial_reason).toBe('inactivity_timeout');
    const parsed = JSON.parse(content) as { set: { closed_by: string } };
    expect(parsed.set.closed_by).toBe('inactivity_timeout');
  });

  it('closed_by="disconnect" when partialReason is disconnect', () => {
    const stored = buildStored([makeRep(1, 800, 500)], 'disconnect');
    const { meta } = buildSetEndedPayload(stored, 'tool');
    expect(meta.closed_by).toBe('disconnect');
  });

  it('closed_by="session_end" when partialReason is session_end', () => {
    const stored = buildStored([makeRep(1, 800, 500)], 'session_end');
    const { meta } = buildSetEndedPayload(stored, 'tool');
    expect(meta.closed_by).toBe('session_end');
  });

  it('closed_by="guided_load_exited" when partialReason is guided_load_exited', () => {
    const stored = buildStored([makeRep(1, 800, 500)], 'guided_load_exited');
    const { meta } = buildSetEndedPayload(stored, 'tool');
    expect(meta.closed_by).toBe('guided_load_exited');
  });

  it('closed_by="tool" for graceful set.end (no partial reason)', () => {
    const stored = buildStored([makeRep(1, 800, 500)]);
    const { meta, content } = buildSetEndedPayload(stored, 'tool');
    expect(meta.closed_by).toBe('tool');
    expect(meta.partial_reason).toBeUndefined();
    const parsed = JSON.parse(content) as { set: { closed_by: string } };
    expect(parsed.set.closed_by).toBe('tool');
  });

  it('closed_by="device" for device-signal close even when partialReason is unset', () => {
    const stored = buildStored([makeRep(1, 800, 500)]);
    const { meta } = buildSetEndedPayload(stored, 'device_signal');
    expect(meta.closed_by).toBe('device');
  });

  it('content payload never carries an auto_stop_cause field', () => {
    const stored = buildStored([makeRep(1, 800, 500)]);
    const { meta, content } = buildSetEndedPayload(stored, 'tool');
    expect(meta.auto_stop_cause).toBeUndefined();
    const parsed = JSON.parse(content) as { set: Record<string, unknown> };
    expect(parsed.set.auto_stop_cause).toBeUndefined();
  });
});

describe('buildSetEndedPayload — device_summary', () => {
  function buildStored(reps: Rep[]): StoredSet {
    return {
      id: 'set-ds',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:30.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: reps.map((r, i) => ({ ...r, id: `r${i}`, setId: 'set-ds', index: i })),
    };
  }

  it('flows deviceSummary into meta keys + content.device_summary block when supplied', () => {
    const stored = buildStored([makeRep(1, 800, 500), makeRep(2, 600, 400)]);
    const { meta, content } = buildSetEndedPayload(stored, 'tool', {
      repCount: 2,
      schemaVersion: 1,
    });
    expect(meta.device_rep_count).toBe('2');
    expect(meta.device_schema_version).toBe('1');
    const parsed = JSON.parse(content) as {
      device_summary?: { rep_count: number; schema_version: number };
    };
    expect(parsed.device_summary).toEqual({ rep_count: 2, schema_version: 1 });
  });

  it('omits device_summary keys + block when deviceSummary is undefined', () => {
    const stored = buildStored([makeRep(1, 800, 500)]);
    const { meta, content } = buildSetEndedPayload(stored);
    expect(meta.device_rep_count).toBeUndefined();
    expect(meta.device_schema_version).toBeUndefined();
    const parsed = JSON.parse(content) as { device_summary?: unknown };
    expect(parsed.device_summary).toBeUndefined();
  });

  it('attaches device_summary to device-signal close (cause-agnostic)', () => {
    const stored = buildStored([makeRep(1, 800, 500)]);
    const { meta, content } = buildSetEndedPayload(stored, 'device_signal', {
      repCount: 1,
      schemaVersion: 3,
    });
    // F14/F15 rewrite: event_type is unified `set_ended`; meta.closed_by
    // carries the cause.
    expect(meta.event_type).toBe('set_ended');
    expect(meta.closed_by).toBe('device');
    expect(meta.device_rep_count).toBe('1');
    expect(meta.device_schema_version).toBe('3');
    const parsed = JSON.parse(content) as {
      device_summary: { rep_count: number; schema_version: number };
    };
    expect(parsed.device_summary).toEqual({ rep_count: 1, schema_version: 3 });
  });

  it('does not break parse for pre-rewrite consumers reading only set + reps + vbt_summary', () => {
    // Backwards-compatibility shape check: the original keys must still be
    // present and structurally identical regardless of whether the new
    // device_summary block was included.
    const stored = buildStored([makeRep(1, 800, 500), makeRep(2, 600, 400)]);
    const withSummary = JSON.parse(
      buildSetEndedPayload(stored, 'tool', { repCount: 2, schemaVersion: 1 }).content,
    );
    const withoutSummary = JSON.parse(buildSetEndedPayload(stored, 'tool').content);
    expect(withSummary.summary).toBe(withoutSummary.summary);
    expect(withSummary.set).toEqual(withoutSummary.set);
    expect(withSummary.reps).toEqual(withoutSummary.reps);
    expect(withSummary.vbt_summary).toEqual(withoutSummary.vbt_summary);
  });

  it('prefers firmwareReconciledTotal over the raw set-close count for device_rep_count (bench 2026-07-01)', () => {
    const stored = buildStored([
      makeRep(1, 800, 500),
      makeRep(2, 600, 400),
      makeRep(3, 700, 450),
      makeRep(4, 650, 420),
      makeRep(5, 640, 410),
    ]);
    // Set auto-ended on rep 5: the device set-close frame reports 4 (the
    // terminal rep never fired its own 'return'); the firmware-parity pipeline
    // reconstructed the true total of 5.
    const { meta, content } = buildSetEndedPayload(
      stored,
      'device_signal',
      undefined,
      { repCount: 4, repDurationMs: 5765, targetWeightTenths: 200, schemaVersion: 1 },
      5,
    );
    // meta carries the reconciled total, not the stale frame value.
    expect(meta.device_rep_count).toBe('5');
    // The raw frame count is still echoed verbatim in content for diagnostics.
    const parsed = JSON.parse(content) as { device_set_summary: { rep_count: number } };
    expect(parsed.device_set_summary.rep_count).toBe(4);
  });

  it('falls back to the raw set-close count when no firmware total is reconstructed', () => {
    const stored = buildStored([makeRep(1, 800, 500), makeRep(2, 600, 400)]);
    const { meta } = buildSetEndedPayload(stored, 'device_signal', undefined, {
      repCount: 2,
      repDurationMs: 1000,
      targetWeightTenths: 200,
      schemaVersion: 1,
    });
    expect(meta.device_rep_count).toBe('2');
  });
});

describe('buildSettingCoercedPayload', () => {
  const baseCheck: PendingCoercionCheck = {
    setterName: 'device.set_eccentric',
    field: 'eccentricPercentTenths',
    requested: 0,
    setterReturnedAt: 1_000_000,
  };
  const device: DeviceSnapshot = {
    connected: true,
    weightLbs: 30,
    trainingMode: 'WeightTraining',
    assistMode: 2,
  };

  it('meta carries every load-bearing field as a string', () => {
    const { meta } = buildSettingCoercedPayload(baseCheck, 320, 1_000_240, device, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'setting_coerced',
      field: 'eccentricPercentTenths',
      requested_value: '0',
      device_value: '320',
      source_setter: 'device.set_eccentric',
      coercion_delta: '320',
      coercion_window_ms: '240',
      slot_id: 'primary',
    });
    expect(meta.set_id).toBeUndefined();
    expect(meta.session_id).toBeUndefined();
  });

  it('content surfaces field-specific eccentric summary', () => {
    // Original payload appended "assistMode=on enforces a non-zero ecc floor"
    // when device.assistMode === 2; that suffix was retracted 2026-05-11
    // after hardware re-validation disproved the hypothesis (vendor docs
    // describe assist as a mid-rep automated spotter, unrelated to ecc
    // setpoint — the original 320 reading was a transient mid-cascade
    // observation, not a sticky floor).
    const { content } = buildSettingCoercedPayload(baseCheck, 320, 1_000_240, device, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Device coerced ecc 0% -> 32% after device.set_eccentric.');
    expect(parsed).toMatchObject({
      field: 'eccentricPercentTenths',
      requested: 0,
      device: 320,
      delta: 320,
      source_setter: 'device.set_eccentric',
      coercion_window_ms: 240,
    });
    expect(parsed.set_context).toEqual({
      slot_id: 'primary',
      set_id: null,
      session_id: null,
      weight_lbs: 30,
      // VMCP-02.09: requested explicit; active_mode null (no cmd=0x07 byte in
      // the fixture); training_mode retained as alias.
      requested_mode: 'WeightTraining',
      active_mode: null,
      training_mode: 'WeightTraining',
    });
  });

  it('omits the assistMode-on tail when the device snapshot is assistMode off', () => {
    const offDevice: DeviceSnapshot = { ...device, assistMode: 0 };
    const { content } = buildSettingCoercedPayload(baseCheck, 320, 1_000_240, offDevice, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe('Device coerced ecc 0% -> 32% after device.set_eccentric.');
  });

  it('emits set_id + session_id meta when context is populated', () => {
    const { meta, content } = buildSettingCoercedPayload(baseCheck, 320, 1_000_240, device, {
      slotId: 'primary',
      setId: 'set-x',
      sessionId: 'sess-y',
    });
    expect(meta.set_id).toBe('set-x');
    expect(meta.session_id).toBe('sess-y');
    const parsed = JSON.parse(content);
    expect(parsed.set_context.set_id).toBe('set-x');
    expect(parsed.set_context.session_id).toBe('sess-y');
  });

  it('threads slotId into meta and set_context (VMCP-01.38)', () => {
    const { meta, content } = buildSettingCoercedPayload(baseCheck, 320, 1_000_240, device, {
      slotId: 'right',
      setId: 'set-r',
      sessionId: 'sess-r',
    });
    expect(meta.slot_id).toBe('right');
    const parsed = JSON.parse(content);
    expect(parsed.set_context.slot_id).toBe('right');
  });

  it('renders chains-specific summary in lbs', () => {
    const check: PendingCoercionCheck = {
      setterName: 'device.start_guided_load',
      field: 'chainTargetForceTenths',
      requested: 100, // 10 lbs
      setterReturnedAt: 1_000_000,
    };
    const { content } = buildSettingCoercedPayload(
      check,
      20, // 2 lbs
      1_000_500,
      device,
      { slotId: 'primary', setId: null, sessionId: null },
    );
    const parsed = JSON.parse(content);
    expect(parsed.summary).toBe(
      'Device coerced chains 10 -> 2 lbs after device.start_guided_load.',
    );
  });

  it('renders weight-specific summary in lbs', () => {
    const check: PendingCoercionCheck = {
      setterName: 'device.set_weight',
      field: 'weightLbsTenths',
      requested: 500,
      setterReturnedAt: 1_000_000,
    };
    const { content } = buildSettingCoercedPayload(check, 450, 1_000_300, device, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    expect(JSON.parse(content).summary).toBe(
      'Device coerced weight 50 -> 45 lbs after device.set_weight.',
    );
  });

  it('falls back to generic phrasing for unknown fields', () => {
    const check: PendingCoercionCheck = {
      setterName: 'device.set_isokinetic_target_speed',
      field: 'isokineticTargetSpeed',
      requested: 1000,
      setterReturnedAt: 1_000_000,
    };
    const { content } = buildSettingCoercedPayload(check, 500, 1_000_300, device, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    expect(JSON.parse(content).summary).toBe(
      'Device coerced isokineticTargetSpeed 1000 -> 500 after device.set_isokinetic_target_speed.',
    );
  });

  it('signed coercion_delta reports negative when device value is below requested', () => {
    const check: PendingCoercionCheck = {
      setterName: 'device.start_guided_load',
      field: 'chainTargetForceTenths',
      requested: 100,
      setterReturnedAt: 1_000_000,
    };
    const { meta } = buildSettingCoercedPayload(check, 20, 1_000_300, device, {
      slotId: 'primary',
      setId: null,
      sessionId: null,
    });
    expect(meta.coercion_delta).toBe('-80');
  });
});

describe('buildRestStatusPayload (VMCP-02.08)', () => {
  it('tags meta with the lifecycle attributes the channel filters on', () => {
    const { meta } = buildRestStatusPayload({
      slotId: 'primary',
      setId: 'set-abc',
      elapsedSeconds: 30,
      capSeconds: 300,
      final: false,
    });
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'rest_status',
      slot: 'primary',
      set_id: 'set-abc',
      elapsed_seconds: '30',
    });
    // Non-final emits omit the `final` attribute so meta filters can
    // target it explicitly.
    expect(meta.final).toBeUndefined();
  });

  it('flags meta.final on the terminal cap emit', () => {
    const { meta } = buildRestStatusPayload({
      slotId: 'primary',
      setId: 'set-abc',
      elapsedSeconds: 300,
      capSeconds: 300,
      final: true,
    });
    expect(meta.final).toBe('true');
  });

  it('renders the summary line + structured rest_status block in content', () => {
    const { content } = buildRestStatusPayload({
      slotId: 'right',
      setId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      elapsedSeconds: 45,
      capSeconds: 300,
      final: false,
    });
    const parsed = JSON.parse(content) as {
      summary: string;
      rest_status: {
        slot: string;
        set_id: string;
        elapsed_seconds: number;
        cap_seconds: number;
        final: boolean;
      };
    };
    // Summary mentions elapsed seconds and the truncated setId for
    // skimmability without dumping the whole UUID.
    expect(parsed.summary).toContain('45s');
    expect(parsed.summary).toContain('12345678');
    expect(parsed.rest_status).toEqual({
      slot: 'right',
      set_id: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      elapsed_seconds: 45,
      cap_seconds: 300,
      final: false,
    });
  });

  it('summary on the final cap emit signals the cap was reached', () => {
    const { content } = buildRestStatusPayload({
      slotId: 'primary',
      setId: 'set-1',
      elapsedSeconds: 300,
      capSeconds: 300,
      final: true,
    });
    const parsed = JSON.parse(content) as { summary: string };
    expect(parsed.summary.toLowerCase()).toContain('cap');
  });
});

describe('guidedLoadPhaseToOutcome (VMCP-02.03)', () => {
  it('maps each phase to its branchable outcome', () => {
    expect(guidedLoadPhaseToOutcome('idle')).toBe('pending');
    expect(guidedLoadPhaseToOutcome('armed')).toBe('pending');
    expect(guidedLoadPhaseToOutcome('countdown')).toBe('pending');
    expect(guidedLoadPhaseToOutcome('engaging')).toBe('pending');
    expect(guidedLoadPhaseToOutcome('active')).toBe('engaged');
    expect(guidedLoadPhaseToOutcome('exited')).toBe('ended');
    expect(guidedLoadPhaseToOutcome('timeout')).toBe('failed');
  });
});

describe('buildGuidedLoadStatePayload (VMCP-02.03)', () => {
  it('armed: meta carries phase/outcome/requested_target_lbs; content summary mentions the target', () => {
    const { meta, content } = buildGuidedLoadStatePayload({
      phase: 'armed',
      countdownRemainingMs: null,
      requestedTargetLbs: 95,
    });
    expect(meta.source).toBe('voltras');
    expect(meta.event_type).toBe('guided_load_state');
    expect(meta.phase).toBe('armed');
    expect(meta.outcome).toBe('pending');
    expect(meta.requested_target_lbs).toBe('95');
    expect(meta.countdown_remaining_ms).toBeUndefined();
    const parsed = JSON.parse(content) as {
      summary: string;
      guided_load: { phase: string; outcome: string; requested_target_lbs: number | null };
      set_context: unknown;
    };
    expect(parsed.summary).toContain('95 lbs');
    expect(parsed.guided_load.outcome).toBe('pending');
    expect(parsed.guided_load.requested_target_lbs).toBe(95);
    expect(parsed.set_context).toBeNull();
  });

  it('countdown: surfaces countdown_remaining_ms in meta only on the countdown phase', () => {
    const { meta, content } = buildGuidedLoadStatePayload({
      phase: 'countdown',
      countdownRemainingMs: 2500,
      requestedTargetLbs: 95,
    });
    expect(meta.countdown_remaining_ms).toBe('2500');
    const parsed = JSON.parse(content) as {
      guided_load: { countdown_remaining_ms: number | null };
    };
    expect(parsed.guided_load.countdown_remaining_ms).toBe(2500);
  });

  it('active: outcome=engaged with set_context when a set is present', () => {
    const { meta, content } = buildGuidedLoadStatePayload({
      phase: 'active',
      countdownRemainingMs: null,
      requestedTargetLbs: 110,
      setId: 'set-9',
      sessionId: 'sess-9',
    });
    expect(meta.outcome).toBe('engaged');
    expect(meta.set_id).toBe('set-9');
    expect(meta.session_id).toBe('sess-9');
    const parsed = JSON.parse(content) as {
      summary: string;
      set_context: { set_id: string; session_id: string };
    };
    expect(parsed.summary).toContain('engaged');
    expect(parsed.set_context).toEqual({ set_id: 'set-9', session_id: 'sess-9' });
  });

  it('timeout: outcome=failed and the summary tells the agent to unload + retrigger', () => {
    const { meta, content } = buildGuidedLoadStatePayload({
      phase: 'timeout',
      countdownRemainingMs: null,
      requestedTargetLbs: 95,
    });
    expect(meta.outcome).toBe('failed');
    const parsed = JSON.parse(content) as { summary: string };
    expect(parsed.summary).toContain('FAILED');
    expect(parsed.summary.toLowerCase()).toContain('device.unload');
  });

  it('omits requested_target_lbs + set context when unavailable (unit-direct guided load)', () => {
    const { meta, content } = buildGuidedLoadStatePayload({
      phase: 'exited',
      countdownRemainingMs: null,
    });
    expect(meta.outcome).toBe('ended');
    expect(meta.requested_target_lbs).toBeUndefined();
    expect(meta.set_id).toBeUndefined();
    const parsed = JSON.parse(content) as {
      guided_load: { requested_target_lbs: number | null };
      set_context: unknown;
    };
    expect(parsed.guided_load.requested_target_lbs).toBeNull();
    expect(parsed.set_context).toBeNull();
  });
});
