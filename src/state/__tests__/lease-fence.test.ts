// The write-lease fence (VMCP-01.65).
//
// The fence itself is two comparisons; what matters is WHICH conditions count
// as a lost lease and that the `lease_lost` push says so exactly once.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { fence, waitFenced, LeaseLostError } from '../lease-fence.js';
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

// VW-200: the blocking half. A tool parked on a timer has no await to
// re-check at, so the fence hands it a signal the lease itself drives.
describe('the fence signal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays unaborted while the lease sits still', () => {
    const { guard } = setup();

    expect(guard.signal().aborted).toBe(false);
  });

  it('aborts the moment the device changes hands', () => {
    const { lease, guard } = setup();
    const signal = guard.signal();

    lease.steal();

    expect(signal.aborted).toBe(true);
  });

  it('aborts on the handover freeze, before the steal completes', () => {
    const { lease, guard } = setup();
    const signal = guard.signal();

    lease.beginTransfer();

    expect(signal.aborted).toBe(true);
  });

  it('ignores a notification that left the generation where it was', () => {
    // A holder refreshing its own lease notifies watchers without opening a
    // new epoch. Nothing may abort on that — the device never left.
    const { lease, guard } = setup();
    const signal = guard.signal();

    lease.touch();

    expect(signal.aborted).toBe(false);
  });

  it('hands back the same signal on every call', () => {
    const { guard } = setup();

    expect(guard.signal()).toBe(guard.signal());
  });

  it('is already aborted when the fence was lost before anyone asked', () => {
    const { lease, guard } = setup();
    lease.steal();

    expect(guard.signal().aborted).toBe(true);
  });

  it('stops watching the lease once disposed', () => {
    const { lease, guard } = setup();
    const signal = guard.signal();

    guard.dispose();
    lease.steal();

    expect(signal.aborted).toBe(false);
  });
});

describe('waitFenced', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the requested delay when the lease holds', async () => {
    vi.useFakeTimers();
    const { guard, channels } = setup();
    let resolved = false;

    const wait = waitFenced(5000, guard, 'left').then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;

    expect(resolved).toBe(true);
    expect(channels.events).toHaveLength(0);
  });

  it('rejects with LEASE_LOST and publishes once when the lease is stolen', async () => {
    vi.useFakeTimers();
    const { lease, guard, channels } = setup();

    const wait = waitFenced(90_000, guard, 'left');
    lease.steal();

    await expect(wait).rejects.toThrow(LeaseLostError);
    expect(channels.events).toHaveLength(1);
    expect(channels.events[0].meta.event_type).toBe('lease_lost');
    expect(channels.events[0].slot).toBe('left');
  });

  it('does not fire its timer after aborting', async () => {
    vi.useFakeTimers();
    const { lease, guard } = setup();
    const settled: string[] = [];

    const wait = waitFenced(1000, guard, 'left').then(
      () => settled.push('resolved'),
      () => settled.push('rejected'),
    );
    lease.steal();
    await wait;
    await vi.advanceTimersByTimeAsync(5000);

    expect(settled).toEqual(['rejected']);
  });
});
