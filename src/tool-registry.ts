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
  // First writer of `self_reports` (VMCP-06.12 / B41). See
  // src/tools/session-tools.ts.
  'session.checkin',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.update',
  'set.get',
  'metrics.compute',
  'exercise.search',
  'exercise.get',
  // Name an inferred physical setup (VW-119). The ROM clustering derives which
  // sets share a bench height; only a human knows what the grouping IS, and
  // this is the only writer of that name. See src/tools/exercise-tools.ts.
  'exercise.confirm_setup',
  // Declare / undo a per-exercise "new chapter" boundary (VW-361). MANUAL
  // ONLY — there is no detector, by design. See src/tools/exercise-tools.ts.
  'exercise.mark_new_chapter',
  'exercise.retire_chapter',
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
  'system.set_cues',
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
  'isometric.measure_hold',
  'isometric.measure_max',
  'isometric.measure_imbalance',
  // Block-periodization plan CRUD (v3 schema). See src/tools/plan-tools.ts.
  'plan.program.create',
  'plan.program.list',
  'plan.program.get',
  'plan.program.archive',
  'plan.block.create',
  'plan.block.list_for_program',
  // Dated blocks (VW-474): append-only schedule writes and the calendar read.
  // See src/tools/plan-schedule-tools.ts.
  'plan.block.update',
  'plan.block.schedule',
  'plan.block.schedule_history',
  'plan.block.calendar',
  'plan.week.create',
  'plan.week.list_for_block',
  'plan.week.update',
  'plan.week.skip',
  'plan.template.create',
  'plan.template.get',
  'plan.template.list_for_week',
  'plan.exercise.create',
  'plan.exercise.list_for_template',
  // The one current-block rule (VW-475): which block and program are in force today.
  'plan.current_block',
  // The planning sitting's read (VW-476): writes nothing.
  'plan.block.planning_brief',
  // Progression / session-link tools (compose the CRUD layer above).
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
  // RP warm-up ramp for one exercise at one working load (VMCP-06.08 / B25).
  // Read-only and advisory: it returns rows, never starts a set. See
  // src/tools/warmup-ramp-tools.ts.
  'plan.warmup_ramp',
  // Self-reported training background (VW-96 Wave 3). Storage only — no
  // tier derivation here. See src/tools/profile-tools.ts.
  'profile.set_training_background',
  'profile.get_training_background',
  // Tier-signal MVP (VW-92) — crude ceiling only, no gate wiring. See
  // src/tools/tier-signal.ts.
  'profile.get_tier_signal',
  // Conservative tier-seeded starting prescription (VMCP-06.04 / B39). A READ
  // over the tier signal plus the stored self-report; advisory, applies
  // nothing. See src/profile/starting-prescription.ts.
  'profile.get_starting_prescription',
  // Session-0 completeness read (VW-148 / B42, B35, B36). Lists unanswered
  // intake fields in RP's own asking order and carries the cardiovascular
  // hard gate. Read-only, and every sentence it returns is quoted from the
  // coaching corpus. See src/profile/onboarding-gaps.ts.
  'profile.get_onboarding_gaps',
  // Observed diet phase (VW-149 / VW-150) — the first writer of `diet_phases`,
  // whose DDL and comparability clause both predate it. Self-report storage:
  // it suppresses no plateau and weights no comparison. See
  // src/tools/profile-tools.ts.
  'profile.set_diet_phase',
  // Self-reported bodyweight (VW-327) — the first writer of `body_metrics`.
  // Storage only, same posture as the rest of `profile.*`: advisory, no rate
  // verdict computed here. See src/tools/profile-tools.ts.
  'profile.log_bodyweight',
  'profile.get_body_metrics',
  // Weekly non-session self-report (VW-374) — a second `self_reports` writer
  // under its own `kind`, alongside `session.checkin`. Storage only; the
  // bodyweight-rate advisory (VW-367) is its first intended reader. See
  // src/tools/profile-tools.ts.
  'profile.log_weekly_checkin',
  'profile.get_weekly_checkin',
  // The accept/decline half of the recomposition re-ask (VW-369). Files the
  // answer in `advisory_decisions` and never touches `diet_phases`; the
  // proposal itself rides on `blockBoundary.recompReAsk`. See
  // src/tools/recomp-degradation.ts.
  'profile.respond_recomp_advisory',
  // Exercise-baseline STATE (I5 / B56, VW-116). Reads the confidence tier
  // backing an exercise; never baseline values. See src/tools/baseline-tools.ts.
  // `baselines.get` also returns a feature-agnostic `summaryMessage` and a
  // per-feature `gates` map — the advisory activation verdicts from
  // src/store/baseline-gate.ts (B57). Gates degrade features, never block them.
  'baselines.get',
  'baselines.recalc',
  // Execution-comparability gate (VW-90 / B15). DIAGNOSTIC ONLY — the real
  // consumption path is the in-process `checkDriftGuard`. See
  // src/tools/drift-guard-tools.ts.
  'driftguard.check',
  // Two-session MRV/underperformance signal (VW-91 / B04). DIAGNOSTIC ONLY,
  // same stance as `driftguard.check` (VW-131 decision): no internal wiring
  // yet. See src/tools/mrv-guard-tools.ts.
  'mrvguard.check',
  // Per-lifter, per-exercise RIR-velocity curve (VW-298). `fit` recomputes and
  // stores it; `target` converts an RIR prescription into that lifter's own
  // velocity, or returns the general-model caveat when no curve exists. See
  // src/tools/rir-velocity-tools.ts.
  'rir_velocity.fit',
  'rir_velocity.target',
  // RP-derived knowledge/prose lookup (VW-136/VW-137). A genuinely new
  // namespace per the locked consolidation design — kept to ONE tool with a
  // bounded topic enum, not one tool per topic. See src/tools/coaching-tools.ts.
  'coaching.explain',
  // Read-only pull of coach-assigned programming from TrueCoach into plan.*
  // (see src/tools/truecoach-tools.ts). Never writes to TrueCoach, and only
  // runs when called — there is no background sync anywhere in this repo.
  'truecoach.import_week',
  // Per-exercise result strings for one ended session, in the free-text idiom
  // a coach reads (see src/tools/report-tools.ts). Read-only and local.
  'report.session_results',
  // Coach-readable weekly summary (markdown/JSON) over a date range (w3-91).
  // Read-only and local; see src/tools/report-tools.ts.
  'report.weekly',
  // The accountability protocol's persisted position plus a dry run of what it
  // would decide now (VW-286). Read-only: it never sends and never writes.
  // See src/tools/accountability-tools.ts.
  'accountability.state',
  // The same dry run as `accountability.state`, plus the composed message
  // text a `send` decision would carry (VW-291). Read-only: it never sends
  // and never writes. See src/tools/accountability-tools.ts.
  'accountability.preview',
  // Declared priorities and the coach's derived targets over them (VW-350).
  // The human states priorities; the coach picks the metrics, reads a start
  // value out of history and bands it. A target is FIXED once accepted.
  // See src/tools/goal-tools.ts.
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
  // The Sunday tick's bodyweight-rate re-proposal (VW-376). Reads the weight
  // series, the declared phase and that week's check-in, and offers an
  // unsized advisory beside the committed goal line — it never edits that
  // line and never writes the diet phase.
  'goal.weekly_review',
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
 * Four entries are `write` by POLICY rather than by literal state mutation —
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
  'session.checkin': 'write',
  'session.set_exercise': 'write',
  'session.set_lifter': 'write',
  'session.list': 'read',
  'session.get': 'read',

  'set.start': 'write',
  'set.end': 'write',
  'set.live_metrics': 'read',
  // Mutates a stored row and re-derives a baseline off it. No device traffic,
  // but two sessions relabelling the same set race each other's recalc.
  'set.update': 'write',
  'set.get': 'read',
  'metrics.compute': 'read',

  'exercise.search': 'read',
  'exercise.get': 'read',
  // Writes a row in SQLite: two sessions naming the same setup race each other.
  'exercise.confirm_setup': 'write',
  // Writes (and retires) an `exercise_chapters` row, which every PR read
  // clamps against. No device traffic, but two sessions declaring the same
  // reform leave two boundaries.
  'exercise.mark_new_chapter': 'write',
  'exercise.retire_chapter': 'write',

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
  // Process-wide: flipping cues changes what every session's channel events
  // cause the speaker to say, so it is a `write` even though no device or
  // store row moves.
  'system.set_cues': 'write',

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
  // `measure_hold` is one capture and returns in seconds, but it makes the same
  // assumption the multi-trial tools do — the caller has the device configured
  // for an isometric hold — so it carries the same class.
  'isometric.measure_hold': 'write',
  'isometric.measure_max': 'write',
  'isometric.measure_imbalance': 'write',

  'plan.program.create': 'write',
  'plan.program.list': 'read',
  'plan.program.get': 'read',
  'plan.program.archive': 'write',
  'plan.block.create': 'write',
  'plan.block.list_for_program': 'read',
  'plan.block.update': 'write',
  // `write`: appends `block_schedules` rows, one per block a cascade moves.
  'plan.block.schedule': 'write',
  'plan.block.schedule_history': 'read',
  'plan.block.calendar': 'read',
  'plan.week.create': 'write',
  'plan.week.list_for_block': 'read',
  'plan.week.update': 'write',
  'plan.week.skip': 'write',
  'plan.template.create': 'write',
  'plan.template.get': 'read',
  'plan.template.list_for_week': 'read',
  'plan.exercise.create': 'write',
  'plan.exercise.list_for_template': 'read',
  'plan.current_block': 'read',
  'plan.block.planning_brief': 'read',
  'plan.next_workout': 'read',
  'plan.complete_workout': 'write',
  'plan.attach_to_session': 'write',
  'plan.suggest_progression': 'read',
  'plan.warmup_ramp': 'read',

  'profile.set_training_background': 'write',
  'profile.get_training_background': 'read',
  'profile.get_tier_signal': 'read',
  'profile.get_starting_prescription': 'read',
  'profile.get_onboarding_gaps': 'read',
  // Writes a row in SQLite and rewrites the timeline around it: two sessions
  // declaring different phases race each other.
  'profile.set_diet_phase': 'write',
  // Upserts a row in SQLite.
  'profile.log_bodyweight': 'write',
  'profile.get_body_metrics': 'read',
  // Writes rows in SQLite (a plain INSERT, like `session.checkin`).
  'profile.log_weekly_checkin': 'write',
  'profile.get_weekly_checkin': 'read',
  // Writes a row in SQLite: two sessions answering the same re-ask race.
  'profile.respond_recomp_advisory': 'write',

  'baselines.get': 'read',
  'baselines.recalc': 'write',

  'driftguard.check': 'read',
  'mrvguard.check': 'read',
  // `write`: it rewrites (or deletes) the stored curve in SQLite.
  'rir_velocity.fit': 'write',
  'rir_velocity.target': 'read',
  'coaching.explain': 'read',

  // `write`: it upserts the plan tree in SQLite. `dryRun: true` writes
  // nothing, but the classification describes the tool, not one argument.
  'truecoach.import_week': 'write',

  // Reads stored sets and returns strings. No device traffic, no row moves.
  'report.session_results': 'read',
  // Reads stored sessions/sets/plan tree/self-reports. No device traffic, no row moves.
  'report.weekly': 'read',
  // Reads one stored row and runs the reducer in memory. Persists nothing.
  'accountability.state': 'read',
  // Same read as `accountability.state`, plus a plan/report read to render
  // text. Persists nothing and sends nothing.
  'accountability.preview': 'read',

  // `write`: each of these upserts SQLite rows in `priorities`,
  // `goal_targets` or `advisory_decisions`.
  'goal.declare_priorities': 'write',
  'goal.propose_targets': 'write',
  'goal.accept_target': 'write',
  'goal.retire': 'write',
  'goal.new_chapter': 'write',
  // Reads the two goal tables and returns them. No row moves.
  'goal.list': 'read',
  // `write`: the review itself only reads, but recording the proposal it
  // raises — and the lifter's answer to it — upserts one `advisory_decisions`
  // row. Classified by what the tool can do, not by what one call happens to
  // do: a vetoed week writes nothing and is still this tool.
  'goal.weekly_review': 'write',

  'mock.configure': 'write',
  'mock.inject_error': 'write',
};

/** Access class for `name`, or `undefined` if it is not a known tool. */
export function toolAccess(name: string): ToolAccess | undefined {
  return TOOL_ACCESS[name as ToolName];
}
