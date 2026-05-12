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
// Slot lifecycle helpers (`createSlot`, `removeSlot`, `resetPrimarySlot`)
// live in `slot-manager.ts` so this module can stay free of
// `event-bridge.ts` (which transitively depends on us via `set-tools.ts`).
//
// Do NOT remove or change the exported names/shapes; downstream wiring
// (event-bridge, tool registries) imports them by these exact identifiers.

import { VoltraClient } from '@voltras/node-sdk';
import type { VoltraManager } from '@voltras/node-sdk';
import { setCatalog } from '@voltras/workout-analytics';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';
import { configureLogger, log } from '../logger.js';
import { LiveState, type DeviceSnapshot } from './live-state.js';
import type { SessionStore } from '../store/types.js';
import { SqliteSessionStore } from '../store/sqlite-store.js';
import { ExerciseService } from '../exercises/exercise-service.js';
import { SEED_CABLE_EXERCISES } from '../exercises/seed-catalog.js';
import { selectAdapter } from '../adapter/select.js';
import { noopChannelPublisher, type ChannelPublisher } from './channel-publisher.js';
import { SetWatchdog } from './set-watchdog.js';
import { ModeRevertGuard } from './mode-revert-guard.js';
import { CoercionWatch } from './coercion-watch.js';
import type { PushTimer } from '../tools/timer-tools.js';
import { makeVoiceHolder, type VoiceListenerHolder } from '../tools/voice-tools.js';

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
   * Per-slot mode-revert guard (Bug 22, HIGH safety). Watches
   * `onSettingsUpdate` for trainingMode drift after the user requested a
   * mode via `session.start` / `set.start`. A latched abort state blocks
   * the next motor engagement and surfaces a `set_aborted_by_mode_revert`
   * channel event so PT Claude can explain the safety abort.
   *
   * One guard per slot — bilateral lifts get independent detectors. See
   * `mode-revert-guard.ts` for the state machine.
   */
  modeRevertGuard: ModeRevertGuard;
  /**
   * Per-slot ledger of recently-fired setters awaiting a device echo. Powers
   * the F2/F3 `setting_coerced` channel event: setter tool handlers wrap
   * their SDK call in `trackedSetterCall`, which registers a pending check
   * with the user-requested device-unit value. The bridge's `onStateDump`
   * / `onSettingsUpdate` handlers walk reported fields, call
   * `coercionWatch.observe`, and on a hit publish `setting_coerced` so the
   * model can explain the firmware's silent rewrite to the user.
   *
   * Cleared on slot teardown / reset so a pending registration on the
   * outgoing client can't fire against a stale frame on the new one.
   */
  coercionWatch: CoercionWatch;
  /**
   * Tear-down hook returned by the per-slot event-bridge wirer. Set when the
   * bridge subscribes to this slot's `client`; calling it unsubscribes every
   * `on*` listener the bridge installed. `removeSlot` and `resetPrimarySlot`
   * (in `slot-manager.ts`) invoke it before swapping the underlying client
   * so the old subscription doesn't go on receiving events from a stale
   * handle. Optional because `bootstrapState` constructs the primary slot
   * before the bridge is wired; `wireEventBridge(state)` populates it during
   * server startup (or in test setup).
   */
  unwireBridge?: () => void;
  /**
   * Inactivity-watchdog threshold (in ms) for the next bridge-minted
   * guided-load auto-set. Set by `device.start_guided_load` before the
   * SDK trigger fires; read once and cleared by the bridge's
   * `onGuidedLoadState`-driven auto-create in `ensureGuidedLoadSessionAndSet`.
   * Defaults to 30s when the tool caller doesn't override (VMCP-02.15).
   * Optional because explicit `set.start` callers bring their own watch
   * config and the bridge has no auto-create path outside guided-load.
   */
  pendingGuidedLoadInactivityMs?: number;
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
   * filled in (alongside `channels`) immediately after bootstrap returns.
   * Tests that don't observe resource updates can leave it undefined —
   * the per-slot bridge wirer detects the absence and skips subscription
   * rather than NPE'ing.
   */
  server?: McpServer;
  /**
   * Singleton holder for the voice listener — created at bootstrap with a
   * null inner listener; `system.listen_start` allocates the real
   * `VoiceListener` and parks it here so subsequent `listen_start` calls
   * are idempotent and `listen_stop` can find the right instance to tear
   * down. Off-by-default: the listener is null until the user explicitly
   * arms it. See `tools/voice-tools.ts` for the start/stop wiring.
   */
  voice: VoiceListenerHolder;
}

/**
 * Bring up every long-lived collaborator the server needs. On any failure,
 * roll back resources opened so far in reverse order before rethrowing
 * (EC-02). Returns a fully wired `ServerState`; subscribing the SDK event
 * bridge is `runServer`'s responsibility once it has the `McpServer` handle.
 *
 * The primary slot is created with no `unwireBridge` set — `wireEventBridge`
 * (called by `runServer` after bootstrap) populates it. Test fixtures that
 * skip `runServer` must call `wireEventBridge(state)` themselves to get the
 * same wiring.
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
    // Seed the analytics exercise catalog before constructing the service so
    // the first `exercise.search` call has data to return. The shipped
    // `@voltras/workout-analytics` catalog.json is empty (its collection
    // pipeline hasn't been run + published), so without this injection
    // every search returns []. `setCatalog` is global module-state inside
    // the analytics package; calling once at boot is sufficient. When the
    // upstream catalog ships, swap to `loadCatalog()` and drop the seed.
    setCatalog(SEED_CABLE_EXERCISES);
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
    slots.set(PRIMARY_SLOT, {
      slotId: PRIMARY_SLOT,
      client,
      live,
      modeRevertGuard: new ModeRevertGuard(),
      coercionWatch: new CoercionWatch(),
    });
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
      voice: makeVoiceHolder(),
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
