// The shutdown sequence actually waits for the connection to close
// (VMCP-01.61).
//
// This exists because the first version of the surrender-on-disconnect work
// was fire-and-forget: `void closeConnection()` followed by an exit driven only
// by the dashboard close. The device surrender therefore never completed in a
// real process — while the unit test passed, because it awaited `close()`
// directly. The bug lived entirely in the gap between what the test called and
// what the process ran.

import { describe, it, expect, vi } from 'vitest';

// server.js pulls in the tool layer, which imports SDK enums at module scope.
vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: { Idle: 0, WeightTraining: 1, ResistanceBand: 2, Rowing: 3, Damper: 4, Isokinetic: 7, Isometric: 8 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining', 2: 'ResistanceBand', 3: 'Rowing', 4: 'Damper', 7: 'Isokinetic', 8: 'Isometric' },
  VoltraSDKError: class extends Error {},
  VoltraClient: class {},
  VoltraManager: { forNode: () => ({}), forMock: () => ({}) },
}));

const { runShutdown, SHUTDOWN_HARD_TIMEOUT_MS } = await import('../server.js');

/** A close that resolves only when we say so. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runShutdown', () => {
  it('does not exit until the connection close resolves', async () => {
    const connection = deferred();
    const exit = vi.fn();

    runShutdown(undefined, () => connection.promise, exit);
    await Promise.resolve();

    // The surrender is still in flight — exiting here would abandon it.
    expect(exit).not.toHaveBeenCalled();

    connection.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('waits for the dashboard too, not just the connection', async () => {
    const dashboard = deferred();
    const exit = vi.fn();

    runShutdown({ port: 7723, close: () => dashboard.promise }, () => Promise.resolve(), exit);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    dashboard.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('still exits when the connection close rejects', async () => {
    const exit = vi.fn();

    runShutdown(undefined, () => Promise.reject(new Error('radio wedged')), exit);

    // A failed surrender must not wedge the process open.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('force-exits non-zero when a close hangs past the hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      runShutdown(undefined, () => new Promise<void>(() => undefined), exit);

      vi.advanceTimersByTime(SHUTDOWN_HARD_TIMEOUT_MS + 1);

      // A wedged radio must not hold the process open forever (VMCP-01.25/F11).
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
