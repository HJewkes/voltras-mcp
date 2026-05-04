// Input schemas for `timer.*` tools.
//
// One singleton timer per server process; durations are bounded so a runaway
// LLM call can't park the server in a 10-day sleep.

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

/** `timer.cancel` takes no arguments — it cancels the singleton in-flight timer if any. */
export const TimerCancelInput = z.object({}).strict();
