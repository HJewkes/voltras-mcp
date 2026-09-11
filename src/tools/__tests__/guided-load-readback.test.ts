// VMCP-02.88 / VMCP-02.89 — the post-write read-back for the three
// guided-load tools.
//
// The property under test is not "does it confirm" but "does it ever claim to
// confirm something it did not observe". A wrong read-back on a device that
// applies physical load to a person is worse than no read-back, so every case
// below is either a device-sourced confirmation, an observed contradiction, or
// an explicit unknown — and there is no fourth outcome.

import { describe, expect, it, vi } from 'vitest';

import {
  DEVICE_REPORTED_PHASES,
  GUIDED_LOAD_READ_BACK_WINDOW_MS,
  readBackGuidedLoadExit,
  readBackGuidedLoadTrigger,
  readBackUnload,
} from '../guided-load-readback.js';
import { MODE_ECHO_POLL_MS } from '../device-handler-helpers.js';

const noFence = (): void => undefined;

/** A phase source that yields each value once and then repeats the last. */
function phaseSequence(...phases: string[]): () => string {
  let at = 0;
  return () => phases[Math.min(at++, phases.length - 1)] as string;
}

function codeOf(err: unknown): string {
  return (err as { code?: string }).code ?? '';
}

describe('readBackGuidedLoadTrigger', () => {
  it('treats exactly countdown, engaging and active as device-reported', () => {
    expect([...DEVICE_REPORTED_PHASES].sort()).toEqual(['active', 'countdown', 'engaging']);
  });

  for (const phase of ['countdown', 'engaging', 'active']) {
    it(`confirms from the device when the phase reads "${phase}"`, async () => {
      const readBack = await readBackGuidedLoadTrigger({
        slotId: 'primary',
        targetWeightLbs: 50,
        readPhase: () => phase,
        checkFence: noFence,
      });
      expect(readBack.verdict).toBe('confirmed');
      expect(readBack.source).toBe('device');
      expect(readBack.observed_phase).toBe(phase);
      expect(readBack.unconfirmed_reason).toBeUndefined();
    });
  }

  // The VMCP-02.20 short-circuit: the cable goes hot with no ceremony. The
  // read-back is the first place a caller can see it without polling events.
  it('flags a ceremony skip when active arrives with no countdown before it', async () => {
    const readBack = await readBackGuidedLoadTrigger({
      slotId: 'primary',
      targetWeightLbs: 50,
      readPhase: () => 'active',
      checkFence: noFence,
    });
    expect(readBack.ceremony_skipped).toBe(true);
  });

  it('does not flag a skip when the countdown was observed first', async () => {
    vi.useFakeTimers();
    try {
      const call = readBackGuidedLoadTrigger({
        slotId: 'primary',
        targetWeightLbs: 50,
        readPhase: phaseSequence('armed', 'countdown', 'active'),
        checkFence: noFence,
      });
      await vi.advanceTimersByTimeAsync(MODE_ECHO_POLL_MS * 2);
      const readBack = await call;
      expect(readBack.observed_phase).toBe('countdown');
      expect(readBack.ceremony_skipped).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // `armed` is the one phase the SDK reaches both ways — it synthesises it on
  // the trigger write AND derives it from a status response. Reporting it as
  // confirmation is the exact fabrication this change exists to prevent.
  it('reports an honest unknown when the phase never leaves armed', async () => {
    vi.useFakeTimers();
    try {
      const call = readBackGuidedLoadTrigger({
        slotId: 'primary',
        targetWeightLbs: 50,
        readPhase: () => 'armed',
        checkFence: noFence,
      });
      await vi.advanceTimersByTimeAsync(GUIDED_LOAD_READ_BACK_WINDOW_MS);
      const readBack = await call;
      expect(readBack.verdict).toBe('unconfirmed');
      expect(readBack.source).toBe('server');
      expect(readBack.observed_phase).toBe('armed');
      expect(readBack.unconfirmed_reason).toContain('no device status response');
    } finally {
      vi.useRealTimers();
    }
  });

  // THE BOUNDARY. The window is the behaviour: it must give up AT the bound,
  // not one poll past it. `elapsed >= timeoutMs` weakened to `>` spins at
  // exactly the deadline instead of returning, so this exact-equality case is
  // the only one that catches it.
  it('gives up at exactly the window, not a poll later', async () => {
    vi.useFakeTimers();
    try {
      const call = readBackGuidedLoadTrigger(
        {
          slotId: 'primary',
          targetWeightLbs: 50,
          readPhase: () => 'armed',
          checkFence: noFence,
        },
        { timeoutMs: 100, pollMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(100);
      const readBack = await call;
      expect(readBack.waited_ms).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never waits past the window even when the poll would overshoot it', async () => {
    vi.useFakeTimers();
    try {
      const call = readBackGuidedLoadTrigger(
        {
          slotId: 'primary',
          targetWeightLbs: 50,
          readPhase: () => 'armed',
          checkFence: noFence,
        },
        { timeoutMs: 30, pollMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(30);
      const readBack = await call;
      expect(readBack.waited_ms).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const phase of ['idle', 'exited', 'timeout']) {
    it(`fails with GUIDED_LOAD_NOT_ARMED when the phase reads "${phase}"`, async () => {
      const call = readBackGuidedLoadTrigger({
        slotId: 'left',
        targetWeightLbs: 95,
        readPhase: () => phase,
        checkFence: noFence,
      });
      await expect(call).rejects.toThrow(/did not|not running/);
      await call.catch((err: unknown) => {
        expect(codeOf(err)).toBe('GUIDED_LOAD_NOT_ARMED');
        expect((err as Error).message).toContain('`left`');
        expect((err as Error).message).toContain('95 lb');
        expect((err as Error).message).toContain(phase);
      });
    });
  }

  // PR #306 wired an AbortSignal through the guided-load poll and #289 fenced
  // the multi-step writes. A steal that lands mid-read-back must surface as
  // the lease failure, never as a guided-load verdict.
  it('aborts on a lease steal mid-wait instead of returning a verdict', async () => {
    vi.useFakeTimers();
    try {
      let stolen = false;
      const call = readBackGuidedLoadTrigger({
        slotId: 'primary',
        targetWeightLbs: 50,
        readPhase: () => 'armed',
        checkFence: () => {
          if (stolen) throw new Error('lease stolen');
        },
      });
      const settled = call.then(
        () => 'resolved',
        (err: unknown) => (err as Error).message,
      );
      await vi.advanceTimersByTimeAsync(MODE_ECHO_POLL_MS);
      stolen = true;
      await vi.advanceTimersByTimeAsync(MODE_ECHO_POLL_MS);
      expect(await settled).toBe('lease stolen');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('readBackGuidedLoadExit', () => {
  for (const phase of ['armed', 'countdown', 'engaging', 'active']) {
    it(`fails with GUIDED_LOAD_EXIT_UNCONFIRMED when the phase stays "${phase}"`, () => {
      try {
        readBackGuidedLoadExit('right', phase);
        expect.unreachable('expected a contradiction');
      } catch (err) {
        expect(codeOf(err)).toBe('GUIDED_LOAD_EXIT_UNCONFIRMED');
        expect((err as Error).message).toContain('`right`');
        expect((err as Error).message).toContain(phase);
      }
    });
  }

  // Not a pessimism: the SDK stops the status poll before it writes the exit,
  // so there is no device observation to be had, and saying otherwise would
  // invent one.
  it('never claims device confirmation, because the poll is already stopped', () => {
    const readBack = readBackGuidedLoadExit('primary', 'exited');
    expect(readBack.verdict).toBe('unconfirmed');
    expect(readBack.source).toBe('server');
    expect(readBack.observed_phase).toBe('exited');
    expect(readBack.unconfirmed_reason).toContain('stops the status poll');
  });
});

describe('readBackUnload', () => {
  it('fails with UNLOAD_UNCONFIRMED when the flow it tore down is still running', () => {
    try {
      readBackUnload({
        slotId: 'primary',
        phase: 'active',
        loadState: 'loaded',
        guidedLoadWasActive: true,
      });
      expect.unreachable('expected a contradiction');
    } catch (err) {
      expect(codeOf(err)).toBe('UNLOAD_UNCONFIRMED');
      expect((err as Error).message).toContain('active');
    }
  });

  it('reports the cable as unconfirmed even on the clean teardown', () => {
    const readBack = readBackUnload({
      slotId: 'primary',
      phase: 'exited',
      loadState: 'unloaded',
      guidedLoadWasActive: true,
    });
    expect(readBack.verdict).toBe('unconfirmed');
    expect(readBack.observed_load_state).toBe('unloaded');
    expect(readBack.unconfirmed_reason).toContain('slack one');
  });

  // `deriveLoadState` reads `unloaded` through ordinary weight reps, so it can
  // never be the evidence that the cable dropped. Stated, not assumed.
  it('does not treat load_state unloaded as evidence the cable dropped', () => {
    const readBack = readBackUnload({
      slotId: 'primary',
      phase: 'idle',
      loadState: 'unloaded',
      guidedLoadWasActive: false,
    });
    expect(readBack.verdict).toBe('unconfirmed');
    expect(readBack.source).toBe('server');
  });

  // A flow that armed AFTER this unload was issued is not this call's failure
  // to report — the contradiction is only meaningful for the flow it tore down.
  it('does not fail for a phase it was never asked to tear down', () => {
    const readBack = readBackUnload({
      slotId: 'primary',
      phase: 'armed',
      loadState: 'unloaded',
      guidedLoadWasActive: false,
    });
    expect(readBack.observed_phase).toBe('armed');
    expect(readBack.verdict).toBe('unconfirmed');
  });
});
