// Unit tests for the accountability reducer (VW-286).
//
// Every test drives a FAKE CLOCK: the whole protocol is about when the coach
// is allowed to speak, so a test that could not pin the instant would be
// testing nothing. Dates below are real weekdays — 2026-09-13 is a Sunday.

import { describe, expect, it } from 'vitest';
import {
  GHOST_SEND_TOTAL,
  initialAccountabilityState,
  reduceAccountability,
} from '../state-machine.js';
import { fixedClock, type AccountabilityEvent, type AccountabilityState } from '../types.js';

const SUNDAY = '2026-09-13T18:00:00.000Z';
const MONDAY = '2026-09-14T18:00:00.000Z';
const THURSDAY = '2026-09-17T18:00:00.000Z';

function fresh(at = SUNDAY): AccountabilityState {
  return initialAccountabilityState('local', new Date(at));
}

function step(
  state: AccountabilityState,
  event: AccountabilityEvent,
  at: string,
): { state: AccountabilityState; decision: ReturnType<typeof reduceAccountability>['decision'] } {
  return reduceAccountability(state, event, fixedClock(at));
}

function thursdayTick(
  overrides: Partial<Extract<AccountabilityEvent, { type: 'thursday_tick' }>> = {},
): AccountabilityEvent {
  return {
    type: 'thursday_tick',
    earlyWeekMiss: false,
    plannedSessionSkippedSinceSunday: false,
    adherenceTrend: 'improving',
    ...overrides,
  };
}

describe('rolling 7-day ceiling', () => {
  it('withholds a third proactive message inside the same 7 days', () => {
    const anchor = step(fresh(), { type: 'sunday_anchor_tick' }, SUNDAY);
    expect(anchor.decision).toMatchObject({ action: 'send', kind: 'sunday_anchor' });

    const miss = step(anchor.state, { type: 'planned_session_missed' }, MONDAY);
    expect(miss.decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });

    const second = step(miss.state, thursdayTick({ earlyWeekMiss: true }), THURSDAY);
    expect(second.decision.action).toBe('silent');
    expect(second.decision.reason).toContain('2 proactive messages in the last 7 days');
    expect(second.state.proactiveSends).toHaveLength(2);
  });

  it('lets the window slide: a send 8 days later is allowed again', () => {
    const anchor = step(fresh(), { type: 'sunday_anchor_tick' }, SUNDAY);
    const miss = step(anchor.state, { type: 'planned_session_missed' }, MONDAY);
    const nextWeek = step(miss.state, { type: 'sunday_anchor_tick' }, '2026-09-21T18:00:00.000Z');
    expect(nextWeek.decision).toMatchObject({ action: 'send', kind: 'sunday_anchor' });
  });
});

describe('Thursday trigger', () => {
  it('is silent when no trigger fires', () => {
    const state = fresh();
    const { decision } = step(state, thursdayTick(), THURSDAY);
    expect(decision.action).toBe('silent');
    expect(decision.reason).toContain('Silence through the week means the plan is on track');
  });

  it('fires on a missed Monday or Tuesday planned session', () => {
    const { decision } = step(fresh(), thursdayTick({ earlyWeekMiss: true }), THURSDAY);
    expect(decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
    expect(decision.reason).toContain('early_week_miss');
  });

  it.each(['steady', 'declining'] as const)('fires on a %s adherence trend', (trend) => {
    const { decision } = step(fresh(), thursdayTick({ adherenceTrend: trend }), THURSDAY);
    expect(decision).toMatchObject({ action: 'send', kind: 'realign_opener' });
    expect(decision.reason).toContain('flat_or_worsening_trend');
  });

  it('does not fire on no-prior-data, which is not a direction', () => {
    const { decision } = step(fresh(), thursdayTick({ adherenceTrend: 'no-prior-data' }), THURSDAY);
    expect(decision.action).toBe('silent');
  });

  it('fires on a skipped session paired with silence since the Sunday anchor', () => {
    const anchor = step(fresh(), { type: 'sunday_anchor_tick' }, SUNDAY);
    const { decision } = step(
      anchor.state,
      thursdayTick({ plannedSessionSkippedSinceSunday: true }),
      THURSDAY,
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
    expect(decision.reason).toContain('skipped_session_and_silence');
  });

  it('stays silent when the lifter replied since the Sunday anchor', () => {
    const anchor = step(fresh(), { type: 'sunday_anchor_tick' }, SUNDAY);
    const replied = step(anchor.state, { type: 'inbound_reply' }, MONDAY);
    const { decision } = step(
      replied.state,
      thursdayTick({ plannedSessionSkippedSinceSunday: true }),
      THURSDAY,
    );
    expect(decision.action).toBe('silent');
  });
});

describe('miss handling', () => {
  it('sends one recovery message on the first miss', () => {
    const { state, decision } = step(fresh(), { type: 'planned_session_missed' }, MONDAY);
    expect(state.state).toBe('missed');
    expect(state.consecutiveMisses).toBe(1);
    expect(decision).toMatchObject({ action: 'send', kind: 'miss_recovery' });
  });

  it('enters ghosting on a second miss with two unanswered messages behind it', () => {
    const seeded = ghostingEntryState();
    expect(seeded.state.state).toBe('ghosting');
    expect(seeded.decision.reason).toContain('consecutive misses with no reply');
  });

  it('does not enter ghosting when fewer than two messages went unanswered', () => {
    const first = step(fresh(), { type: 'planned_session_missed' }, MONDAY);
    const second = step(
      first.state,
      { type: 'planned_session_missed' },
      '2026-09-15T18:00:00.000Z',
    );
    expect(second.state.state).toBe('missed');
    expect(second.state.consecutiveMisses).toBe(2);
  });

  it('clears the miss run when a session is completed', () => {
    const missed = step(fresh(), { type: 'planned_session_missed' }, MONDAY);
    const done = step(missed.state, { type: 'session_completed' }, THURSDAY);
    expect(done.state.state).toBe('completed');
    expect(done.state.consecutiveMisses).toBe(0);
    expect(done.decision.action).toBe('silent');
  });
});

describe('ghost protocol', () => {
  it('sends exactly 4 messages over 2 weeks and then stops', () => {
    const entry = ghostingEntryState();
    expect(entry.decision).toMatchObject({ action: 'send', kind: 'ghost_nudge' });
    let state = entry.state;

    // Two a week for two weeks, at the pace the rolling ceiling allows.
    for (const at of [
      '2026-09-10T18:00:00.000Z',
      '2026-09-20T18:00:00.000Z',
      '2026-09-24T18:00:00.000Z',
    ]) {
      const tick = step(state, { type: 'sunday_anchor_tick' }, at);
      expect(tick.decision, `expected a ghost nudge at ${at}`).toMatchObject({
        action: 'send',
        kind: 'ghost_nudge',
      });
      state = tick.state;
    }
    expect(state.ghostSends).toHaveLength(GHOST_SEND_TOTAL);

    const afterStop = step(state, { type: 'sunday_anchor_tick' }, '2026-10-04T18:00:00.000Z');
    expect(afterStop.decision.action).toBe('silent');
    expect(afterStop.decision.reason).toContain('stopped for good');
    expect(afterStop.state.ghostSends).toHaveLength(GHOST_SEND_TOTAL);
  });

  it('defers the first ghost nudge when the week already spent both messages', () => {
    const anchor = step(fresh(), { type: 'sunday_anchor_tick' }, SUNDAY);
    const firstMiss = step(anchor.state, { type: 'planned_session_missed' }, MONDAY);
    const entry = step(
      firstMiss.state,
      { type: 'planned_session_missed' },
      '2026-09-15T18:00:00.000Z',
    );
    expect(entry.state.state).toBe('ghosting');
    expect(entry.decision.action).toBe('silent');
    expect(entry.state.ghostSends).toEqual([]);
  });

  it('never spends more than two ghost messages in one rolling week', () => {
    const entered = ghostingEntryState();
    const second = step(entered.state, { type: 'sunday_anchor_tick' }, '2026-09-10T18:00:00.000Z');
    const third = step(second.state, { type: 'sunday_anchor_tick' }, '2026-09-13T18:00:00.000Z');
    expect(third.decision.action).toBe('silent');
    expect(third.state.ghostSends).toHaveLength(2);
  });

  it('clears on an inbound reply months later and re-arms normal cadence', () => {
    const ghosting = ghostingEntryState().state;
    const reply = step(ghosting, { type: 'inbound_reply' }, '2027-02-01T09:00:00.000Z');
    expect(reply.state.state).toBe('planned');
    expect(reply.state.ghostSends).toEqual([]);
    expect(reply.state.consecutiveMisses).toBe(0);
    expect(reply.decision.reason).toContain('no comment on the gap');

    const anchor = step(reply.state, { type: 'sunday_anchor_tick' }, '2027-02-07T18:00:00.000Z');
    expect(anchor.decision).toMatchObject({ action: 'send', kind: 'sunday_anchor' });
  });
});

describe('holding', () => {
  it('suppresses miss detection inside the declared window', () => {
    const held = step(
      fresh(),
      { type: 'holding_declared', until: '2026-09-27T00:00:00.000Z' },
      SUNDAY,
    );
    const missed = step(held.state, { type: 'planned_session_missed' }, MONDAY);
    expect(missed.state.state).toBe('holding');
    expect(missed.state.consecutiveMisses).toBe(0);
    expect(missed.decision.action).toBe('silent');
    expect(missed.decision.reason).toContain('expected, not failures');
  });

  it('resumes miss detection once the window has elapsed', () => {
    const held = step(
      fresh(),
      { type: 'holding_declared', until: '2026-09-20T00:00:00.000Z' },
      SUNDAY,
    );
    const missed = step(held.state, { type: 'planned_session_missed' }, '2026-09-21T18:00:00.000Z');
    expect(missed.state.state).toBe('missed');
    expect(missed.state.consecutiveMisses).toBe(1);
  });

  it('resumes on an explicit holding_ended', () => {
    const held = step(
      fresh(),
      { type: 'holding_declared', until: '2026-12-01T00:00:00.000Z' },
      SUNDAY,
    );
    const ended = step(held.state, { type: 'holding_ended' }, MONDAY);
    expect(ended.state.state).toBe('planned');
    expect(ended.state.holdingUntil).toBeNull();
  });
});

describe('realign ceiling', () => {
  it('opens the realign conversation only after the trend holds across mesocycles', () => {
    const oneMeso = step(
      fresh(),
      { type: 'deviation_trend_updated', trend: 'declining', sustainedMesocycles: 1 },
      SUNDAY,
    );
    expect(oneMeso.decision.action).toBe('silent');
    expect(oneMeso.state.state).toBe('planned');

    const twoMeso = step(
      fresh(),
      { type: 'deviation_trend_updated', trend: 'declining', sustainedMesocycles: 2 },
      SUNDAY,
    );
    expect(twoMeso.decision).toMatchObject({ action: 'send', kind: 'realign_opener' });
    expect(twoMeso.state.state).toBe('realign_needed');
  });

  it('never transitions or sends again on its own once realign_needed', () => {
    const realign = step(
      fresh(),
      { type: 'deviation_trend_updated', trend: 'declining', sustainedMesocycles: 3 },
      SUNDAY,
    );
    const later = step(realign.state, { type: 'sunday_anchor_tick' }, '2026-09-27T18:00:00.000Z');
    expect(later.state.state).toBe('realign_needed');
    expect(later.decision.action).toBe('silent');

    const missed = step(
      later.state,
      { type: 'planned_session_missed' },
      '2026-09-28T18:00:00.000Z',
    );
    expect(missed.state.state).toBe('realign_needed');
    expect(missed.decision.action).toBe('silent');
    expect(missed.decision.reason).toContain('without the human');
  });
});

/**
 * Two misses with two unanswered proactive messages behind them: the ghosting
 * entry. The sends are spaced a week apart so the rolling ceiling is not
 * already spent when ghosting starts — entering ghosting inside a week that
 * has already used both messages defers the first nudge rather than exceeding
 * the ceiling, which is its own test above.
 */
function ghostingEntryState(): ReturnType<typeof step> {
  const anchor = step(
    fresh('2026-08-30T18:00:00.000Z'),
    { type: 'sunday_anchor_tick' },
    '2026-08-30T18:00:00.000Z',
  );
  const firstMiss = step(
    anchor.state,
    { type: 'planned_session_missed' },
    '2026-08-31T18:00:00.000Z',
  );
  return step(firstMiss.state, { type: 'planned_session_missed' }, '2026-09-07T18:00:00.000Z');
}
