// Focused unit tests for the pure helpers extracted from the `device.*`
// handlers (`device-handler-helpers.ts`): the guided-load Idle-preflight
// decision, the tracked-field builder, and the best-effort BLE teardown
// (including the now-logged failure paths that were previously silent).

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { TrainingModeName } from '../../schemas/common.js';
import { log } from '../../logger.js';
import {
  shouldPreflightWeightTraining,
  buildGuidedLoadTrackedFields,
  teardownBleResources,
} from '../device-handler-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldPreflightWeightTraining', () => {
  it('drives WeightTraining when the requested mode is explicit Idle', () => {
    expect(shouldPreflightWeightTraining('Idle')).toBe(true);
  });

  it('drives WeightTraining when no requested mode has been observed (cold boot)', () => {
    // #83: undefined (no cmd=0x10 cascade yet) is treated the same as Idle.
    expect(shouldPreflightWeightTraining(undefined)).toBe(true);
  });

  it('does NOT preflight when a non-Idle mode is already requested', () => {
    const modes: TrainingModeName[] = ['WeightTraining', 'ResistanceBand', 'Rowing'];
    for (const mode of modes) {
      expect(shouldPreflightWeightTraining(mode)).toBe(false);
    }
  });
});

describe('buildGuidedLoadTrackedFields', () => {
  it('tracks only baseWeight (exact) when no prior chains/eccentric exist', () => {
    const fields = buildGuidedLoadTrackedFields(50, {});
    expect(fields).toEqual([{ field: 'baseWeight', requested: 50, mode: 'exact' }]);
  });

  it('adds a guard-mode chains field when a prior chain setting exists', () => {
    const fields = buildGuidedLoadTrackedFields(50, { chainSettingLbs: 30 });
    expect(fields).toContainEqual({ field: 'chains', requested: 30, mode: 'guard' });
  });

  it('includes a zero chain setting (0 is a real prior value, not absence)', () => {
    const fields = buildGuidedLoadTrackedFields(50, { chainSettingLbs: 0 });
    expect(fields).toContainEqual({ field: 'chains', requested: 0, mode: 'guard' });
  });

  it('adds a guard-mode eccentric field when a prior eccentric value exists', () => {
    const fields = buildGuidedLoadTrackedFields(50, { eccentricPercentTenths: 80 });
    expect(fields).toContainEqual({
      field: 'eccentricPercentTenths',
      requested: 80,
      mode: 'guard',
    });
  });

  it('builds all three specs with baseWeight first when both priors exist', () => {
    const fields = buildGuidedLoadTrackedFields(75, {
      chainSettingLbs: 20,
      eccentricPercentTenths: 120,
    });
    expect(fields).toEqual([
      { field: 'baseWeight', requested: 75, mode: 'exact' },
      { field: 'chains', requested: 20, mode: 'guard' },
      { field: 'eccentricPercentTenths', requested: 120, mode: 'guard' },
    ]);
  });
});

describe('teardownBleResources', () => {
  it('force-closes the adapter then disposes the client, in that order', async () => {
    const order: string[] = [];
    const adapter = { disconnect: vi.fn(async () => void order.push('adapter')) };
    const client = { dispose: vi.fn(() => void order.push('dispose')) };

    await teardownBleResources(adapter, client);

    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(['adapter', 'dispose']);
  });

  it('skips the adapter close when no adapter was captured (still disposes)', async () => {
    const client = { dispose: vi.fn() };
    await teardownBleResources(null, client);
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('logs at info and still disposes when the adapter force-close throws', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const boom = new Error('adapter kaboom');
    const adapter = {
      disconnect: vi.fn(async () => {
        throw boom;
      }),
    };
    const client = { dispose: vi.fn() };

    await expect(teardownBleResources(adapter, client)).resolves.toBeUndefined();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('adapter force-close failed'),
      boom,
    );
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('logs at info (never throws) when client dispose throws', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const boom = new Error('dispose kaboom');
    const client = {
      dispose: vi.fn(() => {
        throw boom;
      }),
    };

    await expect(teardownBleResources(null, client)).resolves.toBeUndefined();

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('client dispose failed'), boom);
  });
});
