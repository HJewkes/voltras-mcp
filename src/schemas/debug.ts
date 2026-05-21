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

/**
 * Input for `debug.recent_events` — last N bridge-level events.
 *
 * `types` (optional): when supplied, only events whose `type` field matches
 * one of the strings in the array are returned. Empty array or omitted means
 * "no type filter."
 *
 * `includeRawFrames` (optional, default `false`): controls whether raw BLE
 * frame entries (events with `type === 'raw_frame'`, captured pre-decode via
 * `client.onRawFrame`) are included. Raw frames are debug-of-debug noise;
 * default is parsed-only. The default value is intentionally non-backward-
 * compatible — pre-VMCP-02.10 callers received raw frames mixed in, and that
 * was the firehose problem this filter solves. Pass `includeRawFrames: true`
 * to restore the legacy behavior.
 */
export const DebugRecentEventsInput = z.object({
  n: z.number().int().min(1).max(10_000).optional().default(DEFAULT_N),
  types: z.array(z.string()).optional(),
  includeRawFrames: z.boolean().optional().default(false),
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
