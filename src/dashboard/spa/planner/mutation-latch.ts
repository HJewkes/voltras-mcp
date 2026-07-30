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
 * The floor on how long the latch stays shut, in ms.
 *
 * "In flight" alone is not enough, and the browser proved it: against a local
 * sidecar the POST + reconcile completed in under 10 ms, so two clicks 10 ms
 * apart BOTH ran and two rows appeared — the original bug, reproduced with a
 * correct in-flight guard in place. Whether a double-click duplicates a row
 * cannot depend on how fast the server answered.
 *
 * 350 ms is chosen from the human side, not the network's: it covers a
 * double-click (browsers fire `dblclick` under ~500 ms) while staying short
 * enough that a deliberate second add never feels blocked.
 */
export const MIN_LATCH_HOLD_MS = 350;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build a latch.
 *
 * `onBusyChange` is how a React component mirrors the latch into render state:
 * the latch itself is deliberately NOT reactive, because the moment the guard
 * depends on a re-render it stops guarding the case it exists for.
 * `onError` receives anything `fn` throws. `minHoldMs` sets the floor described
 * on {@link MIN_LATCH_HOLD_MS}; 0 (the default) makes the latch purely
 * in-flight-scoped.
 */
export function createMutationLatch(
  handlers: {
    onBusyChange?: (busy: boolean) => void;
    onError?: (err: Error) => void;
    minHoldMs?: number;
  } = {},
): MutationLatch {
  let inFlight = false;
  const minHoldMs = handlers.minHoldMs ?? 0;
  const latch: MutationLatch = {
    get busy() {
      return inFlight;
    },
    async run(fn) {
      if (inFlight) return false;
      inFlight = true;
      handlers.onBusyChange?.(true);
      const startedAt = Date.now();
      try {
        await fn();
        return true;
      } catch (err) {
        handlers.onError?.(err as Error);
        return false;
      } finally {
        // Held for the REMAINDER of the floor, not the floor on top of the
        // work: a slow write is already past it and pays nothing extra.
        const remaining = minHoldMs - (Date.now() - startedAt);
        if (remaining > 0) await wait(remaining);
        inFlight = false;
        handlers.onBusyChange?.(false);
      }
    },
  };
  return latch;
}
