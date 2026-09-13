// The accountability protocol reducer (VW-286, child rows 10 + 12).
//
// PURE. It reads the current state, one event and an injected clock, and
// returns the next state plus a decision. It performs no I/O, queries no
// store, and writes no message text — a sibling module (VW-287) composes what
// gets said; this one only decides WHEN, and says why in every `reason`.
//
// Numbers, and where each one comes from:
//
// - 2 proactive messages per rolling 7-day window, and in `ghosting` exactly
//   2 per week for 2 weeks (4 total) then a full stop: RP's ghost-client
//   follow-up protocol (rp-s10, digest §2). This is the ONLY hard cadence
//   number in either research file; everything else below is derived or
//   guessed.
// - N=1 miss triggers the recovery prompt, N=2 consecutive misses with no
//   reply enters `ghosting`: BOTH ARE GUESSES. The RP digest §4 states the
//   corpus never gives a missed-session threshold and the literature gives
//   none either. N=1 follows from the megastudy's leverage point (returning
//   after a miss); N=2 keeps the ghost protocol off a single bad week.
// - A realign conversation needs the deviation direction to hold across 2
//   mesocycles: A GUESS. RP keys the ladder to "trend across mesocycles"
//   without naming a count.
// - The escalation ceiling (nudge -> realign conversation -> stop) is a
//   binding human decision, so `realign_needed` never transitions further on
//   its own.
//
// Channel constraint: BlueBubbles publishes no delivery or read receipt
// without the Private-API helper bundle (which requires disabling SIP, which
// we are not doing). Silence is therefore the ONLY negative signal, and
// nothing here may branch on "delivered" or "read" — only on inbound replies.

import type {
  AccountabilityDecision,
  AccountabilityEvent,
  AccountabilityState,
  AccountabilityTransition,
  AdherenceTrend,
  Clock,
  ProactiveKind,
  ProactiveSend,
  ProtocolState,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ceiling of proactive messages in any rolling 7-day window (RP ghost protocol). */
export const PROACTIVE_CEILING_PER_WINDOW = 2;
export const PROACTIVE_WINDOW_MS = 7 * DAY_MS;
/** 2 per week for 2 weeks, then proactive outreach stops for good. */
export const GHOST_SEND_TOTAL = 4;
/** Consecutive misses with no reply that enter `ghosting`. A GUESS (RP digest §4). */
export const GHOSTING_MISS_THRESHOLD = 2;
/** Mesocycles a flat/worsening direction must hold before a realign opener. A GUESS. */
export const REALIGN_SUSTAINED_MESOCYCLES = 2;
/** How far back the send history is kept; only the 7-day window is ever read. */
const SEND_HISTORY_RETENTION_MS = 30 * DAY_MS;

export function initialAccountabilityState(userId: string, now: Date): AccountabilityState {
  return {
    userId,
    state: 'planned',
    enteredAt: now.toISOString(),
    consecutiveMisses: 0,
    ghostSends: [],
    lastInboundAt: null,
    proactiveSends: [],
    holdingUntil: null,
  };
}

export function reduceAccountability(
  current: AccountabilityState,
  event: AccountabilityEvent,
  clock: Clock,
): AccountabilityTransition {
  const now = clock.now();
  const state = expireHolding(current, now);
  if (state.state === 'realign_needed') return reduceInRealign(state, event, now);
  switch (event.type) {
    case 'session_completed':
      return onSessionCompleted(state, now);
    case 'planned_session_missed':
      return onPlannedSessionMissed(state, now);
    case 'inbound_reply':
      return onInboundReply(state, now);
    case 'sunday_anchor_tick':
      return onSundayAnchorTick(state, now);
    case 'thursday_tick':
      return onThursdayTick(state, event, now);
    case 'holding_declared':
      return onHoldingDeclared(state, event.until, now);
    case 'holding_ended':
      return onHoldingEnded(state, now);
    case 'deviation_trend_updated':
      return onDeviationTrendUpdated(state, event.trend, event.sustainedMesocycles, now);
  }
}

/**
 * `realign_needed` is where the automatic part of the ladder stops. Events are
 * still RECORDED here (an inbound reply and a miss are both facts), but no
 * transition and no send happens without the human.
 */
function reduceInRealign(
  state: AccountabilityState,
  event: AccountabilityEvent,
  now: Date,
): AccountabilityTransition {
  const reason =
    'realign_needed: the escalation ceiling is nudge -> realign conversation -> stop, ' +
    'and nothing past the realign conversation happens without the human';
  if (event.type === 'inbound_reply') {
    return silent({ ...state, lastInboundAt: now.toISOString() }, reason);
  }
  if (event.type === 'planned_session_missed') {
    return silent({ ...state, consecutiveMisses: state.consecutiveMisses + 1 }, reason);
  }
  if (event.type === 'session_completed') {
    return silent({ ...state, consecutiveMisses: 0 }, reason);
  }
  return silent(state, reason);
}

function onSessionCompleted(state: AccountabilityState, now: Date): AccountabilityTransition {
  const cleared = { ...state, consecutiveMisses: 0, ghostSends: [] };
  // Clearing `ghosting` on telemetry rather than only on an inbound reply is a
  // GUESS the plan does not make: it names inbound as the clearing event and
  // says nothing about a lifter who simply trains again. Staying in `ghosting`
  // while they are visibly training would spend ghost nudges on someone who
  // came back, which is the failure the protocol exists to avoid.
  const reason =
    state.state === 'ghosting'
      ? 'session completed while ghosting: training again re-arms normal cadence (a guess — ' +
        'the plan names only an inbound reply as the clearing event)'
      : 'session completed: telemetry closed the loop, so nothing proactive is owed';
  return silent(enter(cleared, 'completed', now), reason);
}

function onPlannedSessionMissed(state: AccountabilityState, now: Date): AccountabilityTransition {
  if (isHolding(state, now)) {
    return silent(
      state,
      `holding until ${String(state.holdingUntil)}: missed sessions in a declared disruption ` +
        'window are expected, not failures, so no miss is counted',
    );
  }
  const counted = { ...state, consecutiveMisses: state.consecutiveMisses + 1 };
  if (state.state === 'ghosting') {
    return silent(counted, 'ghosting: outreach is governed by the ghost protocol, not by misses');
  }
  if (entersGhosting(counted)) {
    return ghostNudgeOrSilent(
      enter(counted, 'ghosting', now),
      now,
      `${counted.consecutiveMisses} consecutive misses with no reply to the last two proactive ` +
        'messages (N=2 is a guess; the corpus gives no threshold)',
    );
  }
  return sendOrSilent(
    enter(counted, 'missed', now),
    'miss_recovery',
    `miss ${counted.consecutiveMisses}: the planned day and its named fallback day both passed ` +
      'with no session (N=1 is a guess; the corpus gives no threshold)',
    now,
  );
}

function onInboundReply(state: AccountabilityState, now: Date): AccountabilityTransition {
  const recorded = { ...state, lastInboundAt: now.toISOString(), ghostSends: [] };
  if (state.state === 'ghosting') {
    return silent(
      enter({ ...recorded, consecutiveMisses: 0 }, 'planned', now),
      'inbound reply at any latency clears ghosting and re-arms normal cadence, with no ' +
        'comment on the gap',
    );
  }
  return silent(
    recorded,
    'inbound reply recorded: answering it is reactive, so it is neither a proactive send nor ' +
      'counted against the 7-day ceiling',
  );
}

function onSundayAnchorTick(state: AccountabilityState, now: Date): AccountabilityTransition {
  if (state.state === 'ghosting') {
    return ghostNudgeOrSilent(state, now, 'ghosting: the Sunday tick spends a ghost message');
  }
  return sendOrSilent(
    state,
    'sunday_anchor',
    'Sunday anchor: the one contractually fixed proactive touch of the week',
    now,
  );
}

function onThursdayTick(
  state: AccountabilityState,
  event: Extract<AccountabilityEvent, { type: 'thursday_tick' }>,
  now: Date,
): AccountabilityTransition {
  const trigger = thursdayTrigger(state, event);
  if (trigger === null) {
    return silent(
      state,
      'Thursday: no trigger fired — no early-week miss, no flat or worsening trend, and no ' +
        'skipped session paired with silence since Sunday. Silence through the week means the ' +
        'plan is on track',
    );
  }
  if (state.state === 'ghosting') {
    return ghostNudgeOrSilent(state, now, `ghosting: Thursday trigger ${trigger}`);
  }
  const kind: ProactiveKind =
    trigger === 'flat_or_worsening_trend' ? 'realign_opener' : 'miss_recovery';
  return sendOrSilent(state, kind, `Thursday trigger: ${trigger}`, now);
}

/**
 * The three triggers, in the plan's order. Anything else is silence: a second
 * scheduled low-information touch is precisely the message that habituates.
 */
function thursdayTrigger(
  state: AccountabilityState,
  event: Extract<AccountabilityEvent, { type: 'thursday_tick' }>,
): 'early_week_miss' | 'flat_or_worsening_trend' | 'skipped_session_and_silence' | null {
  if (event.earlyWeekMiss) return 'early_week_miss';
  if (isFlatOrWorsening(event.adherenceTrend)) return 'flat_or_worsening_trend';
  if (event.plannedSessionSkippedSinceSunday && noInboundSinceSundayAnchor(state)) {
    return 'skipped_session_and_silence';
  }
  return null;
}

function onHoldingDeclared(
  state: AccountabilityState,
  until: string,
  now: Date,
): AccountabilityTransition {
  const held = enter({ ...state, holdingUntil: until, consecutiveMisses: 0 }, 'holding', now);
  return silent(held, `holding declared until ${until}: miss detection is suppressed until then`);
}

function onHoldingEnded(state: AccountabilityState, now: Date): AccountabilityTransition {
  const released = enter({ ...state, holdingUntil: null }, 'planned', now);
  return silent(released, 'holding ended: normal miss detection resumes');
}

function onDeviationTrendUpdated(
  state: AccountabilityState,
  trend: AdherenceTrend,
  sustainedMesocycles: number,
  now: Date,
): AccountabilityTransition {
  if (!isFlatOrWorsening(trend) || sustainedMesocycles < REALIGN_SUSTAINED_MESOCYCLES) {
    return silent(
      state,
      `deviation trend "${trend}" over ${sustainedMesocycles} mesocycle(s): ` +
        'below the realign threshold',
    );
  }
  if (state.state === 'ghosting') {
    // The plan lists "ghosting exit with no re-initiation" as a realign entry,
    // but a realign opener IS proactive outreach and the ghost stop condition
    // forbids that. The stop condition wins; escalating past it is a human call.
    return silent(state, 'ghosting: the ghost stop condition outranks the escalation ladder');
  }
  const reason =
    `deviation trend "${trend}" held across ${sustainedMesocycles} mesocycles ` +
    '(threshold 2 is a guess): open the realign conversation, which is the last automatic rung';
  if (ceilingReached(state, now)) {
    return silent(state, `${reason} — withheld: 2-in-7-days ceiling reached, state left unchanged`);
  }
  return {
    state: recordSend(enter(state, 'realign_needed', now), 'realign_opener', now),
    decision: { action: 'send', kind: 'realign_opener', reason },
  };
}

function sendOrSilent(
  state: AccountabilityState,
  kind: ProactiveKind,
  reason: string,
  now: Date,
): AccountabilityTransition {
  if (ceilingReached(state, now)) {
    return silent(
      state,
      `${reason} — withheld: already sent ${PROACTIVE_CEILING_PER_WINDOW} proactive messages in ` +
        'the last 7 days',
    );
  }
  return { state: recordSend(state, kind, now), decision: { action: 'send', kind, reason } };
}

function ghostNudgeOrSilent(
  state: AccountabilityState,
  now: Date,
  reason: string,
): AccountabilityTransition {
  if (state.ghostSends.length >= GHOST_SEND_TOTAL) {
    return silent(
      state,
      `${reason} — the ghost protocol has spent its ${GHOST_SEND_TOTAL} messages (2 a week for ` +
        '2 weeks). Proactive outreach has stopped for good; only an inbound reply restarts it',
    );
  }
  return sendOrSilent(state, 'ghost_nudge', reason, now);
}

function recordSend(
  state: AccountabilityState,
  kind: ProactiveKind,
  now: Date,
): AccountabilityState {
  const at = now.toISOString();
  const proactiveSends = trimSends([...state.proactiveSends, { at, kind }], now);
  const ghostSends = kind === 'ghost_nudge' ? [...state.ghostSends, at] : state.ghostSends;
  return { ...state, proactiveSends, ghostSends };
}

function trimSends(sends: ProactiveSend[], now: Date): ProactiveSend[] {
  const cutoff = now.getTime() - SEND_HISTORY_RETENTION_MS;
  const recent = sends.filter((s) => Date.parse(s.at) >= cutoff);
  // The ghosting test reads the last two sends regardless of age, so they are
  // never trimmed away even when the whole history is older than the cutoff.
  return recent.length >= 2 ? recent : sends.slice(-2);
}

function ceilingReached(state: AccountabilityState, now: Date): boolean {
  const cutoff = now.getTime() - PROACTIVE_WINDOW_MS;
  const inWindow = state.proactiveSends.filter((s) => Date.parse(s.at) > cutoff);
  return inWindow.length >= PROACTIVE_CEILING_PER_WINDOW;
}

/**
 * `ghosting` needs BOTH halves of the plan's entry condition: the miss run and
 * two proactive messages that went unanswered. With fewer than two sends
 * behind us, silence is not evidence of anything.
 */
function entersGhosting(state: AccountabilityState): boolean {
  if (state.consecutiveMisses < GHOSTING_MISS_THRESHOLD) return false;
  const lastTwo = state.proactiveSends.slice(-GHOSTING_MISS_THRESHOLD);
  if (lastTwo.length < GHOSTING_MISS_THRESHOLD) return false;
  return !hasInboundSince(state, lastTwo[0]!.at);
}

function noInboundSinceSundayAnchor(state: AccountabilityState): boolean {
  const anchors = state.proactiveSends.filter((s) => s.kind === 'sunday_anchor');
  const last = anchors[anchors.length - 1];
  // No anchor has ever gone out, so silence since "Sunday" carries no signal.
  if (last === undefined) return false;
  return !hasInboundSince(state, last.at);
}

function hasInboundSince(state: AccountabilityState, at: string): boolean {
  return state.lastInboundAt !== null && Date.parse(state.lastInboundAt) >= Date.parse(at);
}

function isFlatOrWorsening(trend: AdherenceTrend | null): boolean {
  // `report.weekly` reports direction, never a count: 'steady' is flat and
  // 'declining' is worsening. 'no-prior-data' is not a direction and must not
  // fire anything.
  return trend === 'steady' || trend === 'declining';
}

function isHolding(state: AccountabilityState, now: Date): boolean {
  return state.state === 'holding' && !holdingElapsed(state, now);
}

function holdingElapsed(state: AccountabilityState, now: Date): boolean {
  return state.holdingUntil !== null && Date.parse(state.holdingUntil) <= now.getTime();
}

/** A declared window that has run out stops suppressing anything. */
function expireHolding(state: AccountabilityState, now: Date): AccountabilityState {
  if (state.state !== 'holding' || !holdingElapsed(state, now)) return state;
  return enter({ ...state, holdingUntil: null }, 'planned', now);
}

function enter(state: AccountabilityState, next: ProtocolState, now: Date): AccountabilityState {
  if (state.state === next) return state;
  return { ...state, state: next, enteredAt: now.toISOString() };
}

function silent(state: AccountabilityState, reason: string): AccountabilityTransition {
  const decision: AccountabilityDecision = { action: 'silent', reason };
  return { state, decision };
}
