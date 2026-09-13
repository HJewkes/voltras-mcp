// Contract test for `metrics.compute fatigue.verdict` (VW-313): the MCP
// pipeline must return the exact same verdict the SPA's live fatigue card
// renders (`dashboard/spa/panels/fatigue-view.ts`) for the same underlying
// reps — a cheat-rep set (ROM alarm overriding clean velocity) and a plain
// "good" set. Both sides run REAL `@voltras/workout-analytics` reps (no
// mocked analytics), so this pins actual output equality, not just plumbing.

import { describe, expect, it, vi } from 'vitest';
import {
  addSampleToSet,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

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
const { mapStoreToFatigueModel } = await import('../../dashboard/spa/panels/fatigue-view.js');
const { initialAccumulatorState } = await import('../../dashboard/spa/adapter.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredSet } from '../../store/types.js';
import type { ToolResult } from '../helpers.js';
import type { Snapshot } from '../../dashboard/spa/adapter.js';
import type { LiveViewSources } from '../../dashboard/spa/panels/live-view.js';

// --- Real-rep fixture builder (same shape as spa-fatigue-view.test.ts) -----

interface RepSpec {
  concVel: number;
  rom: number;
  eccVel?: number;
  concMs?: number;
}

const MM_PER_M = 1000;
const mmToM = (mm: number): number => mm / MM_PER_M;
const mmsToMps = (mms: number): number => mms / MM_PER_M;

function repSamples(spec: RepSpec, seq: number, t0: number): WorkoutSample[] {
  const { concVel, rom, eccVel = concVel * 0.5, concMs = 500 } = spec;
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: mmsToMps(concVel),
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + concMs,
      phase: MovementPhase.CONCENTRIC,
      position: mmToM(rom),
      velocity: mmsToMps(concVel),
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + concMs + 100,
      phase: MovementPhase.ECCENTRIC,
      position: mmToM(rom),
      velocity: mmsToMps(eccVel),
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + concMs + 1100,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: mmsToMps(eccVel),
      force: 80,
    },
  ];
}

/** Real WA reps, already in the m/s + metres scale a StoredSet with no unit marker carries. */
function buildReps(specs: RepSpec[]): Rep[] {
  let set = createSet();
  let seq = 0;
  let t = 1000;
  for (const spec of specs) {
    for (const sample of repSamples(spec, seq, t)) set = addSampleToSet(set, sample);
    seq += 4;
    t += (spec.concMs ?? 500) + 1500;
  }
  return [...set.reps];
}

// --- SPA-side: the live fatigue card's own mapper ---------------------------

function snapshotWithActive(reps: Rep[]): Snapshot {
  return {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [],
    sets: { active: { reps }, completed: [] },
  };
}

function sources(over: Partial<LiveViewSources> = {}): LiveViewSources {
  return {
    snapshot: null,
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
    ...over,
  } as LiveViewSources;
}

function spaVerdict(reps: Rep[]): unknown {
  const model = mapStoreToFatigueModel(sources({ snapshot: snapshotWithActive(reps) }));
  return model?.verdict ?? null;
}

// --- MCP-side: metrics.compute fatigue.verdict ------------------------------

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

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

function makeStoredSet(reps: Rep[]): StoredSet {
  return {
    id: 'set-x',
    sessionId: 'sess-1',
    startedAt: '2026-09-08T00:00:00.000Z',
    endedAt: '2026-09-08T00:02:00.000Z',
    partial: false,
    weightLbs: 100,
    exerciseId: 'cable-row',
    reps: reps as StoredSet['reps'],
  } as StoredSet;
}

async function mcpVerdict(reps: Rep[]): Promise<unknown> {
  const set = makeStoredSet(reps);
  const state = {
    store: { getSet: async (id: string) => (id === set.id ? set : undefined) },
  } as unknown as ServerState;
  const { server, tools } = makeFakeServer();
  registerMetricsTools(server, state, makePlaceholders(server));
  const result = await callTool(tools, { pipeline: 'fatigue.verdict', setId: set.id });
  return parsePayload(result);
}

// --- Contract --------------------------------------------------------------

describe('fatigue.verdict — SPA/MCP parity (VW-313)', () => {
  it('a cheat-rep set (clean velocity, ROM cut on the last rep) — form-breakdown on both sides', async () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 60 },
    ]);

    const expected = spaVerdict(reps);
    expect(expected).toEqual({
      state: 'form-breakdown',
      tone: 'alarm',
      dimensions: { velocityLoss: 'ok', rom: 'alarm', tempo: 'ok' },
    });
    expect(await mcpVerdict(reps)).toEqual(expected);
  });

  it('a plain good set — the SPA and MCP verdicts agree', async () => {
    const reps = buildReps([
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
      { concVel: 500, rom: 100 },
    ]);

    const expected = spaVerdict(reps);
    expect(expected).toEqual({
      state: 'good',
      tone: 'ok',
      dimensions: { velocityLoss: 'ok', rom: 'ok', tempo: 'ok' },
    });
    expect(await mcpVerdict(reps)).toEqual(expected);
  });
});
