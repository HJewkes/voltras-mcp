// `set.*` tool handlers (Wave 3B, Task 11).
//
// Owns the rep-recording set lifecycle exposed over MCP:
//   * `set.start` — begins a new set, snapshotting device settings at start
//     time so the persisted row reflects the configuration the user lifted
//     against (not whatever the device drifts to mid-set).
//   * `set.end` — finalizes the active set, persisting reps and the cached
//     device snapshot.
//   * `set.live_metrics` — polling fallback for `voltra://set/active`,
//     returning `{ active: false }` when no set is in flight (AC-12).
//
// `SetStartInput` is `z.object({})` by design (R18 / Task 03's handoff): all
// set metadata derives from `state.live.snapshotDevice()`. The "snapshot at
// start" choice is implemented via a per-handler `Map<setId, DeviceSnapshot>`
// — the same closure that owns the live state holds the snapshot until
// `set.end` consumes it. Re-reading the device at `set.end` would let
// mid-set `device.set_weight` calls retroactively rewrite the stored
// `weightLbs`, which is the wrong shape for analytics consumers.
//
// Error-channel convention matches `session-tools.ts`: a thrown `ToolError`
// with a `code` field is preserved by `mapSdkError` -> `errorResult`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { ServerState } from '../state/server-state.js';
import { SetEndInput, SetLiveMetricsInput, SetStartInput } from '../schemas/set.js';
import type { StoredRep, StoredSet } from '../store/types.js';
import type { ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import { wrapHandler } from './helpers.js';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Register `set.start`, `set.end`, `set.live_metrics`.
 *
 * The shared `deviceSnapshots` map persists between `set.start` and the
 * matching `set.end` so the snapshot taken at start time survives any
 * intervening `applySettings` mutations.
 */
export function registerSetTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const deviceSnapshots = new Map<string, DeviceSnapshot>();

  install(
    placeholders,
    'set.start',
    SetStartInput,
    wrapHandler(SetStartInput, () => startSet(state, deviceSnapshots)),
  );
  install(
    placeholders,
    'set.end',
    SetEndInput,
    wrapHandler(SetEndInput, () => endSet(state, deviceSnapshots)),
  );
  install(
    placeholders,
    'set.live_metrics',
    SetLiveMetricsInput,
    wrapHandler(SetLiveMetricsInput, () => liveMetrics(state)),
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
}

async function startSet(
  state: ServerState,
  deviceSnapshots: Map<string, DeviceSnapshot>,
): Promise<{ setId: string }> {
  const session = state.live.session;
  if (session === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active. Call session.start first.');
  }
  if (state.live.set !== undefined) {
    throw new ToolError('SET_ALREADY_ACTIVE', 'A set is already active.');
  }

  const setId = randomUUID();
  const startedAt = new Date().toISOString();
  state.live.startSet({
    setId,
    sessionId: session.sessionId,
    startedAt,
    reps: [],
    status: 'active',
  });
  deviceSnapshots.set(setId, state.live.snapshotDevice());
  return Promise.resolve({ setId });
}

async function endSet(
  state: ServerState,
  deviceSnapshots: Map<string, DeviceSnapshot>,
): Promise<{ ok: true; reps: number }> {
  if (state.live.set === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active. Call set.start first.');
  }

  const setId = state.live.set.setId;
  const finalized = state.live.endSet();
  // `live.set` was defined a moment ago, so `endSet()` returned a value.
  if (finalized === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active.');
  }

  // Use the snapshot captured at `set.start`; fall back to the current
  // snapshot if it was somehow missing (defensive — should not happen).
  const device = deviceSnapshots.get(setId) ?? state.live.snapshotDevice();
  deviceSnapshots.delete(setId);

  const stored = toStoredSet(finalized, device);
  await state.store.putSet(stored);
  return { ok: true, reps: stored.reps.length };
}

async function liveMetrics(state: ServerState): Promise<{ active: false } | ActiveSet> {
  const snapshot = state.live.snapshotSet();
  return Promise.resolve(snapshot ?? { active: false });
}

function toStoredSet(active: ActiveSet, device: DeviceSnapshot): StoredSet {
  const reps: StoredRep[] = active.reps.map((rep, index) => ({
    ...rep,
    id: randomUUID(),
    setId: active.setId,
    index,
  }));
  return {
    id: active.setId,
    sessionId: active.sessionId,
    startedAt: active.startedAt,
    endedAt: active.endedAt ?? new Date().toISOString(),
    partial: active.status === 'partial',
    ...(active.partialReason !== undefined ? { partialReason: active.partialReason } : {}),
    trainingMode: device.trainingMode ?? 'Unknown',
    weightLbs: device.weightLbs ?? 0,
    reps,
  };
}
