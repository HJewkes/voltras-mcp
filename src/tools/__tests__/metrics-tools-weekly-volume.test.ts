// `metrics.compute history.weekly_volume` (VW-144/VW-145/VW-201).
//
// Pins the tool-layer plumbing: listSessions -> getSetsForSession -> mapper
// -> getWeeklySummaries/getVolumeByMuscleGroup, using WA's REAL analytics
// functions (unmocked). Review focus per the brief:
//   1. muscle-group attribution matches `session.volume`'s B47 target-only
//      rule (muscleGroups[0]) — pinned by running both over the same sets.
//   2. guest, warmup/probe/technique, mock-adapter and zero-rep sets are all
//      excluded, one test per exclusion.
//   3. `verdict` is always `null` — no landmark, no threshold anywhere.

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
import type { StoredRep, StoredSession, StoredSet } from '../../store/types.js';
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

function makeSet(id: string, overrides: Partial<StoredSet> = {}): StoredSet {
  const startedAt = overrides.startedAt ?? weekStart(0);
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: 100,
    exerciseId: 'back-squat',
    reps: [makeRep(id, 0), makeRep(id, 1)],
    ...overrides,
  };
}

function makeSession(id: string, startedAt: string, exerciseId?: string): StoredSession {
  return { id, startedAt, ...(exerciseId !== undefined ? { exerciseId } : {}) };
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

interface MuscleCatalogEntry {
  muscleGroups: string[];
}

function makeState(
  sessions: StoredSession[],
  setsBySession: ReadonlyMap<string, StoredSet[]>,
  opts: { adapter?: string; catalog?: Record<string, MuscleCatalogEntry> } = {},
): ServerState {
  const store = {
    listSessions: vi.fn(async () => sessions),
    getSetsForSession: vi.fn(async (id: string) => setsBySession.get(id) ?? []),
  };
  const catalog = opts.catalog ?? {};
  const exercises = { getById: vi.fn((id: string) => catalog[id]) };
  const config = { adapter: opts.adapter ?? 'node' };
  return { store, exercises, config } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

interface WeeklyVolumeBody {
  weekly: { weekStart: string; sessionCount: number; totalVolumeLbs: number }[];
  byMuscleGroup: { byMuscleGroup: Record<string, number>; totalVolumeLbs: number };
  verdict: null;
}

describe('metrics.compute — history.weekly_volume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rolls up weekly totals across sessions', async () => {
    const s1 = makeSet('s1', { startedAt: weekStart(0), weightLbs: 100 });
    const s2 = makeSet('s2', { startedAt: weekStart(1), weightLbs: 150 });
    const sessions = [makeSession('sess-s1', weekStart(0)), makeSession('sess-s2', weekStart(1))];
    const setsBySession = new Map([
      ['sess-s1', [s1]],
      ['sess-s2', [s2]],
    ]);
    const state = makeState(sessions, setsBySession);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.weekly).toHaveLength(2);
    expect(body.verdict).toBeNull();
    const totalAcrossWeeks = body.weekly.reduce((sum, w) => sum + w.totalVolumeLbs, 0);
    // weight × reps, summed: 100×2 + 150×2.
    expect(totalAcrossWeeks).toBe(500);
  });

  it('no sessions in the lookback window -> NOT_FOUND', async () => {
    const state = makeState([], new Map());
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it("B47 agreement: muscle-group attribution matches session.volume's target-only rule", async () => {
    // An exercise with a PRIMARY and a SECONDARY muscle group — B47 credits
    // the primary only, at any weight. If weekly_volume's byMuscleGroup ever
    // fractions across both, this catches it.
    const set = makeSet('s1', { exerciseId: 'bench-press', weightLbs: 100 });
    const session = makeSession('sess-s1', weekStart(0), 'bench-press');
    const state = makeState([session], new Map([['sess-s1', [set]]]), {
      catalog: {
        'bench-press': { muscleGroups: ['chest', 'triceps'] },
      },
    });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    // All volume (100×2 = 200) lands on the primary muscle group only —
    // the same exerciseId->muscleGroups[0] rule `setsByTargetMuscle` uses.
    expect(body.byMuscleGroup.byMuscleGroup).toEqual({ chest: 200 });
    expect(body.byMuscleGroup.byMuscleGroup.triceps).toBeUndefined();
  });

  it("excludes a guest lifter's set", async () => {
    const owner = makeSet('s-owner', { weightLbs: 100 });
    const guest: StoredSet = makeSet('s-guest', { weightLbs: 999, lifter: 'Jordan' });
    const session = makeSession('sess-s-owner', weekStart(0));
    const guestSession = makeSession('sess-s-guest', weekStart(0));
    const state = makeState(
      [session, guestSession],
      new Map([
        ['sess-s-owner', [owner]],
        ['sess-s-guest', [guest]],
      ]),
    );
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.totalVolumeLbs).toBe(200);
  });

  it('excludes warm-up, probe and technique sets', async () => {
    const working = makeSet('s-work', { weightLbs: 100 });
    const warmup: StoredSet = makeSet('s-warm', { weightLbs: 45, setPurpose: 'warmup' });
    const probe: StoredSet = makeSet('s-probe', { weightLbs: 60, setPurpose: 'probe' });
    const technique: StoredSet = makeSet('s-tech', { weightLbs: 20, setPurpose: 'technique' });
    const session = makeSession('sess-s-work', weekStart(0));
    const state = makeState(
      [session],
      new Map([['sess-s-work', [working, warmup, probe, technique]]]),
    );
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.totalVolumeLbs).toBe(200);
  });

  it('excludes mock-adapter sets when the server itself runs on the node adapter', async () => {
    const real = makeSet('s-real', { weightLbs: 100 });
    const mock: StoredSet = makeSet('s-mock', { weightLbs: 999, source: 'mock' });
    const session = makeSession('sess-s-real', weekStart(0));
    const state = makeState([session], new Map([['sess-s-real', [real, mock]]]), {
      adapter: 'node',
    });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.totalVolumeLbs).toBe(200);
  });

  it('keeps mock-adapter sets when the whole process runs on the mock adapter', async () => {
    const mock: StoredSet = makeSet('s-mock', { weightLbs: 100, source: 'mock' });
    const session = makeSession('sess-s-mock', weekStart(0));
    const state = makeState([session], new Map([['sess-s-mock', [mock]]]), { adapter: 'mock' });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.totalVolumeLbs).toBe(200);
  });

  it('excludes zero-rep sets', async () => {
    const real = makeSet('s-real', { weightLbs: 100 });
    const zeroRep: StoredSet = makeSet('s-zero', { weightLbs: 999, reps: [] });
    const session = makeSession('sess-s-real', weekStart(0));
    const state = makeState([session], new Map([['sess-s-real', [real, zeroRep]]]));
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.totalVolumeLbs).toBe(200);
    // The zero-rep set's 999lbs must never surface as a week's top weight.
    expect(body.weekly[0]?.totalVolumeLbs).toBe(200);
  });

  it('splits a multi-exercise session across muscle groups by set, not by session', async () => {
    // One physical session, two exercises — chest press then rows, e.g. a
    // real upper-body day. weekly_volume must not attribute the rows' volume
    // to the chest-press exercise just because they share a session id.
    const press = makeSet('s-press', { exerciseId: 'chest-press', weightLbs: 100 });
    const row = makeSet('s-row', { exerciseId: 'seated-row', weightLbs: 150 });
    const session = makeSession('sess-multi', weekStart(0), 'chest-press');
    const state = makeState([session], new Map([['sess-multi', [press, row]]]), {
      catalog: {
        'chest-press': { muscleGroups: ['chest'] },
        'seated-row': { muscleGroups: ['back'] },
      },
    });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.byMuscleGroup.byMuscleGroup).toEqual({ chest: 200, back: 300 });
    // One physical session either way — sessionCount is not inflated by the
    // per-exercise split used for the muscle-group breakdown.
    expect(body.weekly[0]?.sessionCount).toBe(1);
  });
});
