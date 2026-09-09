// The write-lease fence (VMCP-01.65).
//
// The fence itself is two comparisons; what matters is WHICH conditions count
// as a lost lease and that the `lease_lost` push says so exactly once.

import { describe, it, expect } from 'vitest';

import { fence, LeaseLostError } from '../lease-fence.js';
import { makeFakeLease, makeRecordingChannels } from './fixtures/lease-fence.js';

function setup(): {
  lease: ReturnType<typeof makeFakeLease>;
  channels: ReturnType<typeof makeRecordingChannels>;
  guard: ReturnType<typeof fence>;
} {
  const lease = makeFakeLease();
  const channels = makeRecordingChannels();
  return { lease, channels, guard: fence({ lease, channels }, 'bilateral.cascade') };
}

describe('an intact fence', () => {
  it('passes while the lease has not moved', () => {
    const { guard, channels } = setup();

    expect(guard.intact()).toBe(true);
    expect(() => guard.check('left')).not.toThrow();
    expect(channels.events).toHaveLength(0);
  });
});

describe('a lost fence', () => {
  it('throws LEASE_LOST once the device changed hands', () => {
    const { lease, guard } = setup();
    lease.steal();

    expect(guard.intact()).toBe(false);
    expect(() => guard.check('left')).toThrow(LeaseLostError);
  });

  it('carries the LEASE_LOST code the tool layer maps to an error result', () => {
    const { lease, guard } = setup();
    lease.steal();

    try {
      guard.check('left');
      expect.unreachable('check should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('LEASE_LOST');
      expect((err as Error).message).toContain('bilateral.cascade');
    }
  });

  it('trips while a handover is freezing the lease, before the steal completes', () => {
    // The freeze exists so the outgoing holder cannot drive a device that is
    // being unloaded. The generation has not moved yet at that point.
    const { lease, guard } = setup();
    lease.beginTransfer();

    expect(guard.intact()).toBe(false);
  });

  it('publishes one slot-scoped lease_lost naming the tool', () => {
    const { lease, channels, guard } = setup();
    lease.steal();

    guard.report('right');

    expect(channels.events).toHaveLength(1);
    expect(channels.events[0].slot).toBe('right');
    expect(channels.events[0].meta.event_type).toBe('lease_lost');
    expect(channels.events[0].meta.tool).toBe('bilateral.cascade');
    expect(JSON.parse(channels.events[0].content)).toMatchObject({
      tool: 'bilateral.cascade',
      slot: 'right',
    });
  });

  it('publishes at most once per fence, however many writes it stops', () => {
    const { lease, channels, guard } = setup();
    lease.steal();

    expect(() => guard.check('left')).toThrow();
    expect(() => guard.check('right')).toThrow();
    guard.report('left');

    expect(channels.events).toHaveLength(1);
  });
});
