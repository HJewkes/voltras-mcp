// Unit tests for the passive rest-timer registry (VMCP-02.08).
//
// Strategy: rather than reach for `vi.useFakeTimers`, the registry exposes
// a `scheduler` seam and a `now` injection point. Tests construct a
// `manualScheduler` that captures every queued callback and lets the test
// drive time forward by calling `manualNow.advance(ms)` + draining due
// callbacks. This keeps each test focused on the cadence contract
// (initial + tick + cap) without `vi.advanceTimersByTimeAsync` noise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RestTimerRegistry,
  REST_STATUS_INTERVAL_MS,
  REST_STATUS_CAP_MS,
  type Scheduler,
} from '../rest-timer.js';
import type { ChannelPublisher, ChannelEvent } from '../channel-publisher.js';

interface QueuedCallback {
  fireAtMs: number;
  callback: () => void;
  cancelled: boolean;
}

interface ManualNow {
  now(): number;
  advance(ms: number): void;
}

function makeManualNow(initialMs = 0): ManualNow {
  let current = initialMs;
  return {
    now: () => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

interface ManualScheduler {
  scheduler: Scheduler;
  queue: QueuedCallback[];
  /**
   * Advance virtual time by `ms` and fire every callback whose `fireAtMs`
   * has elapsed, in fireAt order. Re-runs the drain loop until the queue
   * is empty for the new clock so chained `setTimeout` calls (the registry
   * uses a setTimeout chain for the cadence) fire in deterministic order.
   */
  tick(ms: number): void;
}

function makeManualScheduler(manualNow: ManualNow): ManualScheduler {
  const queue: QueuedCallback[] = [];

  const scheduler: Scheduler = (callback, delayMs) => {
    const entry: QueuedCallback = {
      fireAtMs: manualNow.now() + delayMs,
      callback,
      cancelled: false,
    };
    queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  return {
    scheduler,
    queue,
    tick(ms: number): void {
      const target = manualNow.now() + ms;
      // Fixed-point loop: each callback may schedule the next tick, so
      // we re-scan the queue after every fire until no due callback
      // remains. Bound by capMs/intervalMs = 20 iterations in production
      // shape so this is bounded in tests.
      let safety = 100;
      while (safety-- > 0) {
        const due = queue
          .filter((q) => !q.cancelled && q.fireAtMs <= target)
          .sort((a, b) => a.fireAtMs - b.fireAtMs);
        if (due.length === 0) {
          break;
        }
        const next = due[0];
        // Advance manualNow to the firing time so the registry's
        // `now()` reads see the correct elapsed value when computing
        // `elapsed_seconds`.
        const overshoot = next.fireAtMs - manualNow.now();
        if (overshoot > 0) {
          manualNow.advance(overshoot);
        }
        next.cancelled = true;
        next.callback();
      }
      // Catch up to the target time after all due callbacks fired.
      const remaining = target - manualNow.now();
      if (remaining > 0) {
        manualNow.advance(remaining);
      }
    },
  };
}

function makeCapturingChannels(): {
  publish: (event: ChannelEvent) => void;
  events: ChannelEvent[];
  publisher: ChannelPublisher;
} {
  const events: ChannelEvent[] = [];
  const publisher: ChannelPublisher = {
    publish: (event) => events.push(event),
    forSlot: () => publisher,
  };
  return { publish: publisher.publish, events, publisher };
}

describe('RestTimerRegistry', () => {
  let manualNow: ManualNow;
  let scheduler: ManualScheduler;
  let registry: RestTimerRegistry;

  beforeEach(() => {
    manualNow = makeManualNow(1_000_000);
    scheduler = makeManualScheduler(manualNow);
    registry = new RestTimerRegistry({
      scheduler: scheduler.scheduler,
      now: manualNow.now,
    });
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('initial emit', () => {
    it('publishes a rest_status with elapsed_seconds=0 immediately on start', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      expect(events).toHaveLength(1);
      expect(events[0].meta).toMatchObject({
        source: 'voltras',
        event_type: 'rest_status',
        slot: 'primary',
        set_id: 'set-1',
        elapsed_seconds: '0',
      });
      // The initial emit is NOT the final emit — `final` meta is absent.
      expect(events[0].meta.final).toBeUndefined();
    });

    it('payload content includes the structured rest_status block', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      const parsed = JSON.parse(events[0].content) as {
        summary: string;
        rest_status: {
          slot: string;
          set_id: string;
          elapsed_seconds: number;
          cap_seconds: number;
          final: boolean;
        };
      };
      expect(parsed.rest_status).toEqual({
        slot: 'primary',
        set_id: 'set-1',
        elapsed_seconds: 0,
        cap_seconds: 300,
        final: false,
      });
      expect(parsed.summary).toMatch(/Resting: 0s/);
    });
  });

  describe('periodic emits', () => {
    it('emits a rest_status every 15s while the rest is active', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      // t=0 already published; advance to t=15s.
      scheduler.tick(REST_STATUS_INTERVAL_MS);
      expect(events).toHaveLength(2);
      expect(events[1].meta.elapsed_seconds).toBe('15');

      scheduler.tick(REST_STATUS_INTERVAL_MS);
      expect(events).toHaveLength(3);
      expect(events[2].meta.elapsed_seconds).toBe('30');

      scheduler.tick(REST_STATUS_INTERVAL_MS);
      expect(events).toHaveLength(4);
      expect(events[3].meta.elapsed_seconds).toBe('45');
    });

    it('does not publish `final: true` on a non-cap tick', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);
      scheduler.tick(REST_STATUS_INTERVAL_MS * 3);
      for (const event of events) {
        expect(event.meta.final).toBeUndefined();
      }
    });
  });

  describe('cancel on set_started', () => {
    it('stops emitting after cancel() is called for the slot', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      scheduler.tick(REST_STATUS_INTERVAL_MS); // t=15
      expect(events).toHaveLength(2);

      registry.cancel('primary', 'next_set');
      expect(registry.has('primary')).toBe(false);

      // Advance past several intervals — no further emits.
      scheduler.tick(REST_STATUS_INTERVAL_MS * 5);
      expect(events).toHaveLength(2);
    });

    it('cancel on an unknown slot is a silent no-op', () => {
      // Calling cancel before any start (cold-start safety) must not
      // throw — the production flow at `set.start` runs an unconditional
      // cancel regardless of whether a rest was in flight.
      expect(() => registry.cancel('primary', 'next_set')).not.toThrow();
      expect(registry.has('primary')).toBe(false);
    });
  });

  describe('cancel on disconnect', () => {
    it('disconnect cancel halts further emits with the disconnect reason tag', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      scheduler.tick(REST_STATUS_INTERVAL_MS * 2); // t=30
      expect(events).toHaveLength(3);

      registry.cancel('primary', 'disconnect');
      scheduler.tick(REST_STATUS_INTERVAL_MS * 10);
      expect(events).toHaveLength(3);
    });
  });

  describe('cap at 5 minutes', () => {
    it('emits a final rest_status at the cap and stops scheduling', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);

      // Drain straight to the cap; we expect 1 (initial) + 19 (intervals
      // 15..285) + 1 (final at 300) = 21 emits.
      scheduler.tick(REST_STATUS_CAP_MS);

      const elapsed = events.map((e) => e.meta.elapsed_seconds);
      expect(elapsed[0]).toBe('0');
      expect(elapsed[elapsed.length - 1]).toBe('300');
      // The final emit is flagged.
      expect(events[events.length - 1].meta.final).toBe('true');
      // No final flag on any earlier emit.
      for (const event of events.slice(0, -1)) {
        expect(event.meta.final).toBeUndefined();
      }
      // Registry has cleaned itself up — no entry remains.
      expect(registry.has('primary')).toBe(false);
    });

    it('content carries final:true on the cap emit', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);
      scheduler.tick(REST_STATUS_CAP_MS);

      const last = events[events.length - 1];
      const parsed = JSON.parse(last.content) as {
        rest_status: { final: boolean };
        summary: string;
      };
      expect(parsed.rest_status.final).toBe(true);
      expect(parsed.summary).toMatch(/cap/i);
    });

    it('advancing past the cap does not produce extra emits', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);
      scheduler.tick(REST_STATUS_CAP_MS);
      const countAtCap = events.length;

      scheduler.tick(REST_STATUS_INTERVAL_MS * 5);
      expect(events).toHaveLength(countAtCap);
    });
  });

  describe('multi-slot independence', () => {
    it('two slots run independent timers with independent cancel/dispose', () => {
      const a = makeCapturingChannels();
      const b = makeCapturingChannels();
      registry.start('left', 'set-L', a.publisher);
      registry.start('right', 'set-R', b.publisher);

      // Each got an initial emit.
      expect(a.events).toHaveLength(1);
      expect(b.events).toHaveLength(1);

      scheduler.tick(REST_STATUS_INTERVAL_MS);
      expect(a.events).toHaveLength(2);
      expect(b.events).toHaveLength(2);
      expect(a.events[1].meta.set_id).toBe('set-L');
      expect(b.events[1].meta.set_id).toBe('set-R');

      // Cancel left — right keeps ticking.
      registry.cancel('left', 'next_set');
      scheduler.tick(REST_STATUS_INTERVAL_MS * 2);
      expect(a.events).toHaveLength(2);
      expect(b.events).toHaveLength(4);
    });

    it('starting a second timer for an already-active slot replaces the first', () => {
      const { events, publisher } = makeCapturingChannels();
      registry.start('primary', 'set-1', publisher);
      scheduler.tick(REST_STATUS_INTERVAL_MS); // t=15 against set-1
      expect(events).toHaveLength(2);

      // Defensive replace path — same slot, fresh setId.
      registry.start('primary', 'set-2', publisher);
      // The replace publishes a new initial emit for set-2 at t=15
      // (manualNow) → elapsed_seconds=0 against the *new* start time.
      expect(events).toHaveLength(3);
      expect(events[2].meta.set_id).toBe('set-2');
      expect(events[2].meta.elapsed_seconds).toBe('0');

      // The first set's scheduled tick is cancelled — advancing reveals
      // only the new set's cadence.
      scheduler.tick(REST_STATUS_INTERVAL_MS);
      expect(events).toHaveLength(4);
      expect(events[3].meta.set_id).toBe('set-2');
    });
  });

  describe('dispose', () => {
    it('clears every in-flight timer across all slots', () => {
      const a = makeCapturingChannels();
      const b = makeCapturingChannels();
      registry.start('left', 'set-L', a.publisher);
      registry.start('right', 'set-R', b.publisher);

      registry.dispose();
      expect(registry.has('left')).toBe(false);
      expect(registry.has('right')).toBe(false);

      scheduler.tick(REST_STATUS_INTERVAL_MS * 10);
      // Initial emits already landed before dispose; no further events.
      expect(a.events).toHaveLength(1);
      expect(b.events).toHaveLength(1);
    });

    it('dispose is idempotent', () => {
      registry.dispose();
      expect(() => registry.dispose()).not.toThrow();
    });
  });

  describe('publisher contract', () => {
    it('uses the publisher passed at start() (does not re-resolve via state)', () => {
      const first = makeCapturingChannels();
      const second = makeCapturingChannels();
      registry.start('primary', 'set-1', first.publisher);

      // Hand a second publisher to a different slot — emits should
      // route correctly even though the test reuses one registry.
      registry.start('right', 'set-2', second.publisher);

      scheduler.tick(REST_STATUS_INTERVAL_MS);
      // First publisher saw both initial + tick for set-1.
      expect(first.events.map((e) => e.meta.set_id)).toEqual(['set-1', 'set-1']);
      // Second publisher saw both initial + tick for set-2.
      expect(second.events.map((e) => e.meta.set_id)).toEqual(['set-2', 'set-2']);
    });

    it('a throwing publish on one tick does not break the cadence', () => {
      // Arrange: a publisher that throws on its 2nd emit — i.e. the first
      // interval tick at t=15 fails while the t=0 initial + later ticks
      // succeed. The production publisher (`state.channels.forSlot(...)`)
      // is fire-and-forget, so a throw is a bug the timer must survive:
      // it may not kill the rest cadence or leak the slot entry.
      const events: ChannelEvent[] = [];
      const throwingPublisher: ChannelPublisher = {
        publish: vi.fn((e) => {
          events.push(e);
          if (events.length === 2) {
            throw new Error('publish failed');
          }
        }),
        forSlot: () => throwingPublisher,
      };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Act: drive two intervals. The t=15 tick throws inside the timer
      // callback; a resilient registry swallows it and still schedules
      // the t=30 tick.
      registry.start('primary', 'set-1', throwingPublisher);
      scheduler.tick(REST_STATUS_INTERVAL_MS * 2);

      // Assert: the throw was caught (logged, not propagated), the t=30
      // tick still fired (3rd event landed), and the rest is still live.
      expect(errorSpy).toHaveBeenCalled();
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(registry.has('primary')).toBe(true);

      // Act 2: run out the clock past the cap.
      scheduler.tick(REST_STATUS_CAP_MS);

      // Assert: terminal emit fired and the entry was cleaned up — a
      // failed tick never leaks a stuck rest into the registry.
      expect(registry.has('primary')).toBe(false);

      errorSpy.mockRestore();
    });
  });
});
