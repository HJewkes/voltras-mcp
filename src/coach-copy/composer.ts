// The line templates `src/accountability/composer.ts` fills into the
// accountability messages (VW-726), as sourced fragments. `{{token}}` slots are
// filled by the composer; a line is one sentence of a message, not a message.

import type { Fragment, SourcedValue } from './fragments.js';

const FREQUENCY_HOLD = 'rp-s5-frequency-progression-conservative';
const IF_THEN_PAPERS =
  'Silva et al. 2018, https://doi.org/10.1371/journal.pone.0206294; ' +
  'Belanger-Gravel et al. 2013, https://doi.org/10.1080/17437199.2011.560095';
const IF_THEN_RATIONALE =
  'because a plan you wrote yourself is the one that holds when the week pushes back';
const TREND_AS_DIRECTION =
  'Trend reads as a direction, never a raw deviation count, because a count is the running ' +
  'total the copy rules ban.';
const RE_ENTRY_SIZE =
  'A small re-entry on a named day is inspired by, not established by, the 2021 exercise ' +
  'megastudy, whose winner rewarded returning after a miss; the link is unverified.';

function engineeringDefault(id: string, text: string, reason: string): Fragment {
  return { id, text, sourceKind: 'engineering-default', sourceRef: reason };
}

export const COMPOSER_FRAGMENTS = {
  adherenceNone: engineeringDefault(
    'composer.adherence-none',
    'Nothing was on the calendar last week, so there is no planned-versus-recorded read to show.',
    'An empty calendar is not a shortfall, so the line says there is nothing to compare.',
  ),
  adherenceRead: engineeringDefault(
    'composer.adherence-read',
    'Planned {{planned}}, recorded {{done}}. Deviation trend: {{trend}}.',
    'Shows last week as the records have it rather than asking how it went; the wording is ours.',
  ),
  trendImproving: engineeringDefault('composer.trend.improving', 'improving', TREND_AS_DIRECTION),
  trendDeclining: engineeringDefault('composer.trend.declining', 'worsening', TREND_AS_DIRECTION),
  trendSteady: engineeringDefault('composer.trend.steady', 'flat', TREND_AS_DIRECTION),
  trendNoPrior: engineeringDefault(
    'composer.trend.no-prior',
    'no prior week to compare',
    TREND_AS_DIRECTION,
  ),
  rolling: engineeringDefault(
    'composer.rolling',
    'Rolling 28-day training days: {{trainingDays}}.',
    'A rolling count has no zero state to break, which is inspired by, not established by, ' +
      'Silverman and Barasch 2023 on broken streaks; the 28-day window is ours.',
  ),
  nextUpEmpty: engineeringDefault(
    'composer.next-up-empty',
    'Nothing is queued on the plan right now, which is ten minutes of programming whenever you want it.',
    'Names the gap and the small cost of closing it, with no evaluation of the lifter.',
  ),
  nextUp: engineeringDefault(
    'composer.next-up',
    'Next on the plan: {{templateName}}, with {{exercises}}.',
    'A readout of the queued workout, so the message points at a concrete next session.',
  ),
  planning: engineeringDefault(
    'composer.planning',
    'The next block is due to be planned: {{reason}} Pick a time this week to plan it with me, ' +
      'because a block dated before it starts is one the week can be built around.',
    'Offers the planning sitting without starting it, so the lifter picks when; the wording is ours.',
  ),
  slot: engineeringDefault(
    'composer.slot',
    '{{day}} (fallback {{fallbackDay}})',
    'Each planned day is shown with its named fallback so a moved session still counts.',
  ),
  slots: engineeringDefault(
    'composer.slots',
    'Slots for the coming week, each with its named fallback: run {{slots}}, because a session on ' +
      'its fallback day counts as recorded, which is the whole point of naming fallbacks.',
    'Confirms the week with a fallback per slot; no cited claim sets this wording.',
  ),
  ifThenFirst: {
    id: 'composer.if-then-first',
    text:
      'This week\'s if-then is yours to write, in the shape of "if this gets in the way, then that ' +
      `slot moves here", so send it in your own words, ${IF_THEN_RATIONALE}.`,
    sourceKind: 'paper',
    sourceRef: IF_THEN_PAPERS,
  },
  ifThenRepeat: {
    id: 'composer.if-then-repeat',
    text:
      'Your if-then from last week was: "{{ifThenPlan}}". Send this week\'s version with the barrier ' +
      `you actually expect named in it, ${IF_THEN_RATIONALE}.`,
    sourceKind: 'paper',
    sourceRef: IF_THEN_PAPERS,
  },
  monthMarker: engineeringDefault(
    'composer.month-marker',
    'Month marker: the target in your own words is "{{wording}}", and restating or revising it is ' +
      'yours to do, because a number I pick for you is not a commitment.',
    'A self-authored monthly target is inspired by, not established by, Royer et al. 2015 on ' +
      'commitment contracts; the self-authored detail is unverified.',
  ),
  loadClause: engineeringDefault(
    'composer.load-clause',
    ', load held at {{weightLbs}} lb',
    'States the planned load so a short re-entry does not read as a cue to lighten it.',
  ),
  reEntryOffer: engineeringDefault(
    'composer.re-entry-offer',
    'One way back in, smaller than the plan asks for: {{reEntryDay}}, {{minutes}} minutes, run ' +
      '{{exercise}} plus one accessory{{loadClause}}, because a short session that happens is ' +
      'what the next progression reads from.',
    RE_ENTRY_SIZE,
  ),
  booking: engineeringDefault(
    'composer.booking',
    'Reply with a yes and it goes on the plan for {{reEntryDay}}, because a booked slot defends ' +
      'itself better than an intention does.',
    'Puts the re-entry on a named day; inspired by, not established by, the if-then research, ' +
      'which tested plans people wrote themselves rather than a booked slot.',
  ),
  holdingMaintenance: engineeringDefault(
    'composer.holding-maintenance',
    'If you want to keep a hand in while it runs, one option is {{minutes}} minutes of {{exercise}} ' +
      'on whichever day suits{{loadClause}}, because holding a position takes far less work than ' +
      'building it did.',
    'An optional session during a hold is inspired by, not established by, the RP rule that ' +
      'travel defaults to maintenance; the claim about less work is not from that rule.',
  ),
  holdingThrough: engineeringDefault(
    'composer.holding-through',
    ' through {{endDate}}',
    'Names the end of a dated hold so the lifter can see when normal cadence resumes.',
  ),
  reArchitect: {
    id: 'composer.re-architect',
    text:
      'If the week is genuinely fuller than the plan assumes, the fix is re-architecting to your real ' +
      'schedule: keep {{days}} days and move {{dayList}} to the hours that actually exist, renaming each ' +
      'fallback as you go, within {{days}} days rather than down from them, because {{days}} days is the ' +
      'frequency your training tier holds before any change to it is worth making.',
    sourceKind: 'rp',
    sourceRef: FREQUENCY_HOLD,
  },
  ask: engineeringDefault(
    'composer.ask',
    'Tell me which of {{dayList}} is the slot that keeps breaking and I will rebuild the week ' +
      'around the ones that hold, because moving one slot is a smaller change than moving the plan.',
    'Asks for the one failing slot so the fix is the smallest change that could work.',
  ),
} as const satisfies Record<string, Fragment>;

export const COMPOSER_FRAGMENT_LIST: readonly Fragment[] = Object.values(COMPOSER_FRAGMENTS);

/** Minutes offered for a reduced-scope re-entry or a session during a hold. */
export const REDUCED_SCOPE_MINUTES: SourcedValue<number> = {
  value: 20,
  sourceKind: 'engineering-default',
  sourceRef:
    'The planning note gives 20 minutes as an illustration; no source in either research file ' +
    'gives a re-entry session length.',
};
