// The per-tool notes behind the pt-session skill's generated tool inventory
// (`plugins/voltras-channel/skills/pt-session/references/15-tool-inventory.md`).
//
// Data only: `skill-inventory.ts` renders it, `scripts/gen-tool-reference.mjs`
// writes the page, and `src/__tests__/docs/tool-reference.test.ts` fails when
// the committed page and a fresh render disagree.
//
// `SKILL_TOOL_NOTES` is exhaustive over `CoreToolName` by construction, so a
// lane that registers a tool without writing its note gets a tsc error rather
// than a skill that silently omits it. That is the whole point of VW-503: the
// coach's tool list cannot go stale while the server moves.
//
// The `when` and `rule` strings are the coach's operating knowledge, not the
// tool description — the description says what a tool does, these say when to
// reach for it and the one thing that bites. The access letter is NOT stored
// here; it is derived from `TOOL_ACCESS` at render time.

import type { CoreToolName } from '../tool-registry.js';

/** Where a tool sits in the coach's workflow; one section of the page. */
export type SkillToolJobId =
  | 'connect'
  | 'load'
  | 'record'
  | 'rest'
  | 'planRead'
  | 'planWrite'
  | 'planSuggest'
  | 'goals'
  | 'profile'
  | 'readBack'
  | 'isometric'
  | 'setups'
  | 'debug';

export interface SkillToolJob {
  readonly id: SkillToolJobId;
  readonly heading: string;
  /** Prose rendered between the heading and the table. */
  readonly note?: string;
}

export interface SkillToolNote {
  readonly job: SkillToolJobId;
  /** The moment in a session that sends the coach to this tool. */
  readonly when: string;
  /** The one rule that matters most before calling it; may be empty. */
  readonly rule: string;
  /**
   * A read whose output is evidence for a human, never a recommendation to
   * relay. Independent of the access class: `baselines.recalc` both writes and
   * is a diagnostic.
   */
  readonly diagnostic?: true;
}

/** Sections in page order. */
export const SKILL_TOOL_JOBS: readonly SkillToolJob[] = [
  { id: 'connect', heading: 'Find and connect the device' },
  { id: 'load', heading: 'Load the cable' },
  { id: 'record', heading: 'Record the work' },
  { id: 'rest', heading: 'Rest, voice and cues' },
  { id: 'planRead', heading: 'Plan: read what is in force' },
  { id: 'planWrite', heading: 'Plan: write' },
  { id: 'planSuggest', heading: 'Plan: suggestions (relay, never apply)' },
  { id: 'goals', heading: 'Goals' },
  { id: 'profile', heading: 'Profile, bodyweight, diet phase, check-ins' },
  { id: 'readBack', heading: 'Read the work back' },
  {
    id: 'isometric',
    heading: 'Isometric assessments',
    note:
      'Do not plan any of these while the mount rating is unknown (VW-274, open). ' +
      'Isometric mode can pull up to 400 lb per unit whatever weight is set. If the ' +
      'lifter asks for one, read `mountLoadWarning` out first.',
  },
  { id: 'setups', heading: 'Setups and chapters' },
  { id: 'debug', heading: 'Debug (on an explicit request only)' },
];

/**
 * Tools the skill deliberately does not list, each with the reason. The
 * coverage check in `scripts/check-docs.mjs` reads this list as text, so a
 * registered tool that is neither noted nor named here fails the lint job.
 */
export const SKILL_IGNORED_TOOLS: readonly string[] = [
  // Mock-adapter only: a coach session never runs `VOLTRA_ADAPTER=mock`.
  'mock.configure',
  // Mock-adapter only: injects failures for tests, not for coaching.
  'mock.inject_error',
];

/** What the hand-written half of the skill was last read against. */
export const SKILL_VERIFIED_LINE =
  'Verified 2026-09-19 against voltras-mcp main (#479, store schema 35)';

export const SKILL_TOOL_NOTES: Record<CoreToolName, SkillToolNote> = {
  'device.scan': {
    job: 'connect',
    when: 'Start of every workout',
    rule: '`device.connect` reads only the MOST RECENT scan. `DEVICE_NOT_FOUND` on connect means scan again',
  },
  'device.set_passive_scan': {
    job: 'connect',
    when: 'You want a `voltras_available` event when a unit appears',
    rule: 'Off at server start. It pauses while any slot is connected',
  },
  'device.connect': {
    job: 'connect',
    when: 'After scan, once per unit',
    rule: 'A first pairing asks the lifter to accept on the device; allow 30 s. `CONNECTION_REFUSED` is never retried for you. `stateConfirmed: false` means setters refuse until the device reports its settings',
  },
  'device.disconnect': {
    job: 'connect',
    when: 'End of workout',
    rule: 'It does NOT close an open set or session. Call `set.end` and `session.end` first',
  },
  'device.get_state': {
    job: 'connect',
    when: 'After EVERY setter and every cascade',
    rule: 'Setters resolve on write, not on agreement. This is the only proof a request landed. Fields are flat',
  },
  'slot.bindings_list': {
    job: 'connect',
    when: 'Before a bilateral connect',
    rule: 'Tells you whether the side-ID ritual can be skipped',
  },
  'slot.identify': {
    job: 'connect',
    when: 'First bilateral session',
    rule: "The named unit's screen changes for 3 s. The lifter says which side it was",
  },
  'slot.bind': {
    job: 'connect',
    when: 'After the lifter confirms a side',
    rule: "Write once. Later `device.connect {slot: 'auto'}` routes by it",
  },
  'slot.unbind': {
    job: 'connect',
    when: 'A unit moved sides for good',
    rule: 'The next auto connect falls back to the ritual',
  },
  'slot.swap': {
    job: 'connect',
    when: 'Two units are bound the wrong way round',
    rule: 'Memory only, no device traffic. Needs exactly two connected slots',
  },
  'system.lease_acquire': {
    job: 'connect',
    when: 'Before driving hardware when another client may be attached',
    rule: "`force: true` unloads the other holder's device. Use it only when the user confirms that session is abandoned. Never pass `acceptLoadedDevice` unless the device is confirmed unattended",
  },
  'system.lease_status': {
    job: 'connect',
    when: 'A contended device',
    rule: '`generation` rises each time the lease changes hands',
  },
  'system.lease_release': {
    job: 'connect',
    when: 'End of workout',
    rule: 'Unloads first if anything is still engaged',
  },
  'server.health': {
    job: 'connect',
    when: 'Once after connect, and at the top of every sitting',
    rule: '`build` may read "unknown". Read `adapter`, `dbPath`, `dashboardAvailable`, `dashboardUrl`, `cues`, `cuesMidSet`, `autoArm`, `voiceReady`. Give `dashboardUrl` to the user exactly as reported',
  },

  'bilateral.cascade': {
    job: 'load',
    when: 'Weight Training, one or both units',
    rule: 'All four are required: `mode`, `weightLbs`, `eccentricOverloadLbs`, `chainsLbs`. Read `results[i].modeEcho`; on `timeout` that slot failed and its other setters never went out. Do not send a non-WeightTraining mode through it (VW-162, open)',
  },
  'device.set_mode': {
    job: 'load',
    when: 'Every non-WeightTraining mode, per slot, FIRST',
    rule: 'Then compare `requested_mode` with `active_mode` in `get_state` before anything else. `Idle` is not selectable',
  },
  'device.set_weight': {
    job: 'load',
    when: 'One unit, weight only',
    rule: '5 to 200 lb, whole pounds. Set it BEFORE `set.start`. Under tension it does not apply to the set in progress; read `weightChangeWarning` out',
  },
  'device.set_chains': {
    job: 'load',
    when: 'Chains on one unit',
    rule: '0 to 100 lb, capped at the base weight by the device. Never tell the user which end of the rep is heavier; that is an open question',
  },
  'device.set_eccentric': {
    job: 'load',
    when: 'Eccentric overload on one unit',
    rule: '**Pounds, never a percent**: -195 to +195. `percent` is a deprecated alias with the same meaning. Read `mountLoadWarning` out. It is a cost knob, not a growth multiplier',
  },
  'device.set_damper_level': {
    job: 'load',
    when: 'Damper mode',
    rule: '0 to 9. The device screen shows the value plus one',
  },
  'device.set_assist_mode': {
    job: 'load',
    when: 'Assist on or off',
    rule: "It lives in the device's Settings menu, not the idle screen",
  },
  'device.set_band_max_force': {
    job: 'load',
    when: 'Resistance Band mode',
    rule: '15 to 70 lb',
  },
  'device.configure_isokinetic': {
    job: 'load',
    when: 'Isokinetic mode, after `set_mode`',
    rule: 'One call for all isokinetic fields. Speeds are mm/s; the screen shows m/s. Setting an eccentric weight makes the unit beep; the write still succeeds',
  },
  'device.set_isokinetic_target_speed': {
    job: 'load',
    when: 'Deprecated',
    rule: 'Use `device.configure_isokinetic`',
  },
  'device.set_isokinetic_ecc_mode': {
    job: 'load',
    when: 'Deprecated',
    rule: 'Use `device.configure_isokinetic`',
  },
  'device.set_isokinetic_ecc_speed_limit': {
    job: 'load',
    when: 'Deprecated',
    rule: 'Use `device.configure_isokinetic`',
  },
  'device.set_isokinetic_ecc_const_weight': {
    job: 'load',
    when: 'Deprecated',
    rule: 'Use `device.configure_isokinetic`',
  },
  'device.set_isokinetic_ecc_overload_weight': {
    job: 'load',
    when: 'Deprecated',
    rule: 'Use `device.configure_isokinetic`',
  },
  'device.enter_row_mode': {
    job: 'load',
    when: 'Rowing, stage 1 of 2',
    rule: 'The cable does not engage until `device.start_row`',
  },
  'device.start_row': {
    job: 'load',
    when: 'Rowing, stage 2 of 2',
    rule: 'Distance presets only pick a screen on the unit',
  },
  'device.unload': {
    job: 'load',
    when: 'Stop the load; recover from anything uncertain',
    rule: 'Read `read_back.verdict`. `unconfirmed` means the cable is unverified: call again and confirm by eye. `load_state: unloaded` also appears during ordinary reps, so it proves nothing',
  },
  'device.start_guided_load': {
    job: 'load',
    when: 'Starting from a contracted position only. Experimental',
    rule: 'It is a ceremony, not "load the cable". Weight Training only. It creates its own set, so pass `isWarmup` and `watch` here or a ramp counts as working sets. `armed` confirms nothing',
  },
  'device.exit_guided_load': {
    job: 'load',
    when: 'Leave a guided-load flow. Experimental',
    rule: 'Its read-back is always `unconfirmed`. `device.unload` is the release the device confirms',
  },

  'exercise.search': {
    job: 'record',
    when: 'Before every `session.start` and exercise change',
    rule: 'Use the returned `id`. Name matching elsewhere is exact',
  },
  'exercise.get': {
    job: 'record',
    when: 'You hold an id and need the entry',
    rule: '`NOT_FOUND` means search first',
  },
  'session.start': {
    job: 'record',
    when: 'Before the lifter touches the handle, per slot',
    rule: "Pass `exerciseId`. An auto-armed set copies the session's exercise at that instant and is never relabelled",
  },
  'session.set_exercise': {
    job: 'record',
    when: 'Before EVERY exercise change',
    rule: 'Same reason. Unlabelled sets are invisible to goals, baselines and progression',
  },
  'session.set_lifter': {
    job: 'record',
    when: 'A guest steps in, and again when the owner is back',
    rule: "`{lifter: 'Jordan'}` then `{lifter: null}`. It affects sets started after the call",
  },
  'set.start': {
    job: 'record',
    when: 'After the weight is verified, before "go"',
    rule: 'Pass `setPurpose`. On `set_started {auto_armed: true}` call it at once to upgrade that set in place; it works once per set. A velocity-loss watch needs a `pct`, an `intent`, or a planned `trainingIntent`, else the call is refused',
  },
  'set.live_metrics': {
    job: 'record',
    when: 'Push is not working and you must poll',
    rule: '`{active: false}` means no active set. Prefer `watch`',
  },
  'set.end': {
    job: 'record',
    when: 'The lifter released and no `set_ended` came',
    rule: 'It is what persists reps. Never skip it',
  },
  'set.get': {
    job: 'record',
    when: 'Inspect one stored set',
    rule: 'If rep counts disagree it reports the split. Do not pick a winner',
  },
  'set.update': {
    job: 'record',
    when: 'A set ran under the wrong lifter label',
    rule: "Only the label is editable. It re-derives the owner's baseline",
  },
  'session.checkin': {
    job: 'record',
    when: 'After the very first session, then at the end of each completed training week',
    rule: 'Show their own numbers first. Never a gate. A guest session writes nothing',
  },
  'session.end': {
    job: 'record',
    when: 'End of workout, per slot',
    rule: 'Always. A session never ended is not a training day today (VW-489). Takes an optional `checkin`',
  },
  'session.list': {
    job: 'record',
    when: 'Browse history',
    rule: 'Keep `detail: summary`. A full session can be over 100 KB',
  },
  'session.get': {
    job: 'record',
    when: 'One session in full',
    rule: 'Carries `sessionPace` when a plan is attached: an estimate, never a measurement',
  },
  'session.review_list': {
    job: 'record',
    when: 'Before any read of history: goals, the tier signal, attendance, the weekly review, block planning',
    rule: 'Defaults to the days nobody has classified, and an unclassified day is left out of every history read — so an empty history may mean "not yet reviewed" rather than "not yet trained". Feed a row\'s `day` straight to `session.mark_kind`',
  },
  'session.mark_kind': {
    job: 'record',
    when: 'The lifter has told you what a day was',
    rule: '**Never guess a kind. Ask.** `dryRun: true` first; a real `from`/`to` call then needs `expectSessions` equal to the count the dry run reported. A day or range call leaves a session already marked the other kind alone unless `reclassify: true`; naming a `sessionId` may always reclassify. Read `rederiveFailed` out and re-run `baselines.recalc` and `rir_velocity.fit` for those exercises',
  },

  'timer.start': {
    job: 'rest',
    when: 'Every rest. The default',
    rule: "Non-blocking. Omit `durationMs` to take the plan's `restSec`, else a default by training goal. Read `restBasis` for why",
  },
  'timer.wait': {
    job: 'rest',
    when: 'Short quiet rests, or push never registered',
    rule: 'It blocks. Only one at a time; a second returns `BUSY`',
  },
  'timer.cancel': {
    job: 'rest',
    when: 'Cut a rest short',
    rule: 'Safe to call when nothing is running',
  },
  'system.speak': {
    job: 'rest',
    when: 'A short spoken cue',
    rule: '**The mic is deaf while any line plays**, safety phrases included (VW-173, open). Keep it short. Never speak while waiting on a spoken reply, or over a heavy set. `interrupt: true` drops the queue',
  },
  'system.set_cues': {
    job: 'rest',
    when: 'Turn automatic spoken cues on or off',
    rule: 'Both default off. Leave `midSet` off',
  },
  'system.listen_start': {
    job: 'rest',
    when: 'The lifter wants voice control',
    rule: 'Safety phrases unload EVERY connected slot with no model turn. A `voice_command_applied` event means the write already happened',
  },
  'system.listen_stop': {
    job: 'rest',
    when: 'Voice no longer wanted',
    rule: 'Call it yourself. A spoken request over a cue never arrives',
  },

  'plan.current_block': {
    job: 'planRead',
    when: 'Top of every sitting; any "where am I in the plan"',
    rule: '`state` is `current`, `upcoming`, `gap` or `undated_only`. When `planning.due`, ask about planning and create nothing until they answer. Its existence is also the is-this-main test',
  },
  'plan.next_workout': {
    job: 'planRead',
    when: '"What do I do today?"',
    rule: 'Three shapes: a template, `{completed: true}`, or `{unplanned: true}`. On unplanned, say training continues unplanned and never present a workout from the ended block. Relay `blockBoundary.realignment` and `recompReAsk`; neither writes',
  },
  'plan.block.planning_brief': {
    job: 'planRead',
    when: 'The planning sitting, after the lifter says yes',
    rule: 'Reads only. `finishing` and `realignment` are null when no block has dates. `dietPhase: null` means none is declared; raise it',
  },
  'plan.block.calendar': {
    job: 'planRead',
    when: "Read back a block's dates",
    rule: 'A week with `templateCount: 0` has nothing planned. `history.fact` is one sentence you can say',
  },
  'plan.block.schedule_history': {
    job: 'planRead',
    when: '"How has this block moved?"',
    rule: 'Oldest first, with who made each change',
  },
  'plan.program.list': {
    job: 'planRead',
    when: 'Find a program',
    rule: 'Pass `includeArchived` only when asked',
  },
  'plan.program.get': {
    job: 'planRead',
    when: 'One program by id',
    rule: '',
  },
  'plan.block.list_for_program': {
    job: 'planRead',
    when: 'Walk the tree down',
    rule: '',
  },
  'plan.week.list_for_block': {
    job: 'planRead',
    when: 'Walk the tree down',
    rule: 'Each week reports `isDeload` and `phaseType`',
  },
  'plan.template.list_for_week': {
    job: 'planRead',
    when: 'Walk the tree down',
    rule: '',
  },
  'plan.template.get': {
    job: 'planRead',
    when: 'One template by id',
    rule: '',
  },
  'plan.exercise.list_for_template': {
    job: 'planRead',
    when: 'The prescribed exercises of one workout',
    rule: '',
  },

  'plan.block.schedule': {
    job: 'planWrite',
    when: 'Date, move or un-date a block that has not started',
    rule: '`startsOn` is a local Monday. A started or ended block never moves. Overlap and out-of-order dates are refused and the error names the other block. Read `targetsAffected` back',
  },
  'plan.block.create': {
    job: 'planWrite',
    when: 'A new block, planned ahead',
    rule: 'Takes `startsOn`, `scaffoldWeeks`, `deloadWeeks`. For an existing dated block use `schedule` or `update` instead',
  },
  'plan.block.update': {
    job: 'planWrite',
    when: 'Rename or resize a block',
    rule: 'The start never moves here. Refused on an ended block and when a resize would overlap',
  },
  'plan.week.skip': {
    job: 'planWrite',
    when: 'A missed week in the CURRENT block',
    rule: '**Ask hold or extend, every time.** Pass the answer as `mode`. Omit `mode` only when they did not choose. Read `weekOf` back',
  },
  'plan.week.update': {
    job: 'planWrite',
    when: 'Flag a deload, rename a week',
    rule: 'Dates come from the block, never the week',
  },
  'plan.week.create': {
    job: 'planWrite',
    when: 'Build a week under a block',
    rule: '',
  },
  'plan.template.create': {
    job: 'planWrite',
    when: 'Build a workout under a week',
    rule: '',
  },
  'plan.exercise.create': {
    job: 'planWrite',
    when: 'Add a prescribed exercise',
    rule: '`warnings[]` are suggestions. The write always succeeds. Read a warning out, offer its fix, drop it after a decline',
  },
  'plan.program.create': {
    job: 'planWrite',
    when: 'A new program',
    rule: '',
  },
  'plan.program.archive': {
    job: 'planWrite',
    when: 'Retire a program',
    rule: 'Archived programs never count as the plan in force',
  },
  'plan.attach_to_session': {
    job: 'planWrite',
    when: 'Link a live session to its template or planned exercise',
    rule: 'Exactly one of the two ids',
  },
  'plan.complete_workout': {
    job: 'planWrite',
    when: 'End of a planned workout',
    rule: 'Pass `sessionId` explicitly. Returns `current`, and `blockBoundary` on the last workout of a block',
  },
  'truecoach.import_week': {
    job: 'planWrite',
    when: 'The owner asks to pull their coach-assigned week',
    rule: "A by-hand read of the user's own data. Never present it as a sanctioned integration. `dryRun: true` first",
  },

  'plan.suggest_progression': {
    job: 'planSuggest',
    when: '"What next time?"',
    rule: 'An estimated 1RM never moves load. An asymmetry never prescribes single-limb work. When the diet phase changed the answer, relay that clause, not the bare delta',
  },
  'plan.warmup_ramp': {
    job: 'planSuggest',
    when: 'Before the first working set of a lift',
    rule: 'A population estimate, not personal. Start each rung yourself as `warmup`. Run the last rung',
  },
  'progression.get_for_exercise': {
    job: 'planSuggest',
    when: '"What did I hit last time?"',
    rule: 'If `comparability` says `noValidComparison`, say what changed. On `setup_confounded`, do not read a left/right gap as an imbalance',
  },
  'profile.get_starting_prescription': {
    job: 'planSuggest',
    when: 'A new lifter or a new exercise',
    rule: 'Seeds are low on purpose. Do not round up. `assumesBeginner: true` means say so',
  },

  'goal.declare_priorities': {
    job: 'goals',
    when: 'The lifter says what matters',
    rule: '**Takes no target value.** Date the block first; read `block` back. Guardrails are advisory. Relay the fat-loss downgrade offer; never apply it',
  },
  'goal.propose_targets': {
    job: 'goals',
    when: 'Once per priority',
    rule: 'Every input is read, none is typed. Read out both edges, `infoLevel`, `tierProvisional`, notes and every `skipped[]` reason. Raise a `recalibrationOffers` entry once',
  },
  'goal.accept_target': {
    job: 'goals',
    when: "On the lifter's word, one target at a time",
    rule: 'After this the numbers never move. Their own number past the stretch edge needs `acknowledgeStretch: true`. `anchorLoad` only for `reps_at_load`',
  },
  'goal.list': {
    job: 'goals',
    when: 'Read the accepted set back',
    rule: 'A target with no `acceptedBy` is an unanswered proposal',
  },
  'goal.retire': {
    job: 'goals',
    when: 'A goal ended, or a proposal is declined',
    rule: 'Ask for the outcome: `met`, `missed`, `abandoned`. A retired proposal is never re-offered, so do not retire one the lifter only wants to postpone',
  },
  'goal.new_chapter': {
    job: 'goals',
    when: 'The lifter says the movement itself changed',
    rule: 'Never infer it from a drop. The numbers do not move',
  },
  'goal.weekly_review': {
    job: 'goals',
    when: 'The Sunday bodyweight-rate review',
    rule: "Never sized: it names intake and activity and the pick is the lifter's. Name any veto. Answer a `proposal` with `response`",
  },

  'profile.get_onboarding_gaps': {
    job: 'profile',
    when: 'Start of a workout or sitting',
    rule: 'Ask the first `missing[]` item, not a list of your own. Ask `lastBreakQuestion` as written. A cardiovascular flag goes to a doctor',
  },
  'profile.set_training_background': {
    job: 'profile',
    when: 'Each onboarding answer',
    rule: 'A merge, except `injuries`, which replaces the list; `[]` means "asked, none". Store their words; never infer a tier',
  },
  'profile.get_training_background': {
    job: 'profile',
    when: 'Read the stored answers',
    rule: '`profile: null` means nothing captured',
  },
  'profile.get_tier_signal': {
    job: 'profile',
    when: 'Before any tier-gated decision',
    rule: 'A crude ceiling, not a classification. Say `confidence` and `ceilingBasis`. Logged days include bench tests today',
  },
  'profile.log_bodyweight': {
    job: 'profile',
    when: 'The lifter gives a weight',
    rule: "**Copy the health log's value and its time.** Never a second independent reading. Never ask for leanness fields or for a measurement",
  },
  'profile.get_body_metrics': {
    job: 'profile',
    when: 'Read weigh-ins back',
    rule: 'The 7-day mean needs 3 readings in 7 days. A body-fat number is display only. A change inside its band is "no measurable change"',
  },
  'profile.set_diet_phase': {
    job: 'profile',
    when: 'The lifter names their actual phase',
    rule: 'The only writer of the phase. A recomposition REQUIRES `recompMode`, asked, never inferred. Read the timeline back',
  },
  'profile.log_weekly_checkin': {
    job: 'profile',
    when: 'Sunday',
    rule: 'Three optional ratings. Call it even when all are skipped. Sleep is a confounder line only',
  },
  'profile.get_weekly_checkin': {
    job: 'profile',
    when: "Read a week's check-in",
    rule: '`checkin: null` differs from a check-in with blank fields',
  },
  'profile.respond_recomp_advisory': {
    job: 'profile',
    when: 'A `recompReAsk.proposal` is open',
    rule: 'Neither answer changes the phase. Call it only when a proposal is actually open',
  },

  'metrics.compute': {
    job: 'readBack',
    when: 'After a set or session',
    rule: '18 pipelines by `pipeline`. Readouts, never recommendations. `vbt.rir` names its `basis`; a `profile-estimate` is not a proximity-to-failure read. `fatigue.verdict` matches the wall. `history.trend` is where an e1RM belongs',
  },
  'report.session_results': {
    job: 'readBack',
    when: 'After `session.end`',
    rule: 'Working sets only. The session must be ended',
  },
  'report.weekly': {
    job: 'readBack',
    when: 'The Sunday review',
    rule: 'Counts training days, never a streak. Progression lines are "suggestion for the coach, not applied"',
  },
  'rir_velocity.fit': {
    job: 'readBack',
    when: 'After new failure sets on a lift',
    rule: 'Needs 3 qualifying sets over 2 sessions at 70 to 90% of the estimate. A failed fit DELETES the stored curve. Read `reason` out',
  },
  'rir_velocity.target': {
    job: 'readBack',
    when: 'Turn a reps-in-reserve prescription into a velocity',
    rule: 'Null with no curve; no group curve is substituted. `withinFittedRange: false` is an extrapolation',
  },
  'coaching.explain': {
    job: 'readBack',
    when: 'You need the sourced reason behind a rule',
    rule: 'Never strip the tier. Quote a `caveats` topic as a range',
  },
  'accountability.state': {
    job: 'readBack',
    when: '"What would the coach message do now?"',
    rule: 'Reads only. Sends nothing',
  },
  'accountability.preview': {
    job: 'readBack',
    when: 'End of the Sunday sitting, optional',
    rule: 'Renders the message from live reads. Sends nothing',
  },

  'isometric.measure_hold': {
    job: 'isometric',
    when: 'One coach-paced hold',
    rule: 'You set Isometric mode and a low resistance first. Peak force is the headline',
  },
  'isometric.measure_max': {
    job: 'isometric',
    when: 'The full 3-trial protocol on one unit',
    rule: 'Runs its own warm-up pulls and 120 s rests. The inferred working weight is a heuristic, never a 1RM',
  },
  'isometric.measure_imbalance': {
    job: 'isometric',
    when: 'Both sides',
    rule: "No fixed threshold. A difference is real only past the lifter's own trial spread. Never prescribe single-limb work from it",
  },

  'baselines.get': {
    job: 'setups',
    when: '"How much do we know about this lift?"',
    rule: 'A confidence state, not a value. Below CALIBRATED, treat derived numbers as provisional. Say `pooledFallback` when true',
    diagnostic: true,
  },
  'baselines.recalc': {
    job: 'setups',
    when: 'Old history, or a forced re-derive',
    rule: '`reharvest` labels failures that already happened. Never praise one or ask for more. `inferSetups` returns neutral labels',
    diagnostic: true,
  },
  'exercise.confirm_setup': {
    job: 'setups',
    when: 'The lifter names a setup',
    rule: 'The label and the card are THEIR answer. Never offer a guess to confirm',
  },
  'exercise.mark_new_chapter': {
    job: 'setups',
    when: 'The lifter says the movement changed',
    rule: 'Manual only. Never because a number dropped',
  },
  'exercise.retire_chapter': {
    job: 'setups',
    when: 'Undo a chapter',
    rule: 'By the `chapterId` the declaration returned',
  },
  'driftguard.check': {
    job: 'setups',
    when: 'A human asks why a comparison was refused',
    rule: 'Not a step in a coaching decision',
    diagnostic: true,
  },
  'mrvguard.check': {
    job: 'setups',
    when: 'A human asks about a deload signal',
    rule: 'Needs three session ids, oldest first',
    diagnostic: true,
  },

  'debug.recent_events': {
    job: 'debug',
    when: '"What just happened?"',
    rule: 'Your first debug read',
    diagnostic: true,
  },
  'debug.recording_status': {
    job: 'debug',
    when: 'Is the flight recorder on',
    rule: '',
    diagnostic: true,
  },
  'debug.push_test_channel': {
    job: 'debug',
    when: 'Does push reach this session',
    rule: 'A missing event means the launch flag did not register; fall back to polling',
    diagnostic: true,
  },
  'debug.confirm_channel': {
    job: 'debug',
    when: 'Confirm the test event arrived',
    rule: '',
    diagnostic: true,
  },
  'debug.compare_rep_streams': {
    job: 'debug',
    when: 'Rep counts disagree',
    rule: 'Report the split. The device counts reps',
    diagnostic: true,
  },
  'debug.recent_frames': {
    job: 'debug',
    when: 'Only when the user asks for low-level capture',
    rule: '**Never quote its content** in chat, notes, tasks or commits',
    diagnostic: true,
  },
  'device.send_raw': {
    job: 'debug',
    when: "Only on the user's explicit request, in a validation campaign",
    rule: 'Needs `confirm: true`. It can move the motor. **Never quote what was sent or received**',
  },
};
