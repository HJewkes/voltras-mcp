// VMCP-02.09c — ModeDivergenceWatch unit tests.
//
// The watch is driven by an injected clock so the debounce window is exercised
// without sleeping. Modes are raw numbers: 0 = Idle/transitional,
// 1 = WeightTraining, 2 = ResistanceBand, 7 = Isokinetic (the motivating case).

import { describe, expect, it } from 'vitest';
import { ModeDivergenceWatch, MODE_DIVERGENCE_WINDOW_MS } from '../mode-divergence-watch.js';

/** A controllable clock for deterministic window tests. */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('ModeDivergenceWatch', () => {
  it('emits nothing while only one side is known', () => {
    const w = new ModeDivergenceWatch();
    expect(w.onRequested(7)).toBeNull();
    // active still unknown → no comparison possible
    expect(w.onRequested(7)).toBeNull();
  });

  it('emits nothing when requested and applied agree', () => {
    const w = new ModeDivergenceWatch();
    expect(w.onRequested(1)).toBeNull();
    expect(w.onApplied(1)).toBeNull();
  });

  it('does not emit while the disagreement is younger than the window', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    expect(w.onRequested(7)).toBeNull(); // Isokinetic requested
    expect(w.onApplied(1)).toBeNull(); // running WeightTraining — diverged, t=0
    clock.advance(MODE_DIVERGENCE_WINDOW_MS - 1);
    expect(w.onApplied(1)).toBeNull(); // still inside window
  });

  it('emits exactly once when the disagreement persists past the window', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    expect(w.onApplied(1)).toBeNull(); // diverged at t=0
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    const div = w.onApplied(1);
    expect(div).toEqual({ requested: 7, active: 1, divergedForMs: MODE_DIVERGENCE_WINDOW_MS });
    // Still diverged a tick later — must NOT re-emit (once per episode).
    clock.advance(5000);
    expect(w.onApplied(1)).toBeNull();
    expect(w.onRequested(7)).toBeNull();
  });

  it('reports the actual elapsed time at emit (sparse feeds emit late)', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1); // diverged at t=0
    clock.advance(4200); // next state-dump arrives 4.2s later
    expect(w.onApplied(1)).toEqual({ requested: 7, active: 1, divergedForMs: 4200 });
  });

  it('clears and re-arms on reconvergence so a later divergence emits again', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).not.toBeNull(); // episode 1 emitted

    // Device reconverges to the requested mode.
    clock.advance(1000);
    expect(w.onApplied(7)).toBeNull(); // converged → episode cleared

    // A fresh divergence re-arms and emits after the window.
    expect(w.onApplied(1)).toBeNull(); // diverged again at this t
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).not.toBeNull(); // episode 2 emitted
  });

  it('treats either side going Idle (0) as no-comparison and clears the episode', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1); // diverged at t=0
    clock.advance(MODE_DIVERGENCE_WINDOW_MS - 1);
    // Applied goes transitional/Idle before the window elapses → episode reset.
    expect(w.onApplied(0)).toBeNull();
    // Back to the diverging mode restarts the clock; not yet past window.
    expect(w.onApplied(1)).toBeNull();
    clock.advance(MODE_DIVERGENCE_WINDOW_MS - 1);
    expect(w.onApplied(1)).toBeNull();
    // Now cross the (restarted) window.
    clock.advance(1);
    expect(w.onApplied(1)).not.toBeNull();
  });

  it('ignores undefined feeds without disturbing state', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1); // diverged at t=0
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onRequested(undefined)).toBeNull(); // no-op
    expect(w.onApplied(undefined)).toBeNull(); // no-op
    // The real feed still emits — undefined didn't clear or advance the episode.
    expect(w.onApplied(1)).not.toBeNull();
  });

  it('reset() drops all state', () => {
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    w.reset();
    // After reset, a single side is known again → no emit until both re-fed.
    expect(w.onApplied(1)).toBeNull();
  });

  it('honors a custom window of 0 (any settled disagreement emits immediately)', () => {
    const w = new ModeDivergenceWatch(() => 0, 0);
    w.onRequested(7);
    expect(w.onApplied(1)).toEqual({ requested: 7, active: 1, divergedForMs: 0 });
  });

  it('re-arms and emits again when the divergent pair shifts to a new pair', () => {
    // Arrange: an episode has emitted for requested=7 vs active=1.
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).toEqual({
      requested: 7,
      active: 1,
      divergedForMs: MODE_DIVERGENCE_WINDOW_MS,
    });

    // Act: requested shifts 7→2 while active stays 1 — a NEW still-divergent
    // pair. The new mismatch must arm its own window (not be swallowed).
    expect(w.onRequested(2)).toBeNull(); // shifted pair at this t → re-armed
    clock.advance(MODE_DIVERGENCE_WINDOW_MS - 1);
    expect(w.onApplied(1)).toBeNull(); // still inside the new window

    // Assert: once the new pair persists past the window, a fresh event emits.
    clock.advance(1);
    expect(w.onApplied(1)).toEqual({
      requested: 2,
      active: 1,
      divergedForMs: MODE_DIVERGENCE_WINDOW_MS,
    });
  });

  it('re-arms when the active side shifts to a new still-divergent value', () => {
    // Arrange: emitted episode for requested=7 vs active=1.
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).not.toBeNull();

    // Act + Assert: active shifts 1→2 (still ≠ requested 7) → new episode.
    expect(w.onApplied(2)).toBeNull(); // shifted pair re-armed
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(2)).toEqual({
      requested: 7,
      active: 2,
      divergedForMs: MODE_DIVERGENCE_WINDOW_MS,
    });
  });

  it('does not re-spam while the divergent pair is unchanged', () => {
    // Arrange: emitted episode for requested=7 vs active=1.
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).not.toBeNull();

    // Act + Assert: repeated feeds of the SAME pair long past the window stay
    // silent — one emit per persistent episode.
    clock.advance(10_000);
    expect(w.onApplied(1)).toBeNull();
    expect(w.onRequested(7)).toBeNull();
    clock.advance(10_000);
    expect(w.onApplied(1)).toBeNull();
  });

  it('a shifted pair that reconverges before its window emits nothing', () => {
    // Arrange: emitted episode for 7 vs 1, then shift to 2 vs 1.
    const clock = makeClock();
    const w = new ModeDivergenceWatch(clock.now);
    w.onRequested(7);
    w.onApplied(1);
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(1)).not.toBeNull();
    expect(w.onRequested(2)).toBeNull(); // re-armed for 2 vs 1

    // Act: the shifted pair reconverges (active follows to 2) inside the window.
    clock.advance(MODE_DIVERGENCE_WINDOW_MS - 1);
    expect(w.onApplied(2)).toBeNull(); // converged → episode cleared

    // Assert: nothing lingers to emit for the abandoned shifted pair.
    clock.advance(MODE_DIVERGENCE_WINDOW_MS);
    expect(w.onApplied(2)).toBeNull();
  });
});
