// `debug.*` diagnostic tools — surface the bridge's ring buffers and expose
// channel push smoke-testing.
//
// Three tools:
//   * `debug.recent_frames(n)` — last N telemetry frames the bridge captured
//     via `client.onFrame`. Strictly numeric / typed values; never any raw
//     protocol bytes.
//   * `debug.recent_events(n, types?, includeRawFrames?)` — last N bridge-level
//     events (rep_boundary, set_boundary, settings_update, connection_state_change,
//     etc.) with timestamps and lightweight structured payloads. Supports a
//     `types` allowlist and an `includeRawFrames` opt-in for the pre-decode
//     raw BLE frame channel (excluded by default — at 40 Hz it dominates the
//     buffer and was the firehose problem VMCP-02.10 fixed).
//   * `debug.push_test_channel({ content, meta, nonce? })` — fires a single
//     `claude/channel` notification through the publisher so a developer
//     can verify channel delivery (host launched with `--channels`) without
//     attaching real hardware. Injects a `nonce` into the delivered meta and
//     records it as the outstanding delivery probe.
//   * `debug.confirm_channel({ nonce })` — the reply half of the delivery
//     round-trip: the model echoes the nonce it read off the delivered
//     `<channel>` tag, which the server records as a confirmed delivery and
//     `server.health` surfaces as `channelsLastConfirmedAt` (VMCP-01.42
//     follow-up).
//
// `recent_*` default to the schema's default `n` (50), capped at the buffer's
// configured capacity (default 256, override via `VMCP_DEBUG_BUFFER_SIZE`).
// The buffers are process-local — a server restart drops them.

import { randomUUID } from 'node:crypto';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  DebugCompareRepStreamsInput,
  DebugConfirmChannelInput,
  DebugPushTestChannelInput,
  DebugRecentEventsInput,
  DebugRecentFramesInput,
} from '../schemas/debug.js';
import { getDebugBuffers } from '../state/debug-buffer.js';
import type { ServerState } from '../state/server-state.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

// VMCP-02.33: the `types` filter matches the diagnostic ring-buffer `type`
// names — which are a DISTINCT namespace from the `claude/channel`
// `event_type` names. e.g. the ring-buffer `rep_boundary` is what underlies
// the channel's `rep_finalized`; filtering this tool by a channel name like
// `rep_finalized` / `setting_coerced` matches nothing. The example types
// below are all real DebugEvent.type values.
export const RECENT_EVENTS_DESCRIPTION =
  'Returns the most recent bridge-level events from the diagnostic ring buffer (rep_boundary, set_boundary, summary, pre_summary, settings_update, connection_state_change, guided_load_state, state_dump, send_raw, raw_frame). ' +
  'Optional `types` filters to only events whose `type` field matches one of the supplied strings. ' +
  'These are ring-buffer diagnostic names, NOT the `claude/channel` event_type names (e.g. ring-buffer `rep_boundary` underlies the channel `rep_finalized`; `connection_state_change` underlies the channel `connection_changed`). ' +
  'Optional `includeRawFrames` (default `false`) controls whether raw BLE `raw_frame` entries are included — they are excluded by default because at 40 Hz they dominate the buffer. ' +
  'Examples: ' +
  '`{}` returns parsed events only; ' +
  '`{ types: ["rep_boundary"] }` returns only rep-boundary events; ' +
  '`{ types: ["set_boundary", "guided_load_state"] }` returns only set-boundary and guided-load phase events; ' +
  '`{ includeRawFrames: true }` restores the legacy firehose (parsed events + raw frames).';

/**
 * Hot-swap the `debug.*` placeholders with their real handlers. The
 * recent_* tools read from the singleton ring buffers populated by the
 * event bridge; `push_test_channel` calls into `state.channels` so the
 * smoke test exercises the same publisher used by the bridge and set
 * lifecycle tools.
 */
export function registerDebugTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'debug.recent_frames',
    DebugRecentFramesInput,
    wrapHandler(DebugRecentFramesInput, (input) => {
      const buffers = getDebugBuffers();
      const frames = buffers.frames.recent(input.n);
      return Promise.resolve({
        capacity: buffers.capacity,
        size: buffers.frames.length(),
        returned: frames.length,
        frames,
      });
    }),
  );
  install(
    placeholders,
    'debug.recent_events',
    DebugRecentEventsInput,
    wrapHandler(DebugRecentEventsInput, (input) => {
      const buffers = getDebugBuffers();
      // Walk the full retained buffer first so the type/raw-frame filters
      // operate over every event the bridge captured, then take the most
      // recent `n` of the matching subset. Slicing by `n` before filtering
      // would silently drop matches when raw_frame entries dominate the
      // tail of the buffer (the firehose case this filter exists to fix).
      const all = buffers.events.recent(buffers.events.length());
      const typeFilter =
        Array.isArray(input.types) && input.types.length > 0 ? new Set(input.types) : undefined;
      const filtered = all.filter((event) => {
        if (!input.includeRawFrames && event.type === 'raw_frame') return false;
        if (typeFilter !== undefined && !typeFilter.has(event.type)) return false;
        return true;
      });
      const events = filtered.slice(-input.n);
      return Promise.resolve({
        capacity: buffers.capacity,
        size: buffers.events.length(),
        returned: events.length,
        events,
      });
    }),
    RECENT_EVENTS_DESCRIPTION,
  );
  install(
    placeholders,
    'debug.push_test_channel',
    DebugPushTestChannelInput,
    wrapHandler(DebugPushTestChannelInput, (input) => {
      // Mint a nonce (or honour a caller-supplied one), record it as the
      // outstanding probe, and inject it into the delivered meta so the model
      // can echo it back via debug.confirm_channel to prove delivery.
      const nonce = input.nonce ?? randomUUID();
      state.channelDelivery.recordProbe(nonce);
      state.channels.publish({ content: input.content, meta: { ...input.meta, nonce } });
      return Promise.resolve({ ok: true, nonce });
    }),
  );
  install(
    placeholders,
    'debug.confirm_channel',
    DebugConfirmChannelInput,
    wrapHandler(DebugConfirmChannelInput, (input) => {
      const snapshot = state.channelDelivery.recordConfirmation(input.nonce);
      return Promise.resolve({
        ok: true,
        matchedProbe: snapshot.lastConfirmationMatchedProbe,
        confirmations: snapshot.confirmations,
        lastConfirmedAt: snapshot.lastConfirmedAt,
      });
    }),
    CONFIRM_CHANNEL_DESCRIPTION,
  );
  install(
    placeholders,
    'debug.compare_rep_streams',
    DebugCompareRepStreamsInput,
    wrapHandler(DebugCompareRepStreamsInput, (input) => {
      const slot = state.slots.get(input.slot);
      if (slot === undefined) {
        return Promise.resolve({
          slot: input.slot,
          active: false,
          reason: 'unknown_slot',
        });
      }
      const set = slot.live.snapshotSet();
      if (set === undefined) {
        return Promise.resolve({
          slot: input.slot,
          active: false,
          reason: 'no_active_set',
        });
      }
      const analyticsCount = set.reps.length;
      const firmwareCount = set.firmwareReps?.length ?? 0;
      return Promise.resolve({
        slot: input.slot,
        active: true,
        set_id: set.setId,
        analytics_count: analyticsCount,
        firmware_count: firmwareCount,
        divergence: analyticsCount - firmwareCount,
      });
    }),
    COMPARE_REP_STREAMS_DESCRIPTION,
  );
}

const CONFIRM_CHANNEL_DESCRIPTION =
  'Confirms a `claude/channel` push was actually delivered — the reply half of the delivery round-trip. ' +
  'Call this with the `nonce` you read off a delivered `<channel>` tag (e.g. the nonce returned by / injected into a `debug.push_test_channel` probe). ' +
  'The server records the confirmation timestamp, which `server.health` then reports as `channelsLastConfirmedAt`. ' +
  '`matchedProbe: true` means the nonce matched the outstanding probe — positive proof channels are live, since you could only know the nonce by receiving the push inline. ' +
  'Typical flow: call `debug.push_test_channel` → read the `nonce` from the `<channel>` tag it delivers → call `debug.confirm_channel({ nonce })`.';

const COMPARE_REP_STREAMS_DESCRIPTION =
  "VMCP-02.29 Phase 1 parity tool. Returns side-by-side rep counts on the slot's currently-active set: " +
  '`analytics_count` (eccentric→concentric boundaries from the workout-analytics frame pipeline) vs ' +
  "`firmware_count` (firmware-anchored `onPerRep` 'return' boundaries). " +
  '`divergence = analytics_count - firmware_count` — positive means analytics is counting more reps than the firmware. ' +
  'Returns `{ active: false, reason: "no_active_set" | "unknown_slot" }` when there is no set to compare. ' +
  'Phase 1 is measurement-gathering only; no behavioral change to set/rep handling.';
