// The wall dashboard's coaching lines (VW-727), as sourced fragments: the live
// stage captions in `live-page/live-copy.ts` and the calibrating-goal lines in
// `goals/calibration-copy.ts`. `{{token}}` slots are filled with `fillSlots`.

import type { Fragment } from './fragments.js';

const CALIBRATION_HONESTY =
  'Says what a calibrating goal still waits on, so a starting ramp never reads as a target ' +
  'based on the lifter’s own lifts.';
const NOT_A_READING =
  'Labels the effort figure as a target or an assumption so it never reads as a measured reading.';
const MARKS_DERIVED_REST =
  'Marks a rest derived from the training goal so it never reads as the coach’s number; the ' +
  'rest lengths carry their own citations.';
const MARKS_LAST_TIME =
  'Marks targets copied from the lifter’s last session of the exercise so they never read as ' +
  'the coach’s prescription; the date shows how old they are.';

function engineeringDefault(id: string, text: string, reason: string): Fragment {
  return { id, text, sourceKind: 'engineering-default', sourceRef: reason };
}

// The owner accepted the auto-arm source labels as worded in VW-501's plan (question Q3).
function ownerRuling(id: string, text: string): Fragment {
  return { id, text, sourceKind: 'owner-ruling', sourceRef: 'VW-501' };
}

export const LIVE_FRAGMENTS = {
  exertionWarmingUp: engineeringDefault(
    'live.exertion.warming-up',
    'warming up — velocity loss needs a second rep',
    'Velocity loss is a ratio against the first rep, so one rep has nothing to compare yet.',
  ),
  exertionReading: engineeringDefault(
    'live.exertion.reading',
    'VL{{lossPct}}% · stop at VL{{stopPct}}%',
    'Shows the measured loss beside the stop threshold and nothing else, since a reps-left ' +
      'claim read off velocity loss is a conversion the wall does not make.',
  ),
  restDefault: engineeringDefault('live.rest-basis.default', 'Default rest', MARKS_DERIVED_REST),
  restDefaultForIntent: engineeringDefault(
    'live.rest-basis.for-intent',
    'Default rest for {{intent}}',
    MARKS_DERIVED_REST,
  ),
  restExtended: engineeringDefault(
    'live.rest-basis.extended',
    '{{base}} +{{extensionSeconds}} s',
    'Shows the automatic rest extension as its own addition to the derived rest; the step and cap are engineering defaults set in rest-defaults.ts, not a published figure.',
  ),
  effortAccessibleLabel: engineeringDefault(
    'live.effort.accessible-label',
    '{{caption}}. Basis: {{basis}}',
    'Puts the basis in the accessible label, because the tooltip that shows it needs a hover.',
  ),
  effortPlanTarget: engineeringDefault('live.effort.plan-target', 'Target {{text}}', NOT_A_READING),
  effortAssumedTier: engineeringDefault(
    'live.effort.assumed-tier',
    '{{text}} (assumed tier)',
    NOT_A_READING,
  ),
  armSourcePlanIntent: ownerRuling(
    'live.arm-source.plan-intent',
    'Plan · {{intent}} · stop {{stopPct}}%',
  ),
  armSourcePlan: ownerRuling('live.arm-source.plan', 'Plan · stop {{stopPct}}%'),
  armSourceDefault: ownerRuling('live.arm-source.default', 'Default · stop {{stopPct}}% (assumed)'),
  derivedTargets: engineeringDefault(
    'live.derived-targets.caption',
    'Last time · {{date}}',
    MARKS_LAST_TIME,
  ),
  derivedSetCount: engineeringDefault(
    'live.derived-targets.set-count',
    '{{line}} (last time)',
    MARKS_LAST_TIME,
  ),
} as const satisfies Record<string, Fragment>;

export const CALIBRATION_FRAGMENTS = {
  startingRamp: engineeringDefault(
    'calibration.starting-ramp',
    'Starting ramp, not yet based on your lifts.',
    CALIBRATION_HONESTY,
  ),
  waitSessions: engineeringDefault(
    'calibration.wait.sessions',
    '{{sessions}} to calibrate.',
    CALIBRATION_HONESTY,
  ),
  waitBaseline: engineeringDefault(
    'calibration.wait.baseline',
    'Calibrates after {{baseline}}.',
    CALIBRATION_HONESTY,
  ),
  waitBoth: engineeringDefault(
    'calibration.wait.both',
    'Calibrates after {{sessions}} and {{baseline}}.',
    CALIBRATION_HONESTY,
  ),
  sessionCountOne: engineeringDefault(
    'calibration.session-count.one',
    '{{needed}} more comparable session',
    CALIBRATION_HONESTY,
  ),
  sessionCountMany: engineeringDefault(
    'calibration.session-count.many',
    '{{needed}} more comparable sessions',
    CALIBRATION_HONESTY,
  ),
  baselineCold: engineeringDefault(
    'calibration.baseline.cold',
    'more working sets of this lift',
    'A cold baseline needs enough working sets to read the lift’s rep pattern.',
  ),
  baselineShapeOnly: engineeringDefault(
    'calibration.baseline.shape-only',
    'a set taken near failure',
    'A shape-only baseline needs one set near failure before it can place the lifter’s ceiling.',
  ),
  recalibrationOffered: engineeringDefault(
    'calibration.recalibration-offered',
    'Calibrated. Your goal is still the starting ramp; a target based on your lifts is ready.',
    'Offers the data-based target without swapping it in, so the lifter decides whether to take it.',
  ),
} as const satisfies Record<string, Fragment>;

export const DASHBOARD_FRAGMENT_LIST: readonly Fragment[] = [
  ...Object.values(LIVE_FRAGMENTS),
  ...Object.values(CALIBRATION_FRAGMENTS),
];
