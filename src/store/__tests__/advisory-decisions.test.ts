// Tests for the `advisory_decisions` store surface (VW-350).
//
// The table has existed since v7 with no writer; `goal.declare_priorities` is
// the first one. What matters here is that answering an advisory UPDATES the
// row that fired rather than adding a second one — an advisory and its answer
// are one event, and two rows would make "how often was this declined" count
// the same decline twice.

import { describe, expect, it } from 'vitest';

import { LOCAL_USER_ID } from '../sqlite-store.js';
import type { PutAdvisoryDecisionInput } from '../types.js';
import { openTestStore } from './open-test-store.js';

function decision(overrides: Partial<PutAdvisoryDecisionInput> = {}): PutAdvisoryDecisionInput {
  return {
    userId: LOCAL_USER_ID,
    code: 'goal_fat_loss_specialize_downgrade',
    issuedAt: '2026-09-13T00:00:00.000Z',
    inputs: { ref: 'chest', dietPhase: 'fat-loss' },
    thresholds: { fatLossSpecializeCap: 0 },
    algorithmVersion: 'goal-guardrails@1.0.0',
    verdict: 'downgrade_to_maintain',
    ...overrides,
  };
}

describe('advisory decisions', () => {
  it('round-trips the inputs and thresholds it fired on', async () => {
    const store = openTestStore();
    const written = await store.putAdvisoryDecision(decision());
    expect(written.inputs).toEqual({ ref: 'chest', dietPhase: 'fat-loss' });
    expect(written.thresholds).toEqual({ fatLossSpecializeCap: 0 });
    expect(written.userResponse).toBeUndefined();
    expect(await store.listAdvisoryDecisions(LOCAL_USER_ID)).toEqual([written]);
  });

  it('records an answer on the row that fired, not beside it', async () => {
    const store = openTestStore();
    const issued = await store.putAdvisoryDecision(decision());
    const answered = await store.putAdvisoryDecision({
      ...decision({ id: issued.id }),
      userResponse: 'declined',
      respondedAt: '2026-09-13T01:00:00.000Z',
    });
    expect(answered.id).toBe(issued.id);
    expect(answered.userResponse).toBe('declined');
    expect(await store.listAdvisoryDecisions(LOCAL_USER_ID)).toHaveLength(1);
  });

  it('narrows by code and by response', async () => {
    const store = openTestStore();
    await store.putAdvisoryDecision(decision({ userResponse: 'declined' }));
    await store.putAdvisoryDecision(decision({ userResponse: 'accepted' }));
    await store.putAdvisoryDecision(decision({ code: 'other_advisory' }));
    expect(
      await store.listAdvisoryDecisions(LOCAL_USER_ID, {
        code: 'goal_fat_loss_specialize_downgrade',
        userResponse: 'declined',
      }),
    ).toHaveLength(1);
    expect(
      await store.listAdvisoryDecisions(LOCAL_USER_ID, { code: 'other_advisory' }),
    ).toHaveLength(1);
  });

  it('keeps one user’s advisories out of another’s', async () => {
    const store = openTestStore();
    await store.putAdvisoryDecision(decision());
    expect(await store.listAdvisoryDecisions('someone-else')).toEqual([]);
  });
});
