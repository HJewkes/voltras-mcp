// The copy rules of `sources/notes/2026-09-12-accountability-system-plan.md` §2,
// asserted mechanically over what the composer renders (VW-287). These test the
// rules, not the prose: `assertCopyRules` is the shared lint pass, and a
// template rewrite that still obeys the rules keeps passing.

import { describe, expect, it } from 'vitest';

import { COMMITMENT_LANGUAGE_PLACEHOLDER, NON_JUDGMENT_LINE } from '../copy.js';
import {
  composeGhostNudge,
  composeMissRecovery,
  composeRealignOpener,
  composeSundayAnchor,
  type MissRecoveryInput,
  type NextWorkoutRead,
  type PlannedSlot,
  type RealignOpenerInput,
  type SundayAnchorInput,
} from '../composer.js';
import { assertCopyRules } from './copy-rules.js';

const WEEKDAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;

/** The profile in the plan: 4 reliable days, Mon/Tue/Thu/Fri, each with a named fallback. */
const SLOTS: PlannedSlot[] = [
  { day: 'Monday', fallbackDay: 'Wednesday' },
  { day: 'Tuesday', fallbackDay: 'Wednesday' },
  { day: 'Thursday', fallbackDay: 'Saturday' },
  { day: 'Friday', fallbackDay: 'Saturday' },
];

const NEXT_WORKOUT: NextWorkoutRead = {
  templateName: 'Upper A',
  exercises: [
    { name: 'cable row', targetWeightLbs: 170 },
    { name: 'overhead press' },
    { name: 'face pull' },
  ],
};

const SUNDAY_INPUT: SundayAnchorInput = {
  lifterName: 'Harrison',
  adherence: { planned: 4, done: 3, trend: 'steady' },
  rolling28DayCompletedSessions: 13,
  nextWorkout: NEXT_WORKOUT,
  slots: SLOTS,
  ifThenPlan: 'if work runs past 18:00 on Monday, then Monday moves to Wednesday',
  monthlyCommitmentReoffer: false,
};

const MISS_INPUT: MissRecoveryInput = {
  lifterName: 'Harrison',
  missed: {
    plannedDay: 'Monday',
    fallbackDay: 'Wednesday',
    exerciseNames: ['cable row', 'overhead press', 'face pull'],
  },
  nextWorkout: NEXT_WORKOUT,
  reEntryDay: 'Thursday',
  holding: { active: false },
};

const REALIGN_INPUT: RealignOpenerInput = {
  lifterName: 'Harrison',
  adherence: { planned: 4, done: 1, trend: 'declining' },
  rolling28DayCompletedSessions: 6,
  slots: SLOTS,
};

function everyMessage(): { label: string; text: string }[] {
  return [
    { label: 'sunday anchor', text: composeSundayAnchor(SUNDAY_INPUT).text },
    {
      label: 'sunday anchor with the monthly commitment re-offer',
      text: composeSundayAnchor({ ...SUNDAY_INPUT, monthlyCommitmentReoffer: true }).text,
    },
    { label: 'miss recovery', text: composeMissRecovery(MISS_INPUT).text },
    {
      label: 'holding acknowledgement',
      text: composeMissRecovery({
        ...MISS_INPUT,
        holding: { active: true, endDate: 'Sunday 20 September' },
      }).text,
    },
    {
      label: 'ghost nudge 1',
      text: composeGhostNudge(1, { lifterName: 'Harrison', nextWorkout: NEXT_WORKOUT }).text,
    },
    {
      label: 'ghost nudge 2',
      text: composeGhostNudge(2, { lifterName: 'Harrison', nextWorkout: NEXT_WORKOUT }).text,
    },
    { label: 'realign opener', text: composeRealignOpener(REALIGN_INPUT).text },
  ];
}

describe('the §2 copy rules, over every template', () => {
  for (const { label, text } of everyMessage()) {
    it(`${label} obeys every mechanical copy rule`, () => {
      expect(() => assertCopyRules(text)).not.toThrow();
    });
  }

  it('catches a running total added to a passing message (rule 2)', () => {
    const mutated = `${composeMissRecovery(MISS_INPUT).text}\nThat is the third one this month.`;
    expect(() => assertCopyRules(mutated)).toThrow(/rule 2/);
  });

  it('catches streak language added to a passing message (rule 5)', () => {
    const mutated = `${composeSundayAnchor(SUNDAY_INPUT).text}\nThree sessions in a row.`;
    expect(() => assertCopyRules(mutated)).toThrow(/rule 5/);
  });

  it('catches the operational-honesty line placed before the non-judgment line (rule 3)', () => {
    const text = composeMissRecovery(MISS_INPUT).text;
    const reordered = text
      .split('\n')
      .filter((line) => line !== NON_JUDGMENT_LINE)
      .concat(NON_JUDGMENT_LINE)
      .join('\n');
    expect(() => assertCopyRules(reordered)).toThrow(/rule 3/);
  });

  it('catches a negative observation with no dated next action (rule 1)', () => {
    const orphaned = [
      'Harrison, the Monday session is not in the records.',
      NON_JUDGMENT_LINE,
      'The plan stays as written.',
    ].join('\n');
    expect(() => assertCopyRules(orphaned)).toThrow(/rule 1/);
  });

  it('catches a prescription with no rationale clause (rule 6)', () => {
    const mutated = `${composeGhostNudge(1, { lifterName: 'Harrison', nextWorkout: NEXT_WORKOUT }).text}\nKeep the row at 170 lb.`;
    expect(() => assertCopyRules(mutated)).toThrow(/rule 6/);
  });

  it('catches a frequency offer framed as quitting or as fewer days (rule 4)', () => {
    const mutated = `${composeRealignOpener(REALIGN_INPUT).text}\nWe can settle for fewer days.`;
    expect(() => assertCopyRules(mutated)).toThrow(/rule 4/);
  });
});

describe('composeSundayAnchor', () => {
  it("shows last week's numbers back instead of asking how it went", () => {
    const { text } = composeSundayAnchor(SUNDAY_INPUT);
    expect(text).toContain('Planned 4, recorded 3');
    expect(text).not.toMatch(/how (did|does|was|is|are)[^.!?]*\?/i);
  });

  it('states that silence through the week means the plan is on track', () => {
    const { text } = composeSundayAnchor(SUNDAY_INPUT);
    expect(text).toMatch(/silence through the week means the plan is on track/i);
  });

  it('reports progress as a rolling 28-day count, not a streak (rule 7)', () => {
    const { text } = composeSundayAnchor(SUNDAY_INPUT);
    expect(text).toContain('Rolling 28-day session count: 13');
  });

  it('names every slot with its fallback day and says a fallback counts', () => {
    const { text } = composeSundayAnchor(SUNDAY_INPUT);
    for (const slot of SLOTS) {
      expect(text).toContain(`${slot.day} (fallback ${slot.fallbackDay})`);
    }
    expect(text).toMatch(/fallback day counts as recorded/i);
  });

  it('renders the COMMITMENT_LANGUAGE placeholder until the Sunday sitting supplies wording', () => {
    const { text } = composeSundayAnchor({ ...SUNDAY_INPUT, monthlyCommitmentReoffer: true });
    expect(text).toContain(COMMITMENT_LANGUAGE_PLACEHOLDER);
    assertCopyRules(text);
  });

  it("uses the lifter's own commitment wording once it exists", () => {
    const { text } = composeSundayAnchor({
      ...SUNDAY_INPUT,
      monthlyCommitmentReoffer: true,
      commitmentLanguage: 'sixteen sessions a month, my number',
    });
    expect(text).toContain('sixteen sessions a month, my number');
    expect(text).not.toContain(COMMITMENT_LANGUAGE_PLACEHOLDER);
  });

  it('omits the commitment re-offer on a non-landmark Sunday', () => {
    const { text } = composeSundayAnchor(SUNDAY_INPUT);
    expect(text).not.toContain('Month marker');
  });

  it('says plainly that nothing was scheduled rather than reporting a false zero', () => {
    const { text } = composeSundayAnchor({ ...SUNDAY_INPUT, adherence: null });
    expect(text).toMatch(/nothing was on the calendar last week/i);
    assertCopyRules(text);
  });
});

describe('composeMissRecovery', () => {
  it('names the miss with the planned day and its fallback, and evaluates neither', () => {
    const { text } = composeMissRecovery(MISS_INPUT);
    expect(text).toMatch(/the Monday session .* is not in the records/);
    expect(text).toContain('named fallback on Wednesday has passed');
    assertCopyRules(text);
  });

  it('offers exactly one reduced-scope re-entry, on a named day, sourced from next_workout', () => {
    const { text } = composeMissRecovery(MISS_INPUT);
    const offers = text
      .split('\n')
      .filter((line) => /\b\d+ minutes\b/.test(line) && WEEKDAY.test(line));
    expect(offers).toHaveLength(1);
    expect(offers[0]).toContain('Thursday');
    expect(offers[0]).toContain('20 minutes');
    expect(offers[0]).toContain('cable row');
    expect(offers[0]).toContain('170 lb');
  });

  it('puts the non-judgment line ahead of the operational-honesty line', () => {
    const { text } = composeMissRecovery(MISS_INPUT);
    expect(text.indexOf('No judgment in this')).toBeLessThan(
      text.indexOf('is operational, not moral'),
    );
  });

  it('renders different copy for the same missed session while a hold is running', () => {
    const missed = composeMissRecovery(MISS_INPUT);
    const holding = composeMissRecovery({
      ...MISS_INPUT,
      holding: { active: true, endDate: 'Sunday 20 September' },
    });
    expect(holding.text).not.toBe(missed.text);
    expect(holding.kind).toBe('holding_acknowledgement');
    expect(missed.kind).toBe('miss_recovery');
    expect(holding.text).toMatch(/the empty Monday slot is what the plan expects/i);
    expect(holding.text).toContain('through Sunday 20 September');
    expect(holding.text).not.toMatch(/not in the records/i);
    expect(holding.text).not.toContain('No judgment in this');
    assertCopyRules(holding.text);
  });

  it('refuses to compose an offer when the next workout has no exercises', () => {
    expect(() =>
      composeMissRecovery({
        ...MISS_INPUT,
        nextWorkout: { templateName: 'Upper A', exercises: [] },
      }),
    ).toThrow(/no exercises/);
  });
});

describe('composeGhostNudge', () => {
  const first = composeGhostNudge(1, { lifterName: 'Harrison', nextWorkout: NEXT_WORKOUT });
  const second = composeGhostNudge(2, { lifterName: 'Harrison', nextWorkout: NEXT_WORKOUT });

  it('renders two distinct nudges', () => {
    expect(first.kind).toBe('ghost_nudge_1');
    expect(second.kind).toBe('ghost_nudge_2');
    expect(second.text).not.toBe(first.text);
  });

  it('keeps nudge 2 standalone: it never refers to nudge 1', () => {
    expect(second.text).not.toMatch(
      /following up|circling back|checking in|my last|as I said|reminder|second message/i,
    );
    assertCopyRules(second.text);
  });

  it('never asks whether the lifter is alive', () => {
    for (const { text } of [first, second]) {
      expect(text).not.toMatch(/are you (alive|there|ok)/i);
    }
  });

  it('escalates neither urgency nor demand: both name the next session and ask for a day', () => {
    for (const { text } of [first, second]) {
      expect(text).toContain('Upper A');
      expect(text).toMatch(/\ba day\b/);
    }
  });

  it('states what is queued even when the program has run out', () => {
    const { text } = composeGhostNudge(1, { lifterName: 'Harrison', nextWorkout: null });
    expect(text).toMatch(/nothing is queued on the plan/i);
    assertCopyRules(text);
  });
});

describe('composeRealignOpener', () => {
  it('frames a frequency change as re-architecting within the same number of days', () => {
    const { text } = composeRealignOpener(REALIGN_INPUT);
    expect(text).toMatch(/re-architecting to your real schedule/i);
    expect(text).toMatch(/within four days/i);
    expect(text).not.toMatch(/fewer days|quit|give up/i);
  });

  it('reports the deviation trend as a direction, never as a count of deviations', () => {
    const { text } = composeRealignOpener(REALIGN_INPUT);
    expect(text).toContain('Deviation trend: worsening');
    expect(text).not.toMatch(/\b\d+ deviations?\b/);
  });

  it('pairs the trend with a concrete ask about which slot to move', () => {
    const { text } = composeRealignOpener(REALIGN_INPUT);
    expect(text).toMatch(/Tell me which of .* is the slot that keeps breaking/);
    expect(text).toMatch(/because/);
  });
});
