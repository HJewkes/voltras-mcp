// Unit tests for src/tools/baseline-tools.ts (I5 / B56 + the B57 gate block).
//
// The handlers are thin: build the key, read the row, grade it. What is worth
// testing is that the never-computed case survives to the wire as `null`
// rather than being coalesced to COLD, that the gate verdicts ride along, and
// that `baselines.recalc` was NOT given the same treatment (a forced recalc
// answers "what is the row now", not "what may I say").

import { describe, expect, it, vi } from 'vitest';
import type { BaselineKey } from '@voltras/workout-analytics';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { FeatureGateVerdict, GatedFeature } from '../../store/baseline-gate.js';
import { LOCAL_USER_ID, type StoredExerciseBaseline } from '../../store/types.js';
import { registerBaselineTools } from '../baseline-tools.js';

type ToolResult = { content: { text: string }[]; isError?: boolean };

interface GetBaselineBody {
  baseline: StoredExerciseBaseline | null;
  summaryMessage: string;
  gates: Record<GatedFeature, FeatureGateVerdict>;
}

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<ToolResult>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<ToolResult> }): void;
}

function makeBaseline(overrides: Partial<StoredExerciseBaseline> = {}): StoredExerciseBaseline {
  return {
    id: 'local|bench-press',
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    state: 'CALIBRATED',
    confidence: 0.88,
    observedSessions: 5,
    anchorCount: 3,
    updatedAt: '2026-07-01T00:00:00.000Z',
    algorithmVersion: 'baseline@1.0.0',
    ...overrides,
  };
}

interface Harness {
  getBaseline: ReturnType<typeof vi.fn>;
  recalcBaseline: ReturnType<typeof vi.fn>;
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
}

function setup(row: StoredExerciseBaseline | undefined): Harness {
  const getBaseline = vi.fn(async () => row);
  const recalcBaseline = vi.fn(async () => makeBaseline({ state: 'PROVISIONAL' }));
  const state = { store: { getBaseline, recalcBaseline } } as unknown as ServerState;

  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of ['baselines.get', 'baselines.recalc']) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }

  registerBaselineTools(
    undefined as unknown as McpServer,
    state,
    placeholders as unknown as { get(name: string): RegisteredTool | undefined },
  );

  return {
    getBaseline,
    recalcBaseline,
    invoke: async (name, args) => {
      const tool = placeholders.get(name);
      if (!tool?.callback) throw new Error(`no callback installed for ${name}`);
      return tool.callback(args);
    },
  };
}

function parse<T>(r: ToolResult): T {
  return JSON.parse(r.content[0].text) as T;
}

describe('baselines.get', () => {
  it('answers null with an all-withheld gate block when the key was never computed', async () => {
    // Arrange
    const h = setup(undefined);

    // Act
    const r = await h.invoke('baselines.get', { exerciseId: 'bench-press' });

    // Assert
    expect(r.isError).toBeUndefined();
    const body = parse<GetBaselineBody>(r);
    expect(body.baseline).toBeNull();
    expect(body.summaryMessage).toBe('still learning this exercise — no baseline yet');
    expect(body.gates['relative-signal'].activation).toBe('withheld');
    expect(body.gates['readiness-score'].activation).toBe('withheld');
    expect(body.gates['rir-estimate'].activation).toBe('withheld');
    expect(body.gates['rir-estimate'].evaluable).toBe(false);
  });

  it('activates every feature and says so plainly for a CALIBRATED row', async () => {
    // Arrange
    const row = makeBaseline();
    const h = setup(row);

    // Act
    const body = parse<GetBaselineBody>(await h.invoke('baselines.get', { exerciseId: 'bench' }));

    // Assert
    expect(body.baseline?.state).toBe('CALIBRATED');
    expect(body.summaryMessage).toBe('baseline calibrated');
    for (const feature of ['relative-signal', 'readiness-score', 'rir-estimate'] as const) {
      expect(body.gates[feature].activation).toBe('full');
      expect(body.gates[feature].confidence).toBe(0.88);
    }
  });

  it('passes an explicit side through to the store key', async () => {
    // Arrange
    const h = setup(makeBaseline({ side: 'left' }));

    // Act
    await h.invoke('baselines.get', { exerciseId: 'bench-press', side: 'left' });

    // Assert
    const key = h.getBaseline.mock.calls[0]?.[0] as BaselineKey;
    expect(key).toEqual({ userId: LOCAL_USER_ID, exerciseId: 'bench-press', side: 'left' });
  });

  it('omits side entirely when none was named, so the pooled row is read', async () => {
    // Arrange
    const h = setup(makeBaseline());

    // Act
    await h.invoke('baselines.get', { exerciseId: 'bench-press' });

    // Assert
    const key = h.getBaseline.mock.calls[0]?.[0] as BaselineKey;
    expect(key).toEqual({ userId: LOCAL_USER_ID, exerciseId: 'bench-press' });
  });
});

describe('baselines.recalc', () => {
  it('returns the freshly written row alone — no gates, no summary', async () => {
    // Arrange
    const h = setup(undefined);

    // Act
    const r = await h.invoke('baselines.recalc', { exerciseId: 'bench-press' });

    // Assert
    const body = parse<Record<string, unknown>>(r);
    expect(Object.keys(body)).toEqual(['baseline']);
    expect((body.baseline as StoredExerciseBaseline).state).toBe('PROVISIONAL');
    expect(h.recalcBaseline).toHaveBeenCalledOnce();
  });
});
