// Input schemas for `timer.*` tools.
//
// `timer.wait` blocks the caller for the duration, then returns. `timer.start`
// is the push-style alternative — it returns a `timer_id` immediately and
// fires a `timer_complete` claude/channel event when the duration elapses.
// `timer.cancel` covers both: by id (preferred, fires for `timer.start`
// timers and the most recent `timer.wait`) or argless (cancels the singleton
// blocking timer for backward compatibility with the original API).
//
// Durations are bounded so a runaway LLM call can't park the server in a
// 10-day sleep.

import { z } from 'zod';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Input for `timer.wait` — a duration to block on.
 *
 * Bounded to [1ms, 1h]. Intervals longer than an hour are out of scope for
 * a single MCP call; the trainer should issue a fresh `timer.wait` if a longer
 * idle is genuinely intended.
 */
export const TimerWaitInput = z.object({
  durationMs: z.number().int().min(1).max(ONE_HOUR_MS),
  /** Optional human-readable tag echoed back in the result (e.g., "rest", "between sets"). */
  label: z.string().max(120).optional(),
});

/**
 * Input for `timer.start` — schedule a non-blocking timer that fires a
 * `timer_complete` claude/channel event when it elapses. Returns the
 * `timer_id` synchronously so the model can keep talking while the timer
 * runs. Bounded to [1ms, 1h]; `label` is required so the wake-up event has
 * a human-readable identifier.
 */
export const TimerStartInput = z.object({
  durationMs: z.number().int().min(1).max(ONE_HOUR_MS),
  label: z.string().min(1).max(100),
});

/**
 * `timer.cancel` cancels by id when `timer_id` is provided (covers both
 * `timer.start` and `timer.wait` timers); if omitted it cancels the
 * singleton blocking `timer.wait` (legacy behavior).
 */
export const TimerCancelInput = z.object({ timer_id: z.string().min(1).optional() }).strict();
