// Unit tests for SetWatchdog — the per-set idle-timer registry backing
// the trigger DSL's `idle_timeout_ms` spec.
//
// Strategy: vi.useFakeTimers() drives each case so wall-clock time never
// gates the assertions. afterEach restores real timers + clears any
// leftover handles so background timers don't bleed between tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SetWatchdog } from '../set-watchdog.js';

describe('SetWatchdog', () => {
  let watchdog: SetWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    watchdog = new SetWatchdog();
  });

  afterEach(() => {
    watchdog.clearAll();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('arms a timer that fires after the requested duration', async () => {
      const onFire = vi.fn();
      watchdog.register('set-1', 30_000, onFire);
      expect(watchdog.has('set-1')).toBe(true);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(onFire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onFire).toHaveBeenCalledTimes(1);
      // Slot is cleared after firing so the registry doesn't grow
      // unbounded across set lifetimes.
      expect(watchdog.has('set-1')).toBe(false);
    });

    it('register on an already-registered setId is a no-op (use reset to re-arm)', async () => {
      const first = vi.fn();
      const second = vi.fn();
      watchdog.register('set-1', 30_000, first);
      watchdog.register('set-1', 5_000, second);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });

    it('isolates timers across distinct set ids', async () => {
      const onFireA = vi.fn();
      const onFireB = vi.fn();
      watchdog.register('set-A', 30_000, onFireA);
      watchdog.register('set-B', 60_000, onFireB);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onFireA).toHaveBeenCalledTimes(1);
      expect(onFireB).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onFireB).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('bumps the deadline forward, preventing the original fire', async () => {
      const onFire = vi.fn();
      watchdog.register('set-1', 30_000, onFire);
      await vi.advanceTimersByTimeAsync(20_000);

      // Reset → new 30s window from now.
      watchdog.reset('set-1', 30_000, onFire);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onFire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('reset on an unregistered setId is a no-op (no fire, no exception)', async () => {
      const onFire = vi.fn();
      watchdog.reset('set-unknown', 30_000, onFire);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('clears the timer, preventing the fire', async () => {
      const onFire = vi.fn();
      watchdog.register('set-1', 30_000, onFire);
      watchdog.cancel('set-1');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFire).not.toHaveBeenCalled();
      expect(watchdog.has('set-1')).toBe(false);
    });

    it('cancel on an unregistered setId is a no-op', () => {
      // Idempotent — finalizeSet calls cancel without checking whether the
      // set ever had a watchdog.
      expect(() => watchdog.cancel('set-unknown')).not.toThrow();
    });

    it('cancel after fire is also a no-op', async () => {
      const onFire = vi.fn();
      watchdog.register('set-1', 30_000, onFire);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onFire).toHaveBeenCalledTimes(1);
      // Slot already cleared by the fire callback; cancel finds nothing.
      expect(() => watchdog.cancel('set-1')).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('cancels every registered timer at once', async () => {
      const onFireA = vi.fn();
      const onFireB = vi.fn();
      watchdog.register('set-A', 30_000, onFireA);
      watchdog.register('set-B', 60_000, onFireB);

      watchdog.clearAll();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFireA).not.toHaveBeenCalled();
      expect(onFireB).not.toHaveBeenCalled();
    });
  });
});
