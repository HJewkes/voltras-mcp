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
 *
 * `nonce` (optional): a round-trip token. When omitted the handler mints one
 * (randomUUID). Either way it is injected into the delivered `meta` as `nonce`
 * and recorded as the outstanding probe, so the model can echo it back through
 * `debug.confirm_channel` to prove end-to-end delivery (VMCP-01.42 follow-up).
 */
export const DebugPushTestChannelInput = z.object({
  content: z.string().min(1),
  meta: z.record(z.string(), z.string()).default({}),
  nonce: z.string().min(1).optional(),
});

/**
 * Input for `debug.confirm_channel` — the reply half of the channel
 * delivery round-trip. The model calls this with the `nonce` it read off a
 * delivered `<channel>` tag (typically the one minted by
 * `debug.push_test_channel`). The server records the confirmation timestamp
 * and whether the nonce matched the outstanding probe, and `server.health`
 * then surfaces the last confirmed-delivery time. Because the model can only
 * know the nonce if the push was actually delivered inline, a matching
 * confirmation is positive proof that channels are live.
 */
export const DebugConfirmChannelInput = z.object({
  nonce: z.string().min(1),
});

/**
 * Input for `debug.compare_rep_streams` — VMCP-02.29 Phase 1 parity tool.
 * Returns the analytics-derived vs firmware-anchored rep counts on a
 * slot's currently-active set so the divergence between the two pipelines
 * is observable without waiting for a `set.end` + persisted-row diff.
 *
 * `slot` defaults to 'primary' so single-slot callers don't need to think
 * about bilateral wiring. Returns a structured `{ active: false }` shape
 * when the slot has no armed set, so the tool is safe to call at any time.
 */
export const DebugCompareRepStreamsInput = z.object({
  slot: z.string().min(1).optional().default('primary'),
});
