// VMCP-02.63: the catalog lookup, the gate predicate it feeds, and the
// suppression event a gated set publishes at start.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '@voltras/workout-analytics';

import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';
import {
  movementClassForExerciseId,
  movementClassOf,
  velocityLossIsValidFor,
} from '../movement-class.js';
import { buildVelocityLossWatchSuppressedPayload } from '../../state/channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import {
  BALLISTIC_PULL,
  publishVelocityLossSuppression,
  velocityLossWatchSuppressed,
} from '../../state/velocity-loss-gate.js';
import type { ChannelPublisher } from '../../state/channel-publisher.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100 };

function activeSet(patch: Partial<ActiveSet> = {}): ActiveSet {
  return {
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2026-09-08T00:00:00.000Z',
    reps: [],
    status: 'active',
    ...patch,
  };
}

function watchingVelocityLoss(pct: number): ActiveSet['watch'] {
  return { notifyOn: [{ type: 'velocity_loss_exceeded', pct }] };
}

describe('movementClassOf', () => {
  it('passes every catalog pattern through', () => {
    for (const pattern of ['push', 'pull', 'isolation', 'squat', 'hinge', 'rotation']) {
      expect(movementClassOf({ movementPattern: pattern })).toBe(pattern);
    }
  });

  it('reads an absent row and an unrecognised pattern as unknown', () => {
    expect(movementClassOf(undefined)).toBe('unknown');
    expect(movementClassOf({ movementPattern: 'carry' })).toBe('unknown');
  });
});

describe('movementClassForExerciseId', () => {
  beforeEach(() => {
    (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(
      SEED_CABLE_EXERCISES,
    );
  });

  it('resolves the pattern the catalog carries', () => {
    expect(movementClassForExerciseId('cable-row')).toBe('pull');
    expect(movementClassForExerciseId('cable-chest-press')).toBe('push');
    expect(movementClassForExerciseId('cable-squat')).toBe('squat');
  });

  it('reads an absent id and an off-catalog id as unknown', () => {
    expect(movementClassForExerciseId(undefined)).toBe('unknown');
    expect(movementClassForExerciseId('not-in-the-catalog')).toBe('unknown');
  });
});

describe('velocityLossIsValidFor', () => {
  it('rejects only pull', () => {
    expect(velocityLossIsValidFor('pull')).toBe(false);
    for (const cls of ['push', 'isolation', 'squat', 'hinge', 'rotation', 'unknown'] as const) {
      expect(velocityLossIsValidFor(cls)).toBe(true);
    }
  });
});

describe('velocityLossWatchSuppressed', () => {
  it('suppresses a pull set', () => {
    expect(velocityLossWatchSuppressed(activeSet({ movementClass: 'pull' }))).toBe(true);
  });

  it('does not suppress a pull set that opted back in', () => {
    const set = activeSet({
      movementClass: 'pull',
      watch: { notifyOn: [], velocityLoss: { force: true } },
    });

    expect(velocityLossWatchSuppressed(set)).toBe(false);
  });

  it('does not suppress a push set or an unstamped set', () => {
    expect(velocityLossWatchSuppressed(activeSet({ movementClass: 'push' }))).toBe(false);
    expect(velocityLossWatchSuppressed(activeSet())).toBe(false);
  });
});

describe('publishVelocityLossSuppression', () => {
  let channels: ChannelPublisher;
  let publish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    publish = vi.fn();
    channels = { publish, forSlot: () => channels };
  });

  it('publishes once for a gated set that registered the trigger', () => {
    const set = activeSet({ movementClass: 'pull', watch: watchingVelocityLoss(25) });

    publishVelocityLossSuppression(channels, set, DEVICE);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].meta.event_type).toBe('velocity_loss_watch_suppressed');
    expect(publish.mock.calls[0][0].meta.reason).toBe(BALLISTIC_PULL);
  });

  it('stays silent when the set registered no velocity-loss trigger', () => {
    const set = activeSet({
      movementClass: 'pull',
      watch: { notifyOn: [{ type: 'rep_count_reached', value: 8 }] },
    });

    publishVelocityLossSuppression(channels, set, DEVICE);

    expect(publish).not.toHaveBeenCalled();
  });

  it('stays silent on a push set and on a forced pull set', () => {
    publishVelocityLossSuppression(
      channels,
      activeSet({ movementClass: 'push', watch: watchingVelocityLoss(25) }),
      DEVICE,
    );
    publishVelocityLossSuppression(
      channels,
      activeSet({
        movementClass: 'pull',
        watch: { ...watchingVelocityLoss(25), velocityLoss: { force: true } },
      }),
      DEVICE,
    );

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('buildVelocityLossWatchSuppressedPayload', () => {
  it('names the reason, the class, the thresholds held back and the override', () => {
    const set = activeSet({
      movementClass: 'pull',
      exerciseId: 'cable-row',
      watch: {
        notifyOn: [
          { type: 'velocity_loss_exceeded', pct: 25 },
          { type: 'rep_count_reached', value: 8 },
          { type: 'velocity_loss_exceeded', pct: 40 },
        ],
      },
    });

    const { meta, content } = buildVelocityLossWatchSuppressedPayload(set, DEVICE, BALLISTIC_PULL);
    const parsed = JSON.parse(content) as {
      suppression: {
        reason: string;
        movement_class: string;
        suppressed_thresholds_pct: number[];
        override: string;
      };
      set: { exercise_id: string | null };
    };

    expect(meta.event_type).toBe('velocity_loss_watch_suppressed');
    expect(meta.set_id).toBe('set-1');
    expect(meta.movement_class).toBe('pull');
    expect(parsed.suppression.suppressed_thresholds_pct).toEqual([25, 40]);
    expect(parsed.suppression.override).toBe('watch.velocityLoss.force');
    expect(parsed.set.exercise_id).toBe('cable-row');
  });
});
