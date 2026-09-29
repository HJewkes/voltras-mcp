import { describe, expect, it } from 'vitest';

import type { Tier } from '../../../tools/tier-signal.js';
import {
  admit,
  createLedger,
  defaultIntraSetPermit,
  type BudgetRequest,
  type CueLedger,
  type CueLine,
} from '../budget.js';
import { TIER_DENSITY, UNRESOLVED_TIER } from '../density.js';
import type { Interval } from '../interval.js';

const focus = (focusId: string): CueLine => ({ kind: 'focus', focusId });
const announcement = (category: string): CueLine => ({ kind: 'announcement', category });

function request(
  overrides: Partial<BudgetRequest> & { interval: Interval; line: CueLine },
): BudgetRequest {
  return {
    slot: 'primary',
    setId: 'set-1',
    tier: 'beginner',
    settings: { enabled: true, midSetEnabled: true },
    intraSetPermit: defaultIntraSetPermit,
    ...overrides,
  };
}

function statePreSetFocus(
  ledger: CueLedger,
  focusId: string,
  slot = 'primary',
  tier: Tier = 'beginner',
): void {
  admit(ledger, request({ slot, tier, interval: 'pre', line: focus(focusId) }));
}

function admittedCount(ledger: CueLedger, lines: BudgetRequest[]): number {
  return lines.filter((line) => admit(ledger, line).admit).length;
}

describe('cue budget', () => {
  it.each<Interval>(['pre', 'intra', 'post'])(
    'never admits a third line in the %s interval',
    (interval) => {
      const ledger = createLedger();
      statePreSetFocus(ledger, 'full_range');
      const line = interval === 'pre' ? announcement('set_intro') : focus('full_range');

      admit(ledger, request({ interval, line }));
      if (interval !== 'pre') admit(ledger, request({ interval, line }));
      const third = admit(ledger, request({ interval, line }));

      expect(third).toEqual({ admit: false, reason: 'interval_cap' });
    },
  );

  it.each<[Tier, number]>([
    ['beginner', 2],
    ['intermediate', 1],
    ['advanced', 0],
  ])('admits %s lifters %i intra-set lines', (tier, expected) => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range', 'primary', tier);
    const intra = request({ tier, interval: 'intra', line: focus('full_range') });

    const admitted = admittedCount(ledger, [intra, intra, intra]);

    expect(admitted).toBe(expected);
  });

  it('refuses the line past the tier allowance with the tier_density reason', () => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range', 'primary', 'advanced');

    const decision = admit(
      ledger,
      request({ tier: 'advanced', interval: 'intra', line: focus('full_range') }),
    );

    expect(decision).toEqual({ admit: false, reason: 'tier_density' });
  });

  it('applies the strictest density while the tier is unresolved', () => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range');

    const decision = admit(
      ledger,
      request({ tier: null, interval: 'intra', line: focus('full_range') }),
    );

    expect(UNRESOLVED_TIER).toBe('advanced');
    expect(decision).toEqual({ admit: false, reason: 'tier_density' });
  });

  it('refuses an intra-set focus other than the one stated pre-set', () => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range');

    const decision = admit(ledger, request({ interval: 'intra', line: focus('smooth_drive') }));

    expect(decision).toEqual({ admit: false, reason: 'new_focus_intra' });
  });

  it('refuses an intra-set focus when no focus was stated pre-set', () => {
    const ledger = createLedger();

    const decision = admit(ledger, request({ interval: 'intra', line: focus('full_range') }));

    expect(decision).toEqual({ admit: false, reason: 'new_focus_intra' });
  });

  it('admits an intra-set announcement without a pre-set focus', () => {
    const ledger = createLedger();

    const decision = admit(ledger, request({ interval: 'intra', line: announcement('slowdown') }));

    expect(decision).toEqual({ admit: true, reason: 'within_budget' });
  });

  it('admits nothing intra-set when mid-set cues are off, even if the permit allows it', () => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range');

    const decision = admit(
      ledger,
      request({
        interval: 'intra',
        line: focus('full_range'),
        settings: { enabled: true, midSetEnabled: false },
        intraSetPermit: () => true,
      }),
    );

    expect(decision).toEqual({ admit: false, reason: 'midset_disabled' });
  });

  it('admits nothing intra-set when the injected permit refuses', () => {
    const ledger = createLedger();
    statePreSetFocus(ledger, 'full_range');

    const decision = admit(
      ledger,
      request({ interval: 'intra', line: announcement('target_hit'), intraSetPermit: () => false }),
    );

    expect(decision).toEqual({ admit: false, reason: 'intra_permit_denied' });
  });

  it('keeps separate budgets for two slots in the same ledger', () => {
    const ledger = createLedger();
    const left = request({
      slot: 'left',
      setId: 'set-L',
      interval: 'post',
      line: focus('full_range'),
    });
    const right = request({
      slot: 'right',
      setId: 'set-R',
      interval: 'post',
      line: focus('full_range'),
    });

    const leftAdmitted = admittedCount(ledger, [left, left, left]);
    const rightAdmitted = admittedCount(ledger, [right, right]);

    expect(leftAdmitted).toBe(2);
    expect(rightAdmitted).toBe(2);
  });

  it('gives the next set a fresh budget instead of carrying refusals forward', () => {
    const ledger = createLedger();
    const setOne = request({ interval: 'post', line: focus('full_range') });
    admittedCount(ledger, [setOne, setOne, setOne]);

    const decision = admit(ledger, { ...setOne, setId: 'set-2' });

    expect(decision.admit).toBe(true);
  });

  it('records every admit and refusal on the ledger with a typed reason', () => {
    const ledger = createLedger();
    const post = request({ interval: 'post', line: focus('full_range') });

    admittedCount(ledger, [post, post, post]);

    expect(ledger.entries.map((entry) => entry.decision)).toEqual([
      { admit: true, reason: 'within_budget' },
      { admit: true, reason: 'within_budget' },
      { admit: false, reason: 'interval_cap' },
    ]);
  });

  it('holds the plan tier table as a frozen constant', () => {
    expect(Object.isFrozen(TIER_DENSITY)).toBe(true);
    expect(Object.isFrozen(TIER_DENSITY.beginner)).toBe(true);
    expect(TIER_DENSITY).toEqual({
      beginner: { pre: 2, intra: 2, post: 2 },
      intermediate: { pre: 2, intra: 1, post: 2 },
      advanced: { pre: 2, intra: 0, post: 2 },
    });
  });
});
