// The accountability coach's message templates (VW-287) as sourced fragments.
// `src/accountability/copy.ts` re-exports each text under its historical name;
// `{{token}}` slots are filled by `src/accountability/composer.ts`.

import type { Fragment } from './fragments.js';

const COMPLIANCE_RESPONSE = 'rp-s10-lying-about-compliance-response';
const GHOST_PROTOCOL = 'rp-s10-ghost-client-followup-protocol';

export const ACCOUNTABILITY_FRAGMENTS = {
  nonJudgment: {
    id: 'accountability.non-judgment',
    text: 'No judgment in this, and none implied.',
    sourceKind: 'rp',
    sourceRef: COMPLIANCE_RESPONSE,
  },
  operationalHonesty: {
    id: 'accountability.operational-honesty',
    text:
      'The reason accuracy matters here is operational, not moral: the plan cannot ' +
      'autoregulate load and volume correctly from records that do not match what happened.',
    sourceKind: 'rp',
    sourceRef: COMPLIANCE_RESPONSE,
  },
  silenceMeansOnTrack: {
    id: 'accountability.silence-means-on-track',
    text:
      'You will not hear from me mid-week unless a planned session goes unrecorded, so ' +
      'silence through the week means the plan is on track.',
    sourceKind: 'engineering-default',
    sourceRef:
      'Silence only informs if its meaning was stated once; the mid-week quiet is a product ' +
      'choice with no corpus or paper claim behind the wording.',
  },
  sundayAnchor: {
    id: 'accountability.sunday-anchor',
    text: [
      '{{lifterName}}, it is Sunday. Here is last week as the records have it, rather than a question about how it went.',
      '{{adherenceLine}}',
      '{{rollingLine}}',
      '{{nextUpLine}}',
      '{{planningLine}}',
      '{{slotsLine}}',
      '{{ifThenLine}}',
      '{{commitmentLine}}',
      '{{silenceLine}}',
    ].join('\n'),
    sourceKind: 'rp',
    sourceRef: 'rp-s10-checkin-cadence',
  },
  missRecovery: {
    id: 'accountability.miss-recovery',
    text: [
      '{{lifterName}}, the {{plannedDay}} session ({{missedExercises}}) is not in the records, and its named fallback on {{fallbackDay}} has passed.',
      '{{nonJudgmentLine}}',
      '{{operationalHonestyLine}}',
      '{{offerLine}}',
      '{{bookingLine}}',
    ].join('\n'),
    sourceKind: 'engineering-default',
    sourceRef:
      'One re-entry offer on a named day is inspired by, not established by, the 2021 exercise ' +
      'megastudy, whose winner rewarded returning after a miss; the link is unverified.',
  },
  holdingAcknowledgement: {
    id: 'accountability.holding-acknowledgement',
    text: [
      '{{lifterName}}, the hold you declared is still running{{throughClause}}, so the empty {{plannedDay}} slot is what the plan expects this week.',
      'Nothing recalculates against a hold, and nothing is owed at the end of one.',
      '{{maintenanceLine}}',
    ].join('\n'),
    sourceKind: 'rp',
    sourceRef: 'rp-s11-unplanned-disruption-protocol, rp-s11-vacation-default-maintenance',
  },
  ghostNudge1: {
    id: 'accountability.ghost-nudge-1',
    text: [
      '{{lifterName}}, the plan is sitting where you left it, and the door does not close.',
      '{{nextUpLine}}',
      'Pick a day that works and it goes on the plan, because a day you choose beats a day I would guess at.',
    ].join('\n'),
    sourceKind: 'rp',
    sourceRef: GHOST_PROTOCOL,
  },
  ghostNudge2: {
    id: 'accountability.ghost-nudge-2',
    text: [
      '{{lifterName}}, short one.',
      '{{nextUpLine}}',
      '{{minutes}} minutes of it counts as done, because the plan recalculates from what actually happened rather than from what it asked for.',
      'Say a day and it is scheduled, because a slot in the week holds better than an intention does.',
    ].join('\n'),
    sourceKind: 'rp',
    sourceRef: GHOST_PROTOCOL,
  },
  realignOpener: {
    id: 'accountability.realign-opener',
    text: [
      '{{lifterName}}, one conversation about the shape of the week, not a verdict on it.',
      '{{nonJudgmentLine}}',
      '{{operationalHonestyLine}}',
      '{{adherenceLine}}',
      '{{rollingLine}}',
      '{{reArchitectLine}}',
      '{{askLine}}',
    ].join('\n'),
    sourceKind: 'rp',
    sourceRef: 'rp-s10-noncompliance-escalation-ladder, rp-s5-frequency-progression-conservative',
  },
} as const satisfies Record<string, Fragment>;

export const ACCOUNTABILITY_FRAGMENT_LIST: readonly Fragment[] =
  Object.values(ACCOUNTABILITY_FRAGMENTS);
