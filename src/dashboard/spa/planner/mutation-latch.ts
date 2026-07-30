/**
 * Single-flight latch for the plan builder's writes (VW-121 / F1).
 *
 * ── The bug this exists to make impossible ────────────────────────────────
 * A double-click on a catalog row's "Add" appended TWO `plannedExercise` rows
 * (in one observed run, four), and the page shipped no delete, so the duplicates
 * were permanent. A `useState` busy flag does not fix it: both clicks of a real
 * double-click land in the SAME React tick, so both read the pre-render
 * `busy === false` and both fire. The guard has to be written SYNCHRONOUSLY on
 * the way in, which is what this is.
 *
 * It lives outside the `.tsx` for two reasons: the vitest suite only globs
 * `*.test.ts` (a guard defined inside a component could not be covered at all),
 * and "did the second call actually get dropped?" is exactly the property that
 * should be asserted rather than clicked.
 */

/** A latch that runs one operation at a time and drops the rest. */
export interface MutationLatch {
  /**
   * Run `fn` unless another run is already in flight.
   *
   * Resolves `true` when this call ran to completion, `false` when it was
   * dropped by the latch OR when `fn` rejected — a caller uses that to decide
   * whether to clear its form, so a rejected write never looks like a saved one.
   */
  run(fn: () => Promise<unknown>): Promise<boolean>;
  /** True while an operation is in flight. Drives disabled styling. */
  readonly busy: boolean;
}

/**
 * Build a latch.
 *
 * `onBusyChange` is how a React component mirrors the latch into render state:
 * the latch itself is deliberately NOT reactive, because the moment the guard
 * depends on a re-render it stops guarding the case it exists for.
 * `onError` receives anything `fn` throws.
 */
export function createMutationLatch(
  handlers: {
    onBusyChange?: (busy: boolean) => void;
    onError?: (err: Error) => void;
  } = {},
): MutationLatch {
  let inFlight = false;
  const latch: MutationLatch = {
    get busy() {
      return inFlight;
    },
    async run(fn) {
      if (inFlight) return false;
      inFlight = true;
      handlers.onBusyChange?.(true);
      try {
        await fn();
        return true;
      } catch (err) {
        handlers.onError?.(err as Error);
        return false;
      } finally {
        inFlight = false;
        handlers.onBusyChange?.(false);
      }
    },
  };
  return latch;
}
