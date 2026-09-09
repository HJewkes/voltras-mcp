// `metrics.compute quality.rom` — VW-93 / B09 wiring.
//
// The within-set math (`readRomIntegrity`) is unit-tested in
// `src/analytics/__tests__/rom-integrity.test.ts`; this file pins the
// tool-layer plumbing and, above all, the three ways the CROSS-SESSION number
// refuses to be computed: a baseline below PROVISIONAL, B15's drift guard
// calling the comparison incomparable, and a position-scale mismatch between
// the rows being compared.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '@voltras/workout-analytics';
import type { Phase } from '@voltras/workout-analytics';

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
import type {
  BaselineState,
  ExerciseSetsFilter,
  StoredExerciseBaseline,
  StoredRep,
  StoredSet,
} from '../../store/types.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { ToolResult } from '../helpers.js';

const EXERCISE_ID = 'cable-row';

// `movementClassForExerciseId` reads the analytics catalog, which is empty
// until something seeds it. Seeded here so `movementClass` is a real lookup.
beforeEach(() => {
  (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(SEED_CABLE_EXERCISES);
});

function makePhase(rom: number): Phase {
  return {
    samples: [0, rom].map((position, i) => ({
      sequence: i,
      timestamp: i * 25,
      phase: 0,
      position,
      velocity: 0.8,
      force: 50,
    })) as Phase['samples'],
    startTime: 0,
    endTime: 25,
    startPosition: 0,
    endPosition: rom,
    _totalVelocity: 1.6,
    _totalForce: 100,
    _totalLoad: 0,
    _movementSampleCount: 2,
    _totalHoldDuration: 0,
    peakVelocity: 0.8,
    peakForce: 50,
    peakLoad: 0,
  };
}

function makeRep(setId: string, index: number, rom: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: makePhase(rom),
    eccentric: makePhase(rom),
  };
}

function makeSet(id: string, roms: number[], overrides: Partial<StoredSet> = {}): StoredSet {
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:30.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 100,
    exerciseId: EXERCISE_ID,
    positionUnits: 'meters',
    reps: roms.map((rom, i) => makeRep(id, i, rom)),
    ...overrides,
  };
}

function makeBaseline(state: BaselineState): StoredExerciseBaseline {
  return {
    id: `local:${EXERCISE_ID}`,
    userId: 'local',
    exerciseId: EXERCISE_ID,
    state,
    observedSessions: 4,
    anchorCount: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: 'test',
  };
}

interface RegisteredHandler {
  callback: (args: unknown, extra?: unknown) => Promise<ToolResult>;
}

function makeFakeServer(): { server: McpServer; tools: Map<string, RegisteredHandler> } {
  const tools = new Map<string, RegisteredHandler>();
  const server = {
    tool: (name: string, _schema: unknown, callback: RegisteredHandler['callback']) => {
      const reg: RegisteredTool = {
        update: ({ callback: cb }: { callback: RegisteredHandler['callback'] }) => {
          tools.set(name, { callback: cb });
        },
      } as unknown as RegisteredTool;
      tools.set(name, { callback });
      return reg;
    },
  } as unknown as McpServer;
  return { server, tools };
}

function makePlaceholders(server: McpServer): Map<string, RegisteredTool> {
  const m = new Map<string, RegisteredTool>();
  const cb = (): ToolResult => ({ content: [{ type: 'text', text: '{}' }], isError: true });
  m.set('metrics.compute', server.tool('metrics.compute', cb));
  return m;
}

interface StoreFixture {
  target?: StoredSet;
  history?: StoredSet[];
  baseline?: StoredExerciseBaseline;
}

function makeState({ target, history = [], baseline }: StoreFixture): ServerState {
  const all = target === undefined ? history : [target, ...history];
  const store = {
    getSet: vi.fn(async (id: string) => (target?.id === id ? target : undefined)),
    getSetsForExercise: vi.fn(async (_filter: ExerciseSetsFilter) => history),
    // `checkDriftGuard` and `summarizeSessionForDrift` read whole sessions and
    // apply the repo's own warm-up/side eligibility to what comes back.
    getSetsForSession: vi.fn(async (id: string) => all.filter((s) => s.sessionId === id)),
    getBaseline: vi.fn(async () => baseline),
  };
  return { store, exercises: { getById: vi.fn(() => undefined) } } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

interface RomPayload {
  setId: string;
  movementClass: string;
  eligibleRepCount: number;
  perRep: { repNumber: number; romFractionOfSetMedian: number | null; eligible: boolean }[];
  decay: { lastOverFirstEligible: number | null; verdict: string | null; citation: string | null };
  variance: { cv: number | null; verdict: string | null; citation: string | null };
  baseline: {
    gate: { observedState: string | null; userMessage: string };
    romVsBaselinePct: number | null;
    driftGuard: { comparable: boolean; romDriftPct: number } | null;
    note?: string;
  };
}

async function readRom(fixture: StoreFixture, setId = 'set-1'): Promise<RomPayload> {
  const state = makeState(fixture);
  const { server, tools } = makeFakeServer();
  registerMetricsTools(server, state, makePlaceholders(server));
  const result = await callTool(tools, { pipeline: 'quality.rom', setId });
  return JSON.parse(result.content[0].text) as RomPayload;
}

describe('metrics.compute — quality.rom within-set half', () => {
  it('returns per-rep fractions, the decay ratio and the CV for a shrinking set', async () => {
    const payload = await readRom({ target: makeSet('set-1', [0.5, 0.46, 0.42, 0.35]) });

    expect(payload.setId).toBe('set-1');
    expect(payload.movementClass).toBe('pull');
    expect(payload.eligibleRepCount).toBe(4);
    expect(payload.perRep).toHaveLength(4);
    expect(payload.decay.lastOverFirstEligible).toBeCloseTo(0.7, 10);
    expect(payload.decay.verdict).toBe('shrinking');
    expect(payload.decay.citation).toContain('DEFAULT_PARTIAL_REP_SCHEME');
    expect(payload.variance.citation).toContain('DEFAULT_CONSISTENCY_SCHEME');
  });

  it('excludes an opening positioning pull from the statistics but still reports it', async () => {
    const set = makeSet('set-1', [0.5, 0.5, 0.5]);
    // Rep 1 becomes the pull: twice the ROM and twice the velocity of the rest.
    set.reps[0] = makeRep('set-1', 0, 1.0);
    set.reps[0].concentric.peakVelocity = 1.6;

    const payload = await readRom({ target: set });

    expect(payload.eligibleRepCount).toBe(2);
    expect(payload.perRep.map((r) => r.eligible)).toEqual([false, true, true]);
    expect(payload.perRep[0]?.romFractionOfSetMedian).toBeCloseTo(2, 10);
    expect(payload.decay.lastOverFirstEligible).toBeCloseTo(1, 10);
  });

  it('answers with numbers and a null baseline on a first-ever session', async () => {
    const payload = await readRom({ target: makeSet('set-1', [0.5, 0.5, 0.45]) });

    expect(payload.decay.lastOverFirstEligible).toBeCloseTo(0.9, 10);
    expect(payload.baseline.romVsBaselinePct).toBeNull();
    expect(payload.baseline.gate.observedState).toBeNull();
  });
});

describe('metrics.compute — quality.rom baseline gating', () => {
  // Four reps a side is B15's own floor for a confident read
  // (`DRIFT_GUARD_THRESHOLDS.minRepsForConfidentRead`); below it the guard
  // flags but never blocks, which would mask the refusals under test.
  const STEADY = [0.5, 0.5, 0.5, 0.5];
  const history = [
    makeSet('hist-1', STEADY, { sessionId: 'sess-old-1', startedAt: '2026-01-01T00:00:00.000Z' }),
    makeSet('hist-2', STEADY, { sessionId: 'sess-old-2', startedAt: '2026-02-01T00:00:00.000Z' }),
  ];

  it('withholds the comparison with the gate message below PROVISIONAL', async () => {
    const payload = await readRom({
      target: makeSet('set-1', STEADY),
      history,
      baseline: makeBaseline('COLD'),
    });

    expect(payload.baseline.romVsBaselinePct).toBeNull();
    expect(payload.baseline.driftGuard).toBeNull();
    expect(payload.baseline.note).toContain(payload.baseline.gate.userMessage);
    // The within-set numbers are measurements and ship at every tier.
    expect(payload.decay.lastOverFirstEligible).toBeCloseTo(1, 10);
  });

  it('compares against the exercise baseline from PROVISIONAL upward', async () => {
    const payload = await readRom({
      target: makeSet('set-1', [0.45, 0.45, 0.45, 0.45]),
      history,
      baseline: makeBaseline('PROVISIONAL'),
    });

    expect(payload.baseline.driftGuard?.comparable).toBe(true);
    expect(payload.baseline.romVsBaselinePct).toBeCloseTo(-10, 10);
  });

  it('takes the most recent prior session as the reference, not an older one', async () => {
    const payload = await readRom({
      target: makeSet('set-1', STEADY, { startedAt: '2026-03-01T00:00:00.000Z' }),
      history: [
        makeSet('hist-old', [0.4, 0.4, 0.4, 0.4], {
          sessionId: 'sess-old-1',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        makeSet('hist-recent', STEADY, {
          sessionId: 'sess-old-2',
          startedAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
      baseline: makeBaseline('CALIBRATED'),
    });

    // Against the recent session (0.5) this set is unchanged; against the older
    // one (0.4) it would read +25%.
    expect(payload.baseline.romVsBaselinePct).toBeCloseTo(0, 10);
  });

  it('refuses the comparison when B15 calls the two incomparable', async () => {
    // A 40% shorter set is past the drift guard's flagged band, which is what a
    // seat or attachment change looks like — not evidence of lost technique.
    const payload = await readRom({
      target: makeSet('set-1', [0.3, 0.3, 0.3, 0.3]),
      history,
      baseline: makeBaseline('CALIBRATED'),
    });

    expect(payload.baseline.driftGuard?.comparable).toBe(false);
    expect(payload.baseline.romVsBaselinePct).toBeNull();
    expect(payload.baseline.note).toContain('too different to compare');
  });

  it('refuses the comparison when the compared rows use different position scales', async () => {
    const payload = await readRom({
      target: makeSet('set-1', STEADY, { positionUnits: 'device_native' }),
      history,
      baseline: makeBaseline('CALIBRATED'),
    });

    expect(payload.baseline.romVsBaselinePct).toBeNull();
    expect(payload.baseline.note).toContain('no prior working set');
  });

  it("refuses to grade a guest's set against the owner's history", async () => {
    const payload = await readRom({
      target: makeSet('set-1', STEADY, { lifter: 'jordan' }),
      history,
      baseline: makeBaseline('CALIBRATED'),
    });

    expect(payload.baseline.romVsBaselinePct).toBeNull();
    expect(payload.baseline.note).toContain('jordan');
  });
});

describe('metrics.compute — quality.rom errors', () => {
  it('EC-07: returns NOT_FOUND for a missing set', async () => {
    const state = makeState({});
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'quality.rom', setId: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NOT_FOUND');
  });
});
