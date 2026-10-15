// What an audit row may say about a write-classified tool call (VW-891,
// slice 2 of VW-849).
//
// A row is undeletable once written, so it never holds the call's arguments.
// It holds a summary in fitness units, built by a summariser that PICKS named
// fields out of the arguments and returns a new object. No summariser spreads,
// copies or iterates the arguments, so an argument nobody named here can never
// reach a row, whatever a caller sends.
//
// Every value is checked on the way in, not just its key: a number must be
// finite, a date must look like a date, an id or a name must be short plain
// text, and `mode` must be one of the public training-mode names (anything
// else becomes `other`).
//
// Device tools are all name-only for now. Which device values a row may hold
// is an open owner question (VW-849 Q1), and a recorded value can never be
// taken back, so the safe default is to record only the tool's name.

import { SELECTABLE_MODE_NAMES } from '../schemas/device.js';
import { DIET_PHASES } from '../store/diet-phase.js';
import type { TOOL_ACCESS } from '../tool-registry.js';

/** The only keys a summary may carry. */
export const SUMMARY_FIELDS = [
  'slot',
  'loadLbs',
  'mode',
  'reps',
  'exercise',
  'sessionKind',
  'weekLabel',
  'bodyweightLbs',
  'dietPhase',
  'goalId',
  'count',
] as const;

export type SummaryField = (typeof SUMMARY_FIELDS)[number];

export type CommandSummary = Readonly<Partial<Record<SummaryField, string | number>>>;

type Args = Readonly<Record<string, unknown>>;

export type Summariser = (args: Args) => CommandSummary;

/** A tool whose row records its name and nothing else. */
export const NAME_ONLY = 'name-only';

/** Every tool `TOOL_ACCESS` classifies as `write`, and nothing else. */
export type WriteToolName = {
  [K in keyof typeof TOOL_ACCESS]: (typeof TOOL_ACCESS)[K] extends 'write' ? K : never;
}[keyof typeof TOOL_ACCESS];

/** What a mode becomes when it is not one of the public mode names. */
export const OTHER_MODE = 'other';

const MAX_TEXT_LENGTH = 80;
const PLAIN_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} _'&()/.,+-]*$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_KINDS: readonly string[] = ['training', 'test'];

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function plainText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return undefined;
  return PLAIN_TEXT.test(value) ? value : undefined;
}

function localDate(value: unknown): string | undefined {
  return typeof value === 'string' && LOCAL_DATE.test(value) ? value : undefined;
}

function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

/** A public training-mode name, or `other`. Never a number, never a raw value. */
export function publicModeName(value: unknown): string {
  return oneOf(value, SELECTABLE_MODE_NAMES) ?? OTHER_MODE;
}

/** Build a summary from picked values, leaving out the ones that failed their check. */
function pick(fields: Partial<Record<SummaryField, string | number | undefined>>): CommandSummary {
  const summary: Partial<Record<SummaryField, string | number>> = {};
  for (const field of SUMMARY_FIELDS) {
    const value = fields[field];
    if (value !== undefined) summary[field] = value;
  }
  return summary;
}

const slotOnly: Summariser = (args) => pick({ slot: plainText(args.slot) });

const slotAndExercise: Summariser = (args) =>
  pick({
    slot: plainText(args.slot),
    exercise: plainText(args.exerciseId) ?? plainText(args.exerciseName),
  });

const goalFrom =
  (key: string): Summariser =>
  (args) =>
    pick({ goalId: plainText(args[key]) });

const weekOf: Summariser = (args) => pick({ weekLabel: localDate(args.weekOf) });

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function calendarWeek(value: unknown): string | undefined {
  const week = finiteNumber(value);
  return week === undefined ? undefined : `week ${week}`;
}

const plannedExercise: Summariser = (args) =>
  pick({
    exercise: plainText(args.exerciseId),
    reps: finiteNumber(args.targetRepsHigh) ?? finiteNumber(args.targetRepsLow),
    loadLbs: finiteNumber(args.targetWeightLbs),
    count: finiteNumber(args.targetSets),
  });

/**
 * One entry per write tool. `Record<WriteToolName, …>` makes a new write tool
 * a tsc error here until somebody decides what its row may say.
 */
export const COMMAND_SUMMARIES: Readonly<Record<WriteToolName, Summariser | typeof NAME_ONLY>> = {
  // Device tools: name-only until VW-849 Q1 is answered.
  'device.scan': NAME_ONLY,
  'device.set_passive_scan': NAME_ONLY,
  'device.connect': NAME_ONLY,
  'device.disconnect': NAME_ONLY,
  'device.set_weight': NAME_ONLY,
  'device.set_mode': NAME_ONLY,
  'device.set_chains': NAME_ONLY,
  'device.set_eccentric': NAME_ONLY,
  'device.set_damper_level': NAME_ONLY,
  'device.set_assist_mode': NAME_ONLY,
  'device.set_band_max_force': NAME_ONLY,
  'device.set_isokinetic_target_speed': NAME_ONLY,
  'device.set_isokinetic_ecc_mode': NAME_ONLY,
  'device.set_isokinetic_ecc_speed_limit': NAME_ONLY,
  'device.set_isokinetic_ecc_const_weight': NAME_ONLY,
  'device.set_isokinetic_ecc_overload_weight': NAME_ONLY,
  'device.configure_isokinetic': NAME_ONLY,
  'device.unload': NAME_ONLY,
  'device.start_guided_load': NAME_ONLY,
  'device.exit_guided_load': NAME_ONLY,
  'device.enter_row_mode': NAME_ONLY,
  'device.start_row': NAME_ONLY,
  'bilateral.cascade': NAME_ONLY,
  'slot.swap': NAME_ONLY,
  'slot.identify': NAME_ONLY,
  'slot.bind': NAME_ONLY,
  'slot.unbind': NAME_ONLY,
  'isometric.measure_hold': NAME_ONLY,
  'isometric.measure_max': NAME_ONLY,
  'isometric.measure_imbalance': NAME_ONLY,

  // Name-only by rule, whatever Q1 decides.
  'device.send_raw': NAME_ONLY,
  'debug.push_test_channel': NAME_ONLY,
  'debug.confirm_channel': NAME_ONLY,
  'mock.configure': NAME_ONLY,
  'mock.inject_error': NAME_ONLY,
  'system.lease_acquire': NAME_ONLY,
  'system.lease_release': NAME_ONLY,

  // Speech, the mic, cues and timers: free text or no fitness unit to record.
  'system.speak': NAME_ONLY,
  'system.listen_start': NAME_ONLY,
  'system.listen_stop': NAME_ONLY,
  'system.set_cues': NAME_ONLY,
  'timer.wait': NAME_ONLY,
  'timer.start': NAME_ONLY,
  'timer.cancel': NAME_ONLY,

  'session.start': slotAndExercise,
  'session.end': slotOnly,
  'session.set_exercise': slotAndExercise,
  'session.mark_kind': (args) => pick({ sessionKind: oneOf(args.kind, SESSION_KINDS) }),
  // Self-reports and the lifter's label: personal, not a fitness unit.
  'session.checkin': NAME_ONLY,
  'session.set_lifter': NAME_ONLY,

  'set.start': slotOnly,
  'set.end': slotOnly,
  'set.update': NAME_ONLY,

  // Setup labels, chapter reasons and recalculations: free text or no unit.
  'exercise.confirm_setup': NAME_ONLY,
  'exercise.mark_new_chapter': NAME_ONLY,
  'exercise.retire_chapter': NAME_ONLY,
  'baselines.recalc': NAME_ONLY,
  'rir_velocity.fit': NAME_ONLY,

  'plan.program.create': NAME_ONLY,
  'plan.program.archive': NAME_ONLY,
  'plan.block.create': NAME_ONLY,
  'plan.block.update': NAME_ONLY,
  'plan.block.schedule': NAME_ONLY,
  'plan.week.create': NAME_ONLY,
  'plan.week.update': NAME_ONLY,
  'plan.week.skip': (args) => pick({ weekLabel: calendarWeek(args.week) }),
  'plan.template.create': NAME_ONLY,
  'plan.exercise.create': plannedExercise,
  'plan.complete_workout': NAME_ONLY,
  'plan.attach_to_session': NAME_ONLY,
  'truecoach.import_week': (args) => pick({ weekLabel: localDate(args.from) }),

  'profile.set_training_background': NAME_ONLY,
  'profile.set_diet_phase': (args) => pick({ dietPhase: oneOf(args.phase, DIET_PHASES) }),
  'profile.log_bodyweight': (args) => pick({ bodyweightLbs: finiteNumber(args.bodyweightLbs) }),
  'profile.log_weekly_checkin': weekOf,
  'profile.respond_recomp_advisory': NAME_ONLY,

  'accountability.declare_commitment': NAME_ONLY,

  'goal.declare_priorities': (args) => pick({ count: arrayLength(args.items) }),
  'goal.propose_targets': goalFrom('priorityId'),
  'goal.accept_target': goalFrom('targetId'),
  'goal.retire': (args) => pick({ goalId: plainText(args.targetId) ?? plainText(args.priorityId) }),
  'goal.new_chapter': goalFrom('targetId'),
  'goal.weekly_review': weekOf,
};

function isArgs(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The summary a row may hold for one call of `tool`, or `null` for a
 * name-only tool, for arguments that are not an object, and for a call none
 * of whose named values passed their check.
 */
export function summariseCommand(tool: WriteToolName, args: unknown): CommandSummary | null {
  const summariser = COMMAND_SUMMARIES[tool];
  if (summariser === NAME_ONLY || !isArgs(args)) return null;
  const summary = summariser(args);
  return Object.keys(summary).length === 0 ? null : summary;
}
