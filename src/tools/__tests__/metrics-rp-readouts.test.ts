// The RP-derived `metrics.compute` readouts: `session.perturbation`
// (VMCP-06.10 / B02) and `session.junk_volume` (VMCP-06.13 retrospective half),
// plus the B47 target-only set-counting pin on `session.volume` (VMCP-06.05).
//
// These pipelines are DISPLAYED metrics. The assertions below pin what they
// report, that they report it as ratios and counts rather than absolute
// velocities, and — for `interpretation` — that they decline to label a number
// no published threshold supports.

import { describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

// Stub the SDK so the static import chain (helpers -> errors -> SDK) does not
// pull in optional native peers.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { registerMetricsTools } = await import('../metrics-tools.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { FeatureGateVerdict } from '../../store/baseline-gate.js';
import type {
  BaselineState,
  StoredExerciseBaseline,
  StoredRep,
  StoredSet,
} from '../../store/types.js';
import type { ToolResult } from '../helpers.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────
//
// `peakMps` and `meanMps` are set INDEPENDENTLY: the whole point of the junk
// readout is that a peak-based loss and a mean-based loss are different
// numbers, and a fixture where they coincide could not show that.

interface RepSpec {
  romM: number;
  peakMps: number;
  meanMps: number;
}

const SAMPLES_PER_PHASE = 3;

function makePhase(spec: RepSpec, startTime: number, scale: number): Phase {
  const samples = Array.from({ length: SAMPLES_PER_PHASE }, (_, i) => ({
    sequence: i,
    timestamp: startTime + i * 50,
    phase: 1 as Phase['samples'][number]['phase'],
    position: (spec.romM * i) / (SAMPLES_PER_PHASE - 1),
    velocity: spec.peakMps * scale,
    force: 50,
  }));
  return {
    samples,
    startTime,
    endTime: startTime + SAMPLES_PER_PHASE * 50,
    startPosition: 0,
    endPosition: spec.romM,
    _totalVelocity: spec.meanMps * SAMPLES_PER_PHASE * scale,
    _totalForce: 50 * SAMPLES_PER_PHASE,
    _totalLoad: 0,
    _movementSampleCount: SAMPLES_PER_PHASE,
    _totalHoldDuration: 0,
    _lastMovementVelocity: spec.peakMps * scale,
    peakVelocity: spec.peakMps * scale,
    peakForce: 50,
    peakLoad: 0,
  };
}

function makeRep(setId: string, index: number, spec: RepSpec, scale: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: makePhase(spec, 1000 + index * 2000, scale),
    eccentric: makePhase({ ...spec, peakMps: spec.peakMps * 0.6 }, 1400 + index * 2000, scale),
  };
}

interface SetSpec {
  id: string;
  reps: RepSpec[];
  sessionId?: string;
  exerciseId?: string;
  weightLbs?: number;
  isWarmup?: boolean;
  lifter?: string;
  firmwarePeakForceLbs?: number;
  deviceNative?: boolean;
}

function makeStoredSet(spec: SetSpec): StoredSet {
  const scale = spec.deviceNative === true ? 1000 : 1;
  return {
    id: spec.id,
    sessionId: spec.sessionId ?? 'sess-1',
    startedAt: '2026-09-08T18:00:00.000Z',
    endedAt: '2026-09-08T18:00:40.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: spec.weightLbs ?? 100,
    exerciseId: spec.exerciseId ?? 'cable-row',
    velocityUnits: spec.deviceNative === true ? 'device_native' : 'meters_per_second',
    ...(spec.isWarmup === true ? { isWarmup: true } : {}),
    ...(spec.lifter !== undefined ? { lifter: spec.lifter } : {}),
    ...(spec.firmwarePeakForceLbs !== undefined
      ? { firmwarePeakForceLbs: spec.firmwarePeakForceLbs }
      : {}),
    reps: spec.reps.map((rep, i) => makeRep(spec.id, i, rep, scale)),
  };
}

/** `count` identical working reps at one mean/peak pair. */
function flatReps(count: number, meanMps: number, peakMps = meanMps * 1.4): RepSpec[] {
  return Array.from({ length: count }, () => ({ romM: 0.5, peakMps, meanMps }));
}

/** Reps whose mean and peak velocities decay INDEPENDENTLY of each other. */
function decayingReps(means: readonly number[], peaks: readonly number[]): RepSpec[] {
  return means.map((meanMps, i) => ({ romM: 0.5, peakMps: peaks[i]!, meanMps }));
}

function makeBaselineRow(state: BaselineState, exerciseId = 'cable-row'): StoredExerciseBaseline {
  return {
    id: `local|${exerciseId}`,
    userId: 'local',
    exerciseId,
    state,
    confidence: state === 'COLD' ? 0.1 : 0.6,
    observedSessions: 4,
    anchorCount: state === 'CALIBRATED' ? 3 : 0,
    updatedAt: '2026-09-08T18:00:00.000Z',
    algorithmVersion: 'baseline@1.0.0',
  };
}

// ─── Harness ──────────────────────────────────────────────────────────────

type Handler = (args: unknown) => Promise<ToolResult>;

function makeTool(state: ServerState): Handler {
  let handler: Handler | undefined;
  const placeholder = {
    update: ({ callback }: { callback: Handler }) => {
      handler = callback;
    },
  } as unknown as RegisteredTool;
  const server = { tool: () => placeholder } as unknown as McpServer;
  registerMetricsTools(server, state, new Map([['metrics.compute', placeholder]]));
  if (!handler) throw new Error('metrics.compute was never registered');
  return handler;
}

interface StateSpec {
  sets: StoredSet[];
  baseline?: StoredExerciseBaseline;
}

function makeState(spec: StateSpec): ServerState {
  return {
    store: {
      getSet: vi.fn(async (id: string) => spec.sets.find((s) => s.id === id)),
      getSetsForSession: vi.fn(async () => spec.sets),
      getSession: vi.fn(async (id: string) => ({ id, startedAt: '2026-09-08T18:00:00.000Z' })),
      getBaseline: vi.fn(async () => spec.baseline),
    },
  } as unknown as ServerState;
}

async function invoke(state: ServerState, args: unknown): Promise<unknown> {
  const result = await makeTool(state)(args);
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

// ─── session.perturbation (VMCP-06.10) ────────────────────────────────────

interface Perturbation {
  exerciseId: string;
  workingSets: number;
  meanVelocityDropPct: number | null;
  peakForceDropPct: number | null;
  repDrop: number | null;
  gate: FeatureGateVerdict;
  interpretation: string | null;
  interpretationNote: string;
}

function perturbationOf(payload: unknown): Perturbation {
  const { exercises } = payload as { exercises: Perturbation[] };
  expect(exercises).toHaveLength(1);
  return exercises[0]!;
}

/** Three working sets: the last is 30% slower and 20% weaker than the first. */
function decayingSession(): StoredSet[] {
  return [
    makeStoredSet({ id: 'w1', reps: flatReps(10, 1.0), firmwarePeakForceLbs: 100 }),
    makeStoredSet({ id: 'w2', reps: flatReps(9, 0.85), firmwarePeakForceLbs: 92 }),
    makeStoredSet({ id: 'w3', reps: flatReps(8, 0.7), firmwarePeakForceLbs: 80 }),
  ];
}

describe('metrics.compute — session.perturbation', () => {
  it('reports first-vs-last working-set velocity, force and rep drops with the gate attached', async () => {
    const state = makeState({ sets: decayingSession(), baseline: makeBaselineRow('COLD') });

    const result = perturbationOf(
      await invoke(state, { pipeline: 'session.perturbation', sessionId: 'sess-1' }),
    );

    expect(result.workingSets).toBe(3);
    expect(result.meanVelocityDropPct).toBeCloseTo(30, 6);
    expect(result.peakForceDropPct).toBeCloseTo(20, 6);
    expect(result.repDrop).toBe(2);
    expect(result.gate.feature).toBe('relative-signal');
    expect(result.gate.observedState).toBe('COLD');
  });

  it('withholds `interpretation` at COLD — and still withholds it at PROVISIONAL, because no threshold is citable', async () => {
    const cold = perturbationOf(
      await invoke(makeState({ sets: decayingSession(), baseline: makeBaselineRow('COLD') }), {
        pipeline: 'session.perturbation',
        sessionId: 'sess-1',
      }),
    );
    const provisional = perturbationOf(
      await invoke(
        makeState({ sets: decayingSession(), baseline: makeBaselineRow('PROVISIONAL') }),
        { pipeline: 'session.perturbation', sessionId: 'sess-1' },
      ),
    );

    expect(cold.interpretation).toBeNull();
    // B02's risk note: RP gives no numbers for what separates "well perturbed"
    // from "under-stimulated" on cable hardware, and the research doc's
    // 10/20/30% figures are WITHIN-set study conventions on a different
    // quantity. Passing the gate is necessary for a label, not sufficient —
    // a citable threshold is the missing half. When one lands, this
    // expectation is the deliberate stop that forces the change.
    expect(provisional.gate.observedState).toBe('PROVISIONAL');
    expect(provisional.interpretation).toBeNull();
    expect(provisional.interpretationNote).toMatch(/no citable threshold/);
  });

  it('reads the same drop ratio off a device_native set as off its normalised twin (VW-160)', async () => {
    const native = decayingSession().map((set, i) =>
      makeStoredSet({
        id: `n${String(i)}`,
        reps: flatReps(set.reps.length, [1.0, 0.85, 0.7][i]!),
        deviceNative: true,
        ...(set.firmwarePeakForceLbs !== undefined
          ? { firmwarePeakForceLbs: set.firmwarePeakForceLbs }
          : {}),
      }),
    );

    const normalised = perturbationOf(
      await invoke(makeState({ sets: decayingSession() }), {
        pipeline: 'session.perturbation',
        sessionId: 'sess-1',
      }),
    );
    const deviceNative = perturbationOf(
      await invoke(makeState({ sets: native }), {
        pipeline: 'session.perturbation',
        sessionId: 'sess-1',
      }),
    );

    expect(deviceNative.meanVelocityDropPct).toBeCloseTo(normalised.meanVelocityDropPct!, 9);
  });

  it('excludes warm-up and guest-lifter sets from the comparison', async () => {
    const sets = [
      makeStoredSet({ id: 'warm', reps: flatReps(12, 1.6), weightLbs: 40, isWarmup: true }),
      ...decayingSession(),
      makeStoredSet({ id: 'guest', reps: flatReps(4, 0.2), lifter: 'Jordan' }),
    ];

    const result = perturbationOf(
      await invoke(makeState({ sets }), { pipeline: 'session.perturbation', sessionId: 'sess-1' }),
    );

    // The guest's very slow set would drag the drop to ~80% and the warm-up
    // would become the "first" set if either leaked in.
    expect(result.workingSets).toBe(3);
    expect(result.meanVelocityDropPct).toBeCloseTo(30, 6);
  });

  it('leaves every drop null when one working set is all there is to compare', async () => {
    const state = makeState({ sets: [makeStoredSet({ id: 'only', reps: flatReps(8, 0.9) })] });

    const result = perturbationOf(
      await invoke(state, { pipeline: 'session.perturbation', sessionId: 'sess-1' }),
    );

    expect(result.workingSets).toBe(1);
    expect(result.meanVelocityDropPct).toBeNull();
    expect(result.repDrop).toBeNull();
  });

  it('reports peakForceDropPct as null — never derived — when only one end recorded firmware force', async () => {
    const sets = [
      makeStoredSet({ id: 'a', reps: flatReps(10, 1.0), firmwarePeakForceLbs: 100 }),
      makeStoredSet({ id: 'b', reps: flatReps(8, 0.7) }),
    ];

    const result = perturbationOf(
      await invoke(makeState({ sets }), { pipeline: 'session.perturbation', sessionId: 'sess-1' }),
    );

    expect(result.peakForceDropPct).toBeNull();
    expect(result.meanVelocityDropPct).toBeCloseTo(30, 6);
  });

  it('narrows to one exercise when exerciseId is supplied, and covers every exercise when it is not', async () => {
    const sets = [
      ...decayingSession(),
      makeStoredSet({ id: 'p1', exerciseId: 'chest-press', reps: flatReps(10, 0.9) }),
      makeStoredSet({ id: 'p2', exerciseId: 'chest-press', reps: flatReps(8, 0.72) }),
    ];

    const all = (await invoke(makeState({ sets }), {
      pipeline: 'session.perturbation',
      sessionId: 'sess-1',
    })) as { exercises: Perturbation[] };
    const narrowed = perturbationOf(
      await invoke(makeState({ sets }), {
        pipeline: 'session.perturbation',
        sessionId: 'sess-1',
        exerciseId: 'chest-press',
      }),
    );

    expect(all.exercises.map((e) => e.exerciseId)).toEqual(['cable-row', 'chest-press']);
    expect(narrowed.exerciseId).toBe('chest-press');
    expect(narrowed.meanVelocityDropPct).toBeCloseTo(20, 6);
  });
});

// ─── session.junk_volume (VMCP-06.13, retrospective half) ─────────────────

interface JunkSetReading {
  setId: string;
  index: number;
  meanLossPct: number;
  peakLossPct: number;
}

interface JunkVolume {
  exerciseId: string;
  movementClassKnown: false;
  sets: JunkSetReading[];
  retrospective: { firstJunkIndex: number | null; probablyJunkSets: JunkSetReading[] } | null;
  gate: FeatureGateVerdict;
  note?: string;
}

function junkOf(payload: unknown): JunkVolume {
  const { exercises } = payload as { exercises: JunkVolume[] };
  expect(exercises).toHaveLength(1);
  return exercises[0]!;
}

/** Four working sets whose within-set MEAN losses are 10 / 18 / 27 / 31 %. */
function junkSession(): StoredSet[] {
  const peaks = [
    [1.4, 1.4, 1.3],
    [1.4, 1.38, 1.3],
    [1.4, 1.35, 1.25],
    [1.4, 1.3, 1.2],
  ];
  const means = [
    [1.0, 0.95, 0.9],
    [1.0, 0.9, 0.82],
    [1.0, 0.85, 0.73],
    [1.0, 0.85, 0.69],
  ];
  return means.map((set, i) =>
    makeStoredSet({ id: `j${String(i)}`, reps: decayingReps(set, peaks[i]!) }),
  );
}

describe('metrics.compute — session.junk_volume', () => {
  it('names the first set past the mean-based threshold and every set from there on', async () => {
    const state = makeState({ sets: junkSession(), baseline: makeBaselineRow('PROVISIONAL') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    expect(result.sets.map((s) => Math.round(s.meanLossPct))).toEqual([10, 18, 27, 31]);
    expect(result.retrospective?.firstJunkIndex).toBe(2);
    expect(result.retrospective?.probablyJunkSets).toHaveLength(2);
    expect(result.retrospective?.probablyJunkSets.map((s) => s.setId)).toEqual(['j2', 'j3']);
  });

  it('reports the peak-based loss beside the mean-based one, and they are different numbers', async () => {
    const state = makeState({ sets: junkSession(), baseline: makeBaselineRow('PROVISIONAL') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    // The whole point of the retrospective: the live watch's peak-based number
    // reads every one of these sets as far cleaner than the mean-based number
    // the 25% threshold is reasoned from.
    for (const set of result.sets) {
      expect(set.peakLossPct).toBeLessThan(set.meanLossPct);
    }
    expect(result.sets[2]!.peakLossPct).toBeCloseTo((0.15 / 1.4) * 100, 6);
  });

  it('carries the ballistic-pull caveat: movementClassKnown is false (VMCP-02.63 is not built)', async () => {
    const state = makeState({ sets: junkSession(), baseline: makeBaselineRow('PROVISIONAL') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    expect(result.movementClassKnown).toBe(false);
  });

  it('below PROVISIONAL: the losses still ship, the retrospective is null and a note says why', async () => {
    const state = makeState({ sets: junkSession(), baseline: makeBaselineRow('COLD') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    expect(result.sets).toHaveLength(4);
    expect(result.sets[3]!.meanLossPct).toBeGreaterThan(25);
    expect(result.retrospective).toBeNull();
    expect(result.note).toMatch(/not judged against the junk threshold yet/);
  });

  it('records that no set crossed as firstJunkIndex null — distinct from not having judged', async () => {
    const clean = [
      makeStoredSet({ id: 'c0', reps: decayingReps([1.0, 0.98, 0.95], [1.4, 1.4, 1.38]) }),
      makeStoredSet({ id: 'c1', reps: decayingReps([1.0, 0.95, 0.92], [1.4, 1.38, 1.35]) }),
    ];
    const state = makeState({ sets: clean, baseline: makeBaselineRow('CALIBRATED') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    expect(result.retrospective).not.toBeNull();
    expect(result.retrospective?.firstJunkIndex).toBeNull();
    expect(result.retrospective?.probablyJunkSets).toEqual([]);
  });

  it('excludes warm-up and guest-lifter sets from the working-set list', async () => {
    const sets = [
      makeStoredSet({ id: 'warm', reps: flatReps(12, 1.6), weightLbs: 40, isWarmup: true }),
      ...junkSession(),
      makeStoredSet({
        id: 'guest',
        reps: decayingReps([1.0, 0.6, 0.4], [1.4, 1.0, 0.7]),
        lifter: 'Jordan',
      }),
    ];
    const state = makeState({ sets, baseline: makeBaselineRow('PROVISIONAL') });

    const result = junkOf(
      await invoke(state, { pipeline: 'session.junk_volume', sessionId: 'sess-1' }),
    );

    expect(result.sets.map((s) => s.setId)).toEqual(['j0', 'j1', 'j2', 'j3']);
  });
});
