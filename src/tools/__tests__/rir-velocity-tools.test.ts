// Unit tests for src/tools/rir-velocity-tools.ts (VW-298).
//
// The fit itself is tested in `analytics/` and `store/`. What is covered here
// is the tool contract: the handlers install, the schemas reject what they
// should, two lifters with different curves get different targets for the same
// reps-in-reserve, and a lifter with no curve gets the stated caveat instead of
// a number.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  fitRirVelocityModel,
  GENERAL_MODEL_CAVEAT,
  type RirVelocityModel,
  type RirVelocityObservation,
} from '../../analytics/rir-velocity.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore, StoredRirVelocityModel } from '../../store/types.js';
import { registerRirVelocityTools, resolveRirVelocityTarget } from '../rir-velocity-tools.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  description?: string;
  update(updates: {
    callback: (args: unknown, extra?: unknown) => Promise<unknown>;
    description?: string;
  }): void;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

/** A fitted curve from three sessions of six-rep sets on a known line. */
function curve(intercept: number, slope: number): RirVelocityModel {
  const observations: RirVelocityObservation[] = ['s1', 's2', 's3'].map((sessionId, i) => ({
    setId: `set-${String(i)}`,
    sessionId,
    performedAt: `2026-09-0${String(i + 1)}T10:00:00.000Z`,
    relativeIntensity: 0.8,
    anchorSource: 'failure',
    points: Array.from({ length: 6 }, (_, r) => ({
      rir: 5 - r,
      velocityMps: intercept + slope * (5 - r),
    })),
  }));
  const model = fitRirVelocityModel(observations).model;
  if (model === null) throw new Error('fixture corpus should fit');
  return model;
}

/** A store that knows about exactly the curves it was handed. */
function storeWithCurves(curves: Record<string, RirVelocityModel>): SessionStore {
  return {
    getRirVelocityModel: (_userId: string, exerciseId: string) => {
      const model = curves[exerciseId];
      if (model === undefined) return Promise.resolve(undefined);
      const stored: StoredRirVelocityModel = {
        userId: _userId,
        exerciseId,
        model: model as unknown as Record<string, unknown>,
        fittedAt: '2026-09-10T00:00:00.000Z',
        sampleSize: model.pointCount,
        fitQuality: model.r2,
      };
      return Promise.resolve(stored);
    },
  } as unknown as SessionStore;
}

function setup(store: SessionStore): {
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
  descriptionOf: (name: string) => string;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of ['rir_velocity.fit', 'rir_velocity.target']) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
        tool.description = updates.description;
      },
    };
    placeholders.set(name, tool);
  }
  registerRirVelocityTools(
    undefined as unknown as Parameters<typeof registerRirVelocityTools>[0],
    { store } as unknown as ServerState,
    placeholders as unknown as Parameters<typeof registerRirVelocityTools>[2],
  );
  return {
    invoke: async (name, args) => {
      const callback = placeholders.get(name)?.callback;
      if (callback === undefined) throw new Error(`no callback installed for ${name}`);
      return (await callback(args)) as ToolResult;
    },
    descriptionOf: (name) => placeholders.get(name)?.description ?? '',
  };
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('rir_velocity.target', () => {
  it('gives two lifters with different curves different targets for the same RIR', async () => {
    // Arrange: the same exercise id, two lifters' stores, deliberately
    // different curves — one grinds slowly, one moves fast and decays hard.
    const slow = setup(storeWithCurves({ row: curve(0.15, 0.03) }));
    const fast = setup(storeWithCurves({ row: curve(0.35, 0.09) }));

    // Act
    const slowBody = parse(await slow.invoke('rir_velocity.target', { exerciseId: 'row', rir: 2 }));
    const fastBody = parse(await fast.invoke('rir_velocity.target', { exerciseId: 'row', rir: 2 }));

    // Assert
    expect(slowBody.velocityTargetMps).toBeCloseTo(0.21, 2);
    expect(fastBody.velocityTargetMps).toBeCloseTo(0.53, 2);
    expect(fastBody.velocityTargetMps).not.toEqual(slowBody.velocityTargetMps);
    expect(slowBody.caveat).toBeNull();
  });

  it('returns the general-model caveat and no number when the lifter has no curve', async () => {
    // Arrange
    const h = setup(storeWithCurves({}));

    // Act
    const body = parse(await h.invoke('rir_velocity.target', { exerciseId: 'row', rir: 2 }));

    // Assert
    expect(body.velocityTargetMps).toBeNull();
    expect(body.withinFittedRange).toBeNull();
    expect(body.caveat).toBe(GENERAL_MODEL_CAVEAT);
    expect(body.caveat).toContain('failed at 70%');
  });

  it('flags a target that extrapolates past the fitted range', async () => {
    // Arrange: sets to failure of six reps span RIR 0-5.
    const h = setup(storeWithCurves({ row: curve(0.2, 0.05) }));

    // Act
    const inside = parse(await h.invoke('rir_velocity.target', { exerciseId: 'row', rir: 3 }));
    const outside = parse(await h.invoke('rir_velocity.target', { exerciseId: 'row', rir: 9 }));

    // Assert
    expect(inside.withinFittedRange).toBe(true);
    expect(outside.withinFittedRange).toBe(false);
  });

  it('rejects a reps-in-reserve outside the prescribable range', async () => {
    // Arrange / Act
    const h = setup(storeWithCurves({}));
    const result = await h.invoke('rir_velocity.target', { exerciseId: 'row', rir: 25 });

    // Assert
    expect(result.isError).toBe(true);
  });

  it('rejects an unknown key rather than silently ignoring it', async () => {
    // Arrange / Act
    const h = setup(storeWithCurves({}));
    const result = await h.invoke('rir_velocity.target', {
      exerciseId: 'row',
      rir: 2,
      side: 'left',
    });

    // Assert
    expect(result.isError).toBe(true);
  });

  it('cites the individual-model finding in both descriptions', () => {
    // Arrange / Act
    const h = setup(storeWithCurves({}));

    // Assert
    for (const name of ['rir_velocity.fit', 'rir_velocity.target']) {
      expect(h.descriptionOf(name)).toContain('Jukic et al. 2024');
      expect(h.descriptionOf(name)).toContain('under 2 repetitions');
    }
  });
});

describe('rir_velocity.fit', () => {
  let refitCalls: string[];

  beforeEach(() => {
    refitCalls = [];
  });

  function fittingStore(model: RirVelocityModel | null): SessionStore {
    return {
      refitRirVelocityModel: (_userId: string, exerciseId: string) => {
        refitCalls.push(exerciseId);
        return Promise.resolve({
          model,
          qualification: {
            observedSets: 3,
            qualifyingSets: model === null ? 0 : 3,
            qualifyingSessions: model === null ? 0 : 3,
            qualifyingPoints: model === null ? 0 : 18,
            rirSpread: model === null ? 0 : 5,
          },
          reason: model === null ? 'only 0 of 3 sets in the 70-90% band' : 'fitted',
        });
      },
    } as unknown as SessionStore;
  }

  it('reports a fitted curve and the counts behind it', async () => {
    // Arrange
    const h = setup(fittingStore(curve(0.2, 0.05)));

    // Act
    const body = parse(await h.invoke('rir_velocity.fit', { exerciseId: 'row' }));

    // Assert
    expect(refitCalls).toEqual(['row']);
    expect(body.fitted).toBe(true);
    expect(body.qualification).toMatchObject({ qualifyingSets: 3, qualifyingPoints: 18 });
  });

  it('reports which minimum blocked a fit instead of a bare null', async () => {
    // Arrange
    const h = setup(fittingStore(null));

    // Act
    const body = parse(await h.invoke('rir_velocity.fit', { exerciseId: 'row' }));

    // Assert
    expect(body.fitted).toBe(false);
    expect(body.model).toBeNull();
    expect(body.reason).toContain('70-90% band');
  });
});

describe('resolveRirVelocityTarget', () => {
  it('is the one conversion both tools and coaching.explain read', async () => {
    // Arrange: the same store the tool handler uses.
    const store = storeWithCurves({ row: curve(0.2, 0.05) });

    // Act
    const direct = await resolveRirVelocityTarget(store, 'row', 2);
    const viaTool = parse(
      await setup(store).invoke('rir_velocity.target', { exerciseId: 'row', rir: 2 }),
    );

    // Assert
    expect(viaTool.velocityTargetMps).toBe(direct.velocityTargetMps);
    expect(viaTool.citation).toBe(direct.citation);
  });
});
