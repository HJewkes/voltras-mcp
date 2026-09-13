// `metrics.compute history.trend` (VW-144/VW-145).
//
// Pins the tool-layer plumbing: fetch -> mapper -> buildTimeSeries ->
// analyzeTrend/detectPlateau, using WA's REAL analytics functions (unmocked)
// against fixtures built to produce known directions.
//
// VW-150 adds the diet-phase readout: `plateau.phase` names the OBSERVED phase
// covering the plateau window. Its tests deep-equal the WHOLE verdict with only
// `phase` stripped, so every other `PlateauDetection` field — present or future
// — must match with and without a declared phase. The phase qualifies a
// reading, and B34 states no correction to apply.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { StoredDietPhase, StoredRep, StoredSet } from '../../store/types.js';
import { covers } from '../../store/diet-phase.js';
import type { ToolResult } from '../helpers.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 1,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0.5,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE },
    eccentric: { ...EMPTY_PHASE },
  };
}

/** Monday-anchored ISO timestamp, `n` weeks after 2026-07-06 (a Monday). */
function weekStart(n: number): string {
  const ms = Date.parse('2026-07-06T12:00:00.000Z') + n * 7 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function makeSet(id: string, weekIndex: number, weightLbs: number): StoredSet {
  const startedAt = weekStart(weekIndex);
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs,
    exerciseId: 'back-squat',
    reps: [makeRep(id, 0), makeRep(id, 1)],
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

function makeState(sets: StoredSet[], phase?: StoredDietPhase): ServerState {
  const store = {
    getSetsForExercise: vi.fn(async () => sets),
    // VW-150: `history.trend` reports the phase covering the plateau window.
    // Absent by default — the answer for a lifter who never declared one.
    getDietPhaseCovering: vi.fn(async (_userId: string, from: string, to: string) =>
      phase !== undefined && covers(phase, from, to) ? phase : undefined,
    ),
  };
  return { store, exercises: { getById: vi.fn(() => undefined) } } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

interface PlateauBody {
  isPlateau: boolean;
  plateauDays: number;
  varianceThresholdPct: number;
  reasoning: string;
  phase: string;
  verdict: 'plateau' | 'tolerated' | 'none';
  dietPhaseContext: { phase: string; weeksInPhase: number | null; toleranceApplied: boolean };
}

interface HistoryTrendBody {
  series: { ts: string; value: number }[];
  trend: { direction: null; directionReason: string; slope: number; slopeUnit: string };
  plateau: PlateauBody;
  band: { fitFor: string; method: string; seePct: number | null; note: string } | null;
}

describe('metrics.compute — history.trend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('8 weeks of rising top load -> positive slope, null direction, no plateau', async () => {
    // 20% week-over-week growth: steep enough that no trailing run of
    // consecutive weeks stays within detectPlateau's default 5% band, so the
    // rise itself never reads as a plateau.
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 100 * 1.2 ** i));
    const state = makeState(sets);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    expect(body.series).toHaveLength(8);
    expect(body.trend.slope).toBeGreaterThan(0);
    expect(body.trend.direction).toBeNull();
    expect(body.plateau.isPlateau).toBe(false);
    expect(body.plateau.phase).toBe('unknown');
  });

  it('6 flat weeks -> plateau with WA defaults (thresholdPct/minDays omitted)', async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));
    const state = makeState(sets);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    expect(body.trend.slope).toBe(0);
    expect(body.trend.direction).toBeNull();
    expect(body.plateau.isPlateau).toBe(true);
    expect(body.plateau.phase).toBe('unknown');
  });

  it('no working sets in the lookback window -> NOT_FOUND', async () => {
    const state = makeState([]);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('excludes warm-ups and guests via the mapper before building the series', async () => {
    const working = makeSet('s-work', 0, 135);
    const warmup: StoredSet = { ...makeSet('s-warm', 0, 45), setPurpose: 'warmup' };
    const guest: StoredSet = { ...makeSet('s-guest', 0, 200), lifter: 'Jordan' };
    const state = makeState([working, warmup, guest]);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    // One week's worth of data, from the single surviving working set.
    expect(body.series).toEqual([{ ts: expect.any(String), value: 135 }]);
  });
});

describe('metrics.compute — history.trend direction (VW-230)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function trendFor(sets: StoredSet[], metric?: string): Promise<HistoryTrendBody> {
    const state = makeState(sets);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    const result = await callTool(tools, {
      pipeline: 'history.trend',
      exerciseId: 'back-squat',
      ...(metric !== undefined ? { metric } : {}),
    });
    expect(result.isError).toBeUndefined();
    return parsePayload(result) as HistoryTrendBody;
  }

  for (const metric of ['topLoad', 'e1rm', 'volume']) {
    it(`${metric}: reports a numeric slope with its unit and a null direction`, async () => {
      const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 100 + 5 * i));

      const body = await trendFor(sets, metric);

      expect(typeof body.trend.slope).toBe('number');
      expect(Number.isFinite(body.trend.slope)).toBe(true);
      expect(body.trend.direction).toBeNull();
      expect(body.trend.slopeUnit).toMatch(/\/day$/);
      expect(body.trend.directionReason).toEqual(expect.any(String));
      expect(body.trend.directionReason.length).toBeGreaterThan(0);
    });
  }

  it('attaches the trend-only e1RM band to an e1rm series, and to no other metric', async () => {
    // Arrange: the same six weeks read three ways.
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 100 + 5 * i));

    // Act.
    const [topLoad, e1rm, volume] = await Promise.all([
      trendFor(sets, 'topLoad'),
      trendFor(sets, 'e1rm'),
      trendFor(sets, 'volume'),
    ]);

    // Assert: VW-267. The series is Epley-derived, so the pooled
    // load-velocity figure is withheld and the note says why.
    expect(e1rm.band).toMatchObject({ fitFor: 'trend', method: 'reps', seePct: null });
    expect(e1rm.band?.note).toContain('Epley');
    expect(topLoad.band).toBeNull();
    expect(volume.band).toBeNull();
  });

  it('withholds direction on a rise too small for any load threshold to mean anything', async () => {
    // A top weight creeping one pound per YEAR. The velocity-derived flat band
    // called this "up"; there is no load band that can call it anything.
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 135 + i * (7 / 365)));

    const body = await trendFor(sets);

    expect(body.trend.slope).toBeCloseTo(1 / 365, 6);
    expect(body.trend.direction).toBeNull();
    expect(body.trend.directionReason).toContain('velocity');
  });
});

describe('metrics.compute — history.trend diet phase (VW-150)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function phase(startedAt: string, endedAt?: string): StoredDietPhase {
    return {
      id: 'dp-1',
      userId: 'local',
      phase: 'fat-loss',
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      declaredAt: '2026-09-08T00:00:00.000Z',
    };
  }

  async function trendWith(
    sets: StoredSet[],
    declared?: StoredDietPhase,
  ): Promise<HistoryTrendBody> {
    const state = makeState(sets, declared);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });
    expect(result.isError).toBeUndefined();
    return parsePayload(result) as HistoryTrendBody;
  }

  it("reports the phase covering the plateau window and leaves WA's own reading alone", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    const withoutPhase = await trendWith(sets);
    const withPhase = await trendWith(sets, phase('2026-01-01T00:00:00.000Z'));

    expect(withPhase.plateau.phase).toBe('fat-loss');
    // VW-277 supersedes VW-150's "the phase changes nothing" clause for
    // `verdict` only. `detectPlateau`'s OWN reading is still untouched by the
    // phase — compared as a whole object with only this server's own three
    // fields removed, so whichever field WA adds to `PlateauDetection` next is
    // still covered.
    const waOwn = ({ phase: _p, verdict: _v, dietPhaseContext: _c, ...rest }: PlateauBody) => rest;
    expect(waOwn(withPhase.plateau)).toEqual(waOwn(withoutPhase.plateau));
    expect(withPhase.plateau.isPlateau).toBe(true);
    expect(withPhase.trend).toEqual(withoutPhase.trend);
    expect(withPhase.series).toEqual(withoutPhase.series);
  });

  it("reports 'unknown' when the phase only covers part of the plateau window", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    // Declared after the plateau run began, so no single phase covers it.
    const body = await trendWith(sets, phase('2026-08-01T00:00:00.000Z'));

    expect(body.plateau.phase).toBe('unknown');
  });

  it("reports 'unknown' when no phase is declared at all", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    expect((await trendWith(sets)).plateau.phase).toBe('unknown');
  });

  it('reports the phase at the last point when there is no plateau', async () => {
    // plateauDays is 0 here, which collapses the window to the final point —
    // the series still happened inside a declared phase.
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 100 * 1.2 ** i));

    const body = await trendWith(sets, phase('2026-01-01T00:00:00.000Z'));

    expect(body.plateau.isPlateau).toBe(false);
    expect(body.plateau.phase).toBe('fat-loss');
  });

  it("reports 'unknown' when the covering range ended before the window", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    const body = await trendWith(
      sets,
      phase('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    );

    expect(body.plateau.phase).toBe('unknown');
  });
});

// VW-277: the plateau verdict this server owns, after the diet-phase tolerance.
// `minDays: 30` against the six-week fixture puts the run just past the
// detector's own floor, which is where the widening decides the answer.
describe('metrics.compute — history.trend plateau tolerance (VW-277)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function declared(phase: string): StoredDietPhase {
    return {
      id: 'dp-1',
      userId: 'local',
      phase,
      startedAt: '2026-01-01T00:00:00.000Z',
      declaredAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async function plateauWith(phase?: StoredDietPhase): Promise<PlateauBody> {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));
    const state = makeState(sets, phase);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    const result = await callTool(tools, {
      pipeline: 'history.trend',
      exerciseId: 'back-squat',
      minDays: 30,
    });
    expect(result.isError).toBeUndefined();
    return (parsePayload(result) as HistoryTrendBody).plateau;
  }

  it('calls a flat run a plateau when no phase is declared', async () => {
    const plateau = await plateauWith();

    expect(plateau.isPlateau).toBe(true);
    expect(plateau.verdict).toBe('plateau');
    expect(plateau.dietPhaseContext).toEqual({
      phase: 'unknown',
      weeksInPhase: null,
      toleranceApplied: false,
    });
  });

  it('tolerates the same run in a long fat-loss phase', async () => {
    const plateau = await plateauWith(declared('fat-loss'));

    // WA's own boolean is untouched; only this server's verdict moved.
    expect(plateau.isPlateau).toBe(true);
    expect(plateau.verdict).toBe('tolerated');
    expect(plateau.dietPhaseContext.toleranceApplied).toBe(true);
    expect(plateau.dietPhaseContext.weeksInPhase).toBeGreaterThan(8);
  });

  it('still calls it a plateau in a gain phase', async () => {
    const plateau = await plateauWith(declared('gain'));

    expect(plateau.verdict).toBe('plateau');
  });

  it('still calls it a plateau at maintenance', async () => {
    const plateau = await plateauWith(declared('maintenance'));

    expect(plateau.verdict).toBe('plateau');
    expect(plateau.dietPhaseContext.toleranceApplied).toBe(false);
  });

  // The asymmetry: a tightened band raises the advice the table reports, but it
  // never manufactures a finding `detectPlateau` declined to make.
  it('never invents a plateau in a gain phase when the detector found none', async () => {
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 100 * 1.2 ** i));
    const state = makeState(sets, declared('gain'));
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    const { plateau } = parsePayload(result) as HistoryTrendBody;
    expect(plateau.isPlateau).toBe(false);
    expect(plateau.verdict).toBe('none');
    expect(plateau.dietPhaseContext.phase).toBe('gain');
  });
});
