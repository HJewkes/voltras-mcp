// The canonical tool surface: every name VMCP exposes, plus how each one uses
// shared state (VMCP-01.60).
//
// The lists used to live in `server.ts` unexported, which is why the
// integration tests under `__tests__/integration/` each carry their own trimmed
// copy ("the source file does not export them (and we may not modify it)").
// Those copies are deliberate subsets, not stale duplicates, so they are left
// alone here — but new callers should import from this module.

/** Every tool name VMCP exposes in every adapter mode (R9, R11). */
export const CORE_TOOL_NAMES = [
  'device.scan',
  'device.set_passive_scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.set_damper_level',
  'device.set_assist_mode',
  'device.set_band_max_force',
  'device.set_isokinetic_target_speed',
  'device.set_isokinetic_ecc_mode',
  'device.set_isokinetic_ecc_speed_limit',
  'device.set_isokinetic_ecc_const_weight',
  'device.set_isokinetic_ecc_overload_weight',
  'device.configure_isokinetic',
  'device.unload',
  'device.start_guided_load',
  'device.exit_guided_load',
  // <Bug-22> Rowing two-stage entry — replaces device.set_mode with mode=Rowing.
  'device.enter_row_mode',
  'device.start_row',
  // </Bug-22>
  'device.get_state',
  'device.send_raw',
  'bilateral.cascade',
  'slot.swap',
  'session.start',
  'session.end',
  'session.set_exercise',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
  'metrics.compute',
  'exercise.search',
  'exercise.get',
  'timer.wait',
  'timer.start',
  'timer.cancel',
  'server.health',
  'debug.recent_frames',
  'debug.recent_events',
  'debug.recording_status',
  'debug.push_test_channel',
  'debug.confirm_channel',
  'debug.compare_rep_streams',
  'system.speak',
  'system.listen_start',
  'system.listen_stop',
  // Device write-lease (VMCP-01.61). Exempt from lease enforcement itself —
  // see LEASE_EXEMPT_TOOLS in lease-guard.ts.
  'system.lease_status',
  'system.lease_acquire',
  'system.lease_release',
  'slot.identify',
  'slot.bind',
  'slot.bindings_list',
  'slot.unbind',
  'progression.get_for_exercise',
  'isometric.measure_max',
  'isometric.measure_imbalance',
  // Block-periodization plan CRUD (v3 schema). See src/tools/plan-tools.ts.
  'plan.program.create',
  'plan.program.list',
  'plan.program.get',
  'plan.program.archive',
  'plan.block.create',
  'plan.block.list_for_program',
  'plan.week.create',
  'plan.week.list_for_block',
  'plan.template.create',
  'plan.template.get',
  'plan.template.list_for_week',
  'plan.exercise.create',
  'plan.exercise.list_for_template',
  // Progression / session-link tools (compose the CRUD layer above).
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
  // Self-reported training background (VW-96 Wave 3). Storage only — no
  // tier derivation here. See src/tools/profile-tools.ts.
  'profile.set_training_background',
  'profile.get_training_background',
] as const;

/** Mock-only tools (R11), registered when `VOLTRA_ADAPTER=mock`. */
export const MOCK_TOOL_NAMES = ['mock.configure', 'mock.inject_error'] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type MockToolName = (typeof MOCK_TOOL_NAMES)[number];
export type ToolName = CoreToolName | MockToolName;

/**
 * How a tool uses shared state.
 *
 * - `read` — safe for a client that holds no write-lease. Touches no shared
 *   mutable state, issues no BLE command, persists nothing, and claims no
 *   exclusive OS resource. An observer session may call it freely.
 * - `write` — must hold the write-lease (VMCP-01.61). Mutates `ServerState` /
 *   `SlotState`, drives the radio, writes to SQLite or disk, claims the mic or
 *   speaker, or otherwise interferes across sessions.
 *
 * `lease-guard.ts` consumes this: every `write` tool is wrapped so the call
 * acquires the device write-lease first, and every `read` tool is left alone.
 * Because the table is exhaustive over `ToolName`, adding a tool without
 * classifying it is a tsc error — enforcement cannot be forgotten.
 */
export type ToolAccess = 'read' | 'write';

/**
 * Access class for every tool. Exhaustive by construction: `Record<ToolName,
 * …>` makes tsc reject a missing entry, and `tool-registry.test.ts` catches the
 * inverse (a stale entry for a tool that no longer exists).
 *
 * Three entries are `write` by POLICY rather than by literal state mutation —
 * each verified against its handler, each annotated below. When in doubt the
 * classification is `write`: a wrongly-`read` tool lets an observer session
 * interfere with a live lift, while a wrongly-`write` one only costs an
 * unnecessary lease error.
 */
export const TOOL_ACCESS: Record<ToolName, ToolAccess> = {
  // Radio. `device.scan` mutates nothing in this repo, but it drives the BLE
  // radio through the SDK manager and so contends with noble's write mutex —
  // `write` on that basis alone (device-tools.ts:393).
  'device.scan': 'write',
  'device.set_passive_scan': 'write',
  'device.connect': 'write',
  'device.disconnect': 'write',
  'device.set_weight': 'write',
  'device.set_mode': 'write',
  'device.set_chains': 'write',
  'device.set_eccentric': 'write',
  'device.set_damper_level': 'write',
  'device.set_assist_mode': 'write',
  'device.set_band_max_force': 'write',
  'device.set_isokinetic_target_speed': 'write',
  'device.set_isokinetic_ecc_mode': 'write',
  'device.set_isokinetic_ecc_speed_limit': 'write',
  'device.set_isokinetic_ecc_const_weight': 'write',
  'device.set_isokinetic_ecc_overload_weight': 'write',
  'device.configure_isokinetic': 'write',
  'device.unload': 'write',
  'device.start_guided_load': 'write',
  'device.exit_guided_load': 'write',
  'device.enter_row_mode': 'write',
  'device.start_row': 'write',
  'device.get_state': 'read',
  'device.send_raw': 'write',
  'bilateral.cascade': 'write',
  'slot.swap': 'write',

  'session.start': 'write',
  'session.end': 'write',
  'session.set_exercise': 'write',
  'session.list': 'read',
  'session.get': 'read',

  'set.start': 'write',
  'set.end': 'write',
  'set.live_metrics': 'read',
  'set.get': 'read',
  'metrics.compute': 'read',

  'exercise.search': 'read',
  'exercise.get': 'read',

  // POLICY. `timer.wait` mutates no state — its in-flight flag is a bare
  // module-level `let` in timer-tools.ts:67, shared process-wide with no slot
  // or session scoping. So a second session calling it collides with the first
  // (`BUSY`), and `timer.cancel` with no `timer_id` cancels whoever's wait is
  // in flight. Cross-session interference with zero state mutation — `write`.
  'timer.wait': 'write',
  'timer.start': 'write',
  'timer.cancel': 'write',

  'server.health': 'read',
  'debug.recent_frames': 'read',
  'debug.recent_events': 'read',
  'debug.recording_status': 'read',
  // Both mutate `state.channelDelivery` (debug-tools.ts:171, :181), and
  // push_test_channel also emits a real channel notification.
  'debug.push_test_channel': 'write',
  'debug.confirm_channel': 'write',
  'debug.compare_rep_streams': 'read',

  // Exclusive OS resources: the mic and the speaker.
  'system.speak': 'write',
  'system.listen_start': 'write',
  'system.listen_stop': 'write',

  // `lease_status` only reads. `acquire`/`release` mutate the lease, so they
  // are `write` — this table describes what a tool DOES, not whether it is
  // gated, and all three are exempt from gating so the lease is obtainable.
  'system.lease_status': 'read',
  'system.lease_acquire': 'write',
  'system.lease_release': 'write',

  'slot.identify': 'write',
  'slot.bind': 'write',
  'slot.bindings_list': 'read',
  'slot.unbind': 'write',

  'progression.get_for_exercise': 'read',

  // POLICY. `isometric.measure_max` is literally a `read` — it issues no BLE
  // command and persists nothing, only listening passively via `onFrame`
  // (isometric-tools.ts:229). But it is a multi-minute assessment that assumes
  // the caller has the device configured for an isometric hold, i.e. it assumes
  // device control. Running it from an observer session would report numbers
  // for whatever the lease holder happens to be doing. `write`.
  'isometric.measure_max': 'write',
  'isometric.measure_imbalance': 'write',

  'plan.program.create': 'write',
  'plan.program.list': 'read',
  'plan.program.get': 'read',
  'plan.program.archive': 'write',
  'plan.block.create': 'write',
  'plan.block.list_for_program': 'read',
  'plan.week.create': 'write',
  'plan.week.list_for_block': 'read',
  'plan.template.create': 'write',
  'plan.template.get': 'read',
  'plan.template.list_for_week': 'read',
  'plan.exercise.create': 'write',
  'plan.exercise.list_for_template': 'read',
  'plan.next_workout': 'read',
  'plan.complete_workout': 'write',
  'plan.attach_to_session': 'write',
  'plan.suggest_progression': 'read',

  'profile.set_training_background': 'write',
  'profile.get_training_background': 'read',

  'mock.configure': 'write',
  'mock.inject_error': 'write',
};

/** Access class for `name`, or `undefined` if it is not a known tool. */
export function toolAccess(name: string): ToolAccess | undefined {
  return TOOL_ACCESS[name as ToolName];
}
