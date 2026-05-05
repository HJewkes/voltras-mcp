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

/**
 * Input for `debug.push_test_channel` — smoke-test the `claude/channel`
 * publisher without requiring real device hardware. Mirrors the
 * `ChannelEvent` shape: a human-readable `content` line and a flat
 * string→string `meta` map that becomes XML attributes on the delivered
 * `<channel>` tag. The host silently drops the notification when channels
 * weren't enabled at session launch (`--channels`).
 */
export const DebugPushTestChannelInput = z.object({
  content: z.string().min(1),
  meta: z.record(z.string(), z.string()).default({}),
});
