// The wall dashboard's coaching lines (VW-727), as sourced fragments: the live
// stage captions in `live-page/live-copy.ts`, the calibrating-goal lines in
// `goals/calibration-copy.ts` and the session-completion page's labels and tips.
// `{{token}}` slots are filled with `fillSlots`.

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

// The rule-1 sources of the re-entry rule: fifteen days or more off is a break worth naming.
const BREAK_AGE_SOURCE =
  'Hwang 2017, https://pubmed.ncbi.nlm.nih.gov/28328712/; ' +
  'Ogasawara 2011, https://pubmed.ncbi.nlm.nih.gov/21771261/';

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
  derivedTargetsStale: {
    id: 'live.derived-targets.caption-stale',
    text: 'Last time · {{date}} · {{days}} days ago, before a break',
    sourceKind: 'paper',
    sourceRef: BREAK_AGE_SOURCE,
  },
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

const SPEED_VERSUS_REPS =
  'The verdict reads bar speed, range and tempo while the recommendation reads reps against ' +
  'the plan, so the page names it when the two point opposite ways.';
const NOT_A_MEASUREMENT =
  'Says why a column is empty, so a missing verdict never reads as a good or a bad one.';

// Session-completion page (VW-937). Titan's design floor keeps explanations out of
// the visible page: a `*Label` key is the short text on the page, and a `*Tip` key
// is the sentence behind it in a tip. Never render a tip as visible text.
export const SUMMARY_FRAGMENTS = {
  howItMovedKickerLabel: engineeringDefault(
    'summary.kicker.how-it-moved.label',
    'HOW IT MOVED',
    'Heads the verdict column, which reads bar speed, range and tempo rather than reps.',
  ),
  nextTimeKickerLabel: engineeringDefault(
    'summary.kicker.next-time.label',
    'NEXT TIME · REPS VS PLAN',
    'Heads the recommendation column and says what it scores, which is reps against the plan.',
  ),
  verdictSetKickerLabel: engineeringDefault(
    'summary.kicker.verdict-set.label',
    'WORST SET #{{set}} · VL{{lossPct}}%',
    'Names the one set the verdict read, the working set with the most velocity loss.',
  ),
  movedWellMissedRepsLabel: engineeringDefault(
    'summary.disagreement.missed-reps.label',
    'Moved well · missed reps',
    SPEED_VERSUS_REPS,
  ),
  movedWellMissedRepsTip: engineeringDefault(
    'summary.disagreement.missed-reps.tip',
    'Moved well, but missed reps.',
    SPEED_VERSUS_REPS,
  ),
  movedWellPlanBacksOffLabel: engineeringDefault(
    'summary.disagreement.plan-backs-off.label',
    'Moved well · plan backs off',
    SPEED_VERSUS_REPS,
  ),
  movedWellPlanBacksOffTip: engineeringDefault(
    'summary.disagreement.plan-backs-off.tip',
    'Moved well, but the plan backs off for a reason other than missed reps.',
    'Most working sets were not short of the band, so the back-off came from another rule and ' +
      'the page does not blame the reps.',
  ),
  struggledPlanAddsLabel: engineeringDefault(
    'summary.disagreement.plan-adds.label',
    'Struggled · plan adds',
    SPEED_VERSUS_REPS,
  ),
  struggledPlanAddsTip: engineeringDefault(
    'summary.disagreement.plan-adds.tip',
    'Struggled, but hit the reps, so the plan adds load.',
    'A load step is only ever earned by topping out the rep band, so a slow bar beside one ' +
      'still had the reps.',
  ),
  rirCalibratingLabel: engineeringDefault(
    'summary.rir.calibrating.label',
    'RIR · Calibrating',
    'Shows that reps in reserve exist as a reading but are not shown yet.',
  ),
  rirCalibratingTip: engineeringDefault(
    'summary.rir.calibrating.tip',
    'Held back until fitted to your own sets.',
    'Says why no reps-in-reserve figure shows yet, so its absence never reads as a missing ' +
      'measurement.',
  ),
  usualRangeLabel: engineeringDefault(
    'summary.usual-range.label',
    'Your usual here · {{low}}–{{high}} reps',
    'Shows a range, never a point, because reps to a velocity-loss stop vary by several reps ' +
      'between sessions at the same load.',
  ),
  usualRangeTip: engineeringDefault(
    'summary.usual-range.tip',
    'Reps your past sets at this load reached before the velocity-loss stop. {{basis}}',
    'Says the range counts reps to a velocity-loss stop, not reps to failure, and passes the ' +
      'server’s own basis through.',
  ),
  unloadedSetsOneLabel: engineeringDefault(
    'summary.totals.unloaded.one.label',
    'excl. {{count}} unloaded set',
    'Says the volume total leaves out sets with no load rather than counting them as zero.',
  ),
  unloadedSetsManyLabel: engineeringDefault(
    'summary.totals.unloaded.many.label',
    'excl. {{count}} unloaded sets',
    'Says the volume total leaves out sets with no load rather than counting them as zero.',
  ),
  notScoredLabel: engineeringDefault(
    'summary.absent.not-scored.label',
    'Not scored',
    NOT_A_MEASUREMENT,
  ),
  notScoredTip: engineeringDefault(
    'summary.absent.not-scored.tip',
    'No working sets here. The verdict reads working sets only.',
    NOT_A_MEASUREMENT,
  ),
  noBarSpeedLabel: engineeringDefault(
    'summary.absent.no-bar-speed.label',
    'No bar-speed data',
    NOT_A_MEASUREMENT,
  ),
  noBarSpeedTip: engineeringDefault(
    'summary.absent.no-bar-speed.tip',
    'No working set recorded bar speed, so there is nothing to judge.',
    NOT_A_MEASUREMENT,
  ),
  noVerdictLabel: engineeringDefault(
    'summary.absent.no-verdict.label',
    'No verdict',
    NOT_A_MEASUREMENT,
  ),
  noVerdictTip: engineeringDefault(
    'summary.absent.no-verdict.tip',
    'These sets did not carry enough data for a verdict.',
    NOT_A_MEASUREMENT,
  ),
} as const satisfies Record<string, Fragment>;

export const DASHBOARD_FRAGMENT_LIST: readonly Fragment[] = [
  ...Object.values(LIVE_FRAGMENTS),
  ...Object.values(CALIBRATION_FRAGMENTS),
  ...Object.values(SUMMARY_FRAGMENTS),
];
