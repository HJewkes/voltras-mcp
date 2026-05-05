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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { configureLogger, log } from '../logger.js';
import { LiveState, type DeviceSnapshot } from './live-state.js';
import type { SessionStore } from '../store/types.js';
import { SqliteSessionStore } from '../store/sqlite-store.js';
import { ExerciseService } from '../exercises/exercise-service.js';
import { selectAdapter } from '../adapter/select.js';
import { noopChannelPublisher, type ChannelPublisher } from './channel-publisher.js';
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
  /**
   * Tear-down hook returned by the per-slot event-bridge wirer. Set when the
   * bridge subscribes to this slot's `client`; calling it unsubscribes every
   * `on*` listener the bridge installed. `removeSlot` and `resetPrimarySlot`
   * invoke it before swapping the underlying client so the old subscription
   * doesn't go on receiving events from a stale handle. Optional because some
   * tests construct SlotState shapes directly without running the wirer; in
   * that case the field is undefined and teardown is a no-op.
   */
  unwireBridge?: () => void;
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
 * Step 4 of P0 dual-Voltras support: after inserting the slot the helper
 * subscribes the event bridge to the new slot's client and stashes the
 * unwire hook on the slot itself. The bridge wirer is loaded lazily so we
 * don't depend on the event-bridge module at server-state's import time
 * (event-bridge depends on set-tools which depends on this module — lazy
 * loading breaks the cycle). When `state.server` is undefined (test wiring
 * that omits the McpServer handle) the wirer returns a no-op unwire fn.
 */
export function createSlot(state: ServerState, slotId: string, client: VoltraClient): SlotState {
  if (state.slots.has(slotId)) {
    throw new Error(`Slot \`${slotId}\` already exists.`);
  }
  // The cap counts slots whose client is actually connected — the
  // bootstrap-only primary slot (parameter-less VoltraClient, never wired
  // to a device) does NOT count, so a true bilateral flow can allocate
  // both `'left'` and `'right'` even though primary is also present in
  // the map. Once the user binds a device to primary (single-device flow,
  // no explicit slot arg), primary's client.isConnected flips true and it
  // joins the count.
  if (countConnectedSlots(state) >= MAX_SLOTS) {
    throw new Error(`Maximum of ${MAX_SLOTS} slots supported in this release.`);
  }
  const slot: SlotState = { slotId, client, live: new LiveState() };
  state.slots.set(slotId, slot);
  slot.unwireBridge = invokeBridgeWirer(state, slot);
  return slot;
}

/**
 * Count slots whose underlying client is actively connected to a device.
 * The bootstrap primary slot starts with a parameter-less `VoltraClient`
 * (`isConnected === false`), so it's invisible to the cap until the user
 * runs `device.connect` against it. Adopted in Step 4 of P0 dual-Voltras
 * so a true bilateral allocation (`'left'` + `'right'`) doesn't trip
 * SLOT_LIMIT_EXCEEDED solely because of primary's bookkeeping presence.
 */
function countConnectedSlots(state: ServerState): number {
  let count = 0;
  for (const slot of state.slots.values()) {
    if (slot.client.isConnected) {
      count += 1;
    }
  }
  return count;
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
  const slot = state.slots.get(slotId);
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  slot.unwireBridge?.();
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
 * Step 4 of P0 dual-Voltras support: unwires the existing bridge before
 * swapping client / LiveState so listeners on the old handle can't fire
 * mid-rebind, then re-wires the bridge against the fresh shape. The
 * `slot.unwireBridge` field is replaced with the new tear-down hook.
 */
export function resetPrimarySlot(state: ServerState): void {
  const slot = state.slots.get(PRIMARY_SLOT);
  if (!slot) {
    throw new Error(`Primary slot is missing — bootstrap was never run.`);
  }
  slot.unwireBridge?.();
  slot.client = new VoltraClient();
  slot.live = new LiveState();
  slot.unwireBridge = invokeBridgeWirer(state, slot);
}

/**
 * Invoke the event-bridge wirer attached to `state.bridgeWirer` (if any),
 * returning the unwire hook the caller stashes on `slot.unwireBridge`. The
 * wirer is a function pointer rather than a top-level import to avoid a
 * circular import cycle (event-bridge → set-tools → server-state). Server
 * bootstrap installs the real wirer onto state before any slot allocation
 * happens; tests that construct SlotState without a wirer get a no-op
 * unwire.
 */
function invokeBridgeWirer(state: ServerState, slot: SlotState): () => void {
  if (state.bridgeWirer === undefined) {
    return () => undefined;
  }
  return state.bridgeWirer(state, slot);
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
  /**
   * Live `McpServer` handle, set by `runServer` once the server is
   * constructed. The event bridge needs this to publish
   * `notifications/resource_updated` hints to the host. Optional because
   * `bootstrapState` finishes before the server is available; it gets
   * filled in (alongside `channels` and `bridgeWirer`) immediately after
   * bootstrap returns. Tests that don't observe resource updates can
   * leave it undefined — the per-slot bridge wirer detects the absence
   * and skips subscription rather than NPE'ing.
   */
  server?: McpServer;
  /**
   * Function pointer that subscribes the event bridge to a single slot's
   * client. Indirected through `state` (rather than a top-level import in
   * `createSlot` / `resetPrimarySlot`) to break the circular import cycle
   * between `server-state.ts`, `event-bridge.ts`, and `tools/set-tools.ts`.
   * `runServer` (or test harnesses that need bridge wiring) install the
   * concrete `wireBridgeForSlot` here right after bootstrap. When unset,
   * slot mutators skip wiring — useful for state-layer unit tests that
   * exercise the slot map shape without the bridge.
   */
  bridgeWirer?: (state: ServerState, slot: SlotState) => () => void;
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
    const channels: ChannelPublisher = noopChannelPublisher;
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
