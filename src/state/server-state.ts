// Aggregate state container assembled by `bootstrapState()` and threaded into
// every tool/resource registration as a single argument.
//
// Wave 1 shipped this file as a typed STUB; Wave 2C (Task 09) finalizes
// `bootstrapState` with the real implementation: open the BLE adapter via
// `selectAdapter`, open the SQLite store, construct the long-lived
// collaborators, and return the wired `ServerState`.
//
// ── Partial-init cleanup (EC-02) ──────────────────────────────────────────
//
// Cleanup follows reverse-acquisition order. The adapter manager opens
// first (synchronous construction); the SQLite store opens next
// (synchronous, may throw on schema mismatch or lock contention). If
// store-open throws, manager is disposed before rethrow. If a later
// construction step throws, both store and manager are released. The
// pre-existing manager release is `dispose()` (synchronous, void) — not
// `close()`, which is not part of the SDK's surface.
//
// ── Why each slot's `client` is constructed parameter-less ───────────────
//
// Each `SlotState.client` is a `VoltraClient` allocated at bootstrap with no
// adapter. `manager.connect(device)` happens later, when the `device.connect`
// tool runs against the slot. Wave 3's `device.connect` assigns an adapter
// and calls `client.connect(device)` directly. Subscribing to events on a
// slot's client (via `wireEventBridge` in `runServer`) is safe because the
// listener slots persist across `setAdapter`. Step 1 of P0 dual-Voltras
// support seeds a single `PRIMARY_SLOT` so existing single-device flows are
// unchanged; later steps add slot allocation tools.
//
// Do NOT remove or change the exported names/shapes; downstream wiring
// (event-bridge, tool registries) imports them by these exact identifiers.

import { VoltraClient } from '@voltras/node-sdk';
import type { VoltraManager } from '@voltras/node-sdk';

import type { Config } from '../config.js';
import { configureLogger, log } from '../logger.js';
import { LiveState, type DeviceSnapshot } from './live-state.js';
import type { SessionStore } from '../store/types.js';
import { SqliteSessionStore } from '../store/sqlite-store.js';
import { ExerciseService } from '../exercises/exercise-service.js';
import { selectAdapter } from '../adapter/select.js';
import type { ChannelPublisher } from './channel-publisher.js';
import { SetWatchdog } from './set-watchdog.js';
import type { PushTimer } from '../tools/timer-tools.js';

/**
 * Per-slot processing unit. A slot owns one BLE connection (`client`) and the
 * single processing pipeline (`live`) attached to it. Step 1 of P0 dual-Voltras
 * support introduces a single `'primary'` slot at bootstrap so all existing
 * single-device flows are unchanged; subsequent waves will allow allocating
 * additional slots and threading an optional `slot` argument through tool
 * schemas.
 */
export interface SlotState {
  slotId: string;
  client: VoltraClient;
  live: LiveState;
}

export const PRIMARY_SLOT = 'primary' as const;

/**
 * Resolve a slot by id, defaulting to the primary slot. Throws when the id is
 * unknown so callers don't silently fall through to a partially-initialized
 * shape (a typo in `slotId` should be loud, not a runtime undefined).
 */
export function getSlot(state: ServerState, slotId: string = PRIMARY_SLOT): SlotState {
  const slot = state.slots.get(slotId);
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  return slot;
}

/**
 * Soft cap on connected slots in the initial dual-Voltras release. Two is
 * the only shape we exercise (left / right for bilateral lifts); a third
 * slot has no UX or analytics story yet, so the limit lives at the state
 * layer rather than as a tool-schema enum to keep the surface flexible if
 * we lift the cap later.
 */
export const MAX_SLOTS = 2;

/**
 * Allocate a brand-new slot. Each slot owns its own `LiveState` so the
 * session/set/rep pipelines run independently — sharing live state across
 * slots would let frames from one device mutate the other's set boundaries
 * and rep buffer. The supplied `client` becomes the slot's BLE handle; the
 * caller is responsible for having already connected it via
 * `manager.connect(device)`.
 *
 * Step 3 of P0 dual-Voltras support: this helper is pure data — it does NOT
 * subscribe the event bridge to the new client. Step 4 wires the bridge
 * per-slot with channel-meta tagging; until then, frames / rep boundaries /
 * connection events from non-primary slots are not bridged through
 * `wireEventBridge`. Callers see the limitation immediately on
 * `set.live_metrics` for the new slot — `LiveState` reports an empty rep
 * buffer because no frames are flowing in.
 */
export function createSlot(state: ServerState, slotId: string, client: VoltraClient): SlotState {
  if (state.slots.has(slotId)) {
    throw new Error(`Slot \`${slotId}\` already exists.`);
  }
  if (state.slots.size >= MAX_SLOTS) {
    throw new Error(`Maximum of ${MAX_SLOTS} slots supported in this release.`);
  }
  const slot: SlotState = { slotId, client, live: new LiveState() };
  state.slots.set(slotId, slot);
  return slot;
}

/**
 * Tear down a non-primary slot. The caller must have already issued the
 * BLE-level disconnect via `state.manager.disconnect(deviceId)` — this
 * helper handles only the in-memory removal so the disconnect path stays
 * idempotent against a half-torn-down adapter.
 *
 * Errors when called on `'primary'` because the primary slot must persist
 * across disconnects: re-connecting the primary device should not require
 * re-allocating the slot. Use `resetPrimarySlot` instead.
 */
export function removeSlot(state: ServerState, slotId: string): void {
  if (slotId === PRIMARY_SLOT) {
    throw new Error(`Cannot remove the primary slot — use resetPrimarySlot instead.`);
  }
  if (!state.slots.has(slotId)) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  state.slots.delete(slotId);
}

/**
 * Reset the primary slot back to its bootstrap shape: a fresh
 * parameter-less `VoltraClient` (so `device.connect` can rebind it) and a
 * fresh `LiveState` (so a stale session/set from the prior connection can't
 * leak into the next one). The slot itself stays in `state.slots` because
 * a single-device flow never calls `device.connect` with an explicit slot
 * id, so the entry must remain resolvable for the default lookup.
 *
 * Step 3 of P0 dual-Voltras support: this helper does NOT re-wire the
 * event bridge. The bridge in `runServer` was subscribed to the original
 * primary client; `device.connect`'s subsequent re-wire on reconnect is
 * what re-establishes per-event delivery.
 */
export function resetPrimarySlot(state: ServerState): void {
  const slot = state.slots.get(PRIMARY_SLOT);
  if (!slot) {
    throw new Error(`Primary slot is missing — bootstrap was never run.`);
  }
  slot.client = new VoltraClient();
  slot.live = new LiveState();
}

export interface ServerState {
  config: Config;
  manager: VoltraManager;
  /**
   * Per-slot connection + processing state, keyed by `slotId`. Bootstrap
   * always seeds a single `PRIMARY_SLOT` entry so existing single-device
   * flows resolve via `getSlot(state)` with no argument. Multi-slot
   * allocation is a later wave.
   */
  slots: Map<string, SlotState>;
  store: SessionStore;
  exercises: ExerciseService;
  /**
   * Publisher for `claude/channel` push events. Wired in `runServer` after
   * the McpServer is constructed (see `server.ts`), then attached to this
   * state object before tool registration. Tool handlers can call
   * `state.channels.publish(...)` to wake the model on lifecycle events
   * without requiring a polling tool. Fire-and-forget: when the host wasn't
   * launched with `--channels`, deliveries are silently dropped.
   */
  channels: ChannelPublisher;
  /**
   * In-flight non-blocking timers started via `timer.start`. Keyed by
   * `timer_id`. Each entry tracks the underlying `setTimeout` handle plus
   * the metadata needed to publish the `timer_complete` channel event when
   * the timer fires. Cancelling a timer via `timer.cancel` clears the
   * handle and removes the entry. The blocking `timer.wait` timer keeps
   * its module-scoped singleton in `timer-tools.ts` and is NOT in this
   * map.
   */
  timers: Map<string, PushTimer>;
  /**
   * Device snapshot captured at `set.start` time, keyed by setId. Persists
   * until the matching set is finalized so the stored row reflects the
   * configuration the user lifted against (not whatever the device drifts
   * to mid-set). Lives on the shared state container so two finalize paths
   * — the explicit `set.end` tool and the bridge's autonomous
   * `set_ended_by_device` handler — can both consume it.
   */
  setStartDeviceSnapshots: Map<string, DeviceSnapshot>;
  /**
   * Per-set idle-timeout watchdog backing the trigger DSL's
   * `idle_timeout_ms` spec. Armed at `set.start` when the watch config
   * registers any idle thresholds (smallest threshold wins, one watchdog
   * per set), reset on every rep_finalized boundary, and cancelled in
   * `finalizeSet` so any termination path clears the timer.
   */
  setWatchdog: SetWatchdog;
}

/**
 * Bring up every long-lived collaborator the server needs. On any failure,
 * roll back resources opened so far in reverse order before rethrowing
 * (EC-02). Returns a fully wired `ServerState`; subscribing the SDK event
 * bridge is `runServer`'s responsibility once it has the `McpServer` handle.
 */
export async function bootstrapState(config: Config): Promise<ServerState> {
  configureLogger(config);
  const manager = selectAdapter(config);

  let store: SqliteSessionStore;
  try {
    store = SqliteSessionStore.open(config.dbPath);
  } catch (err) {
    log.debug('bootstrapState: SQLite open failed — disposing adapter manager');
    safeDisposeManager(manager);
    throw err;
  }

  try {
    const client = new VoltraClient();
    const live = new LiveState();
    const exercises = new ExerciseService();
    // Default to a no-op publisher; `runServer` overwrites this with an
    // `McpChannelPublisher` once the McpServer instance is available. Tests
    // that don't care about channel pushes can leave the no-op in place.
    const channels: ChannelPublisher = { publish: () => undefined };
    const timers = new Map<string, PushTimer>();
    const setStartDeviceSnapshots = new Map<string, DeviceSnapshot>();
    const setWatchdog = new SetWatchdog();
    const slots = new Map<string, SlotState>();
    slots.set(PRIMARY_SLOT, { slotId: PRIMARY_SLOT, client, live });
    return {
      config,
      manager,
      slots,
      store,
      exercises,
      channels,
      timers,
      setStartDeviceSnapshots,
      setWatchdog,
    };
  } catch (err) {
    log.debug('bootstrapState: post-store init failed — closing store + disposing manager');
    await safeCloseStore(store);
    safeDisposeManager(manager);
    throw err;
  }
}

function safeDisposeManager(manager: VoltraManager): void {
  try {
    manager.dispose();
  } catch (err) {
    log.warn('bootstrapState cleanup: manager.dispose() failed', err);
  }
}

async function safeCloseStore(store: SqliteSessionStore): Promise<void> {
  try {
    await store.close();
  } catch (err) {
    log.warn('bootstrapState cleanup: store.close() failed', err);
  }
}
