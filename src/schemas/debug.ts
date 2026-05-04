// Input schemas for `debug.*` diagnostic tools.
//
// The two debug tools share the same shape: an optional `n` count of how
// many recent entries to return, defaulting to 50, capped at the buffer
// capacity by the handler (the schema only enforces the lower bound).

import { z } from 'zod';

const DEFAULT_N = 50;

/** Input for `debug.recent_frames` — last N telemetry frames the bridge saw. */
export const DebugRecentFramesInput = z.object({
  n: z.number().int().min(1).max(10_000).optional().default(DEFAULT_N),
});

/** Input for `debug.recent_events` — last N bridge-level events. */
export const DebugRecentEventsInput = z.object({
  n: z.number().int().min(1).max(10_000).optional().default(DEFAULT_N),
});
