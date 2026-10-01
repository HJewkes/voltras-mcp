/**
 * Idle self-heal for the drill stack (VW-339): while any layer is open, one deadline runs, and
 * when nobody touches the wall for {@link IDLE_HEAL_MS} the whole stack clears and the page is
 * the glance again.
 *
 * Only lifter input resets the deadline ({@link IDLE_ACTIVITY_EVENTS}, wired by the page).
 * A poll refresh re-reports `setActive(true)`, which never restarts a running deadline, so a
 * 2 s poll cannot hold a sheet open forever. Timers are injected so tests use fake time.
 */

export const IDLE_HEAL_MS = 60_000;

/** Document events that count as the lifter still using the drill. */
export const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface IdleTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleHealOptions {
  /** Called once when the deadline passes; the page dispatches `reset` here. */
  onIdle: () => void;
  timeoutMs?: number;
  timers?: IdleTimers;
}

export interface IdleHeal {
  /** Report whether the stack is non-empty. Arms on true, cancels on false. */
  setActive(active: boolean): void;
  /** Lifter input: restart the deadline, if one is running. */
  activity(): void;
  dispose(): void;
}

const globalTimers: IdleTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createIdleHeal({
  onIdle,
  timeoutMs = IDLE_HEAL_MS,
  timers = globalTimers,
}: IdleHealOptions): IdleHeal {
  let handle: unknown = null;

  const cancel = (): void => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };
  const arm = (): void => {
    handle = timers.setTimeout(() => {
      handle = null;
      onIdle();
    }, timeoutMs);
  };

  return {
    setActive(active) {
      if (!active) cancel();
      else if (handle === null) arm();
    },
    activity() {
      if (handle === null) return;
      cancel();
      arm();
    },
    dispose: cancel,
  };
}
