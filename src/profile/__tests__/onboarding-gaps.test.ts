// Unit tests for src/profile/onboarding-gaps.ts (VW-148).
//
// The point of this file is the two quotation guards. `onboarding-gaps.ts`
// hands the agent clinical and coaching prose it did not write, and the whole
// safety argument for the cardiovascular gate is that the words are RP's own.
// A quote that silently drifts away from the corpus breaks that argument
// without breaking anything a behavioural test would notice.

import { describe, expect, it } from 'vitest';
import { COACHING_CONTENT } from '../../tools/coaching-content.js';
import type { StoredTrainingProfile } from '../../store/types.js';
import {
  LAST_BREAK_QUESTION,
  MEDICAL_CLEARANCE_SENTENCE,
  onboardingGaps,
} from '../onboarding-gaps.js';

const BASE: StoredTrainingProfile = { userId: 'local', updatedAt: '2026-09-08T00:00:00.000Z' };
const HISTORY_MET = { loggedHistoryMet: true };
const HISTORY_SHORT = { loggedHistoryMet: false };

describe('the prose it returns is quoted, not written', () => {
  it('quotes the cardiovascular gate verbatim from onboarding.injury_intake', () => {
    expect(COACHING_CONTENT['onboarding.injury_intake'].allTiers).toContain(
      MEDICAL_CLEARANCE_SENTENCE,
    );
  });

  it('quotes the goal-realism note verbatim from onboarding.goal_commitment_alignment', () => {
    const gaps = onboardingGaps({ ...BASE, goal: 'add arm size' }, HISTORY_MET);

    expect(gaps.goalRealism?.note).toBe(
      COACHING_CONTENT['onboarding.goal_commitment_alignment'].allTiers,
    );
  });
});

describe('onboardingGaps', () => {
  it('reports every field as missing for a lifter with no profile row at all', () => {
    const gaps = onboardingGaps(undefined, HISTORY_MET);

    expect(gaps.missing[0]).toBe('goal');
    expect(gaps.missing.at(-1)).toBe('injuries');
    expect(gaps.medicalClearanceRequired).toBe(false);
    expect(gaps.goalRealism).toBeNull();
  });

  it('gates on any cardio-flagged injury, not just the first', () => {
    const gaps = onboardingGaps(
      {
        ...BASE,
        injuries: [
          { area: 'right elbow', kind: 'sharp_in_set' },
          { area: 'heart', kind: 'other', cardioLimitation: true },
        ],
      },
      HISTORY_MET,
    );

    expect(gaps.medicalClearanceRequired).toBe(true);
    expect(gaps.medicalClearanceNote).toBe(MEDICAL_CLEARANCE_SENTENCE);
  });

  it('treats cardioLimitation: false as no gate', () => {
    const gaps = onboardingGaps(
      {
        ...BASE,
        injuries: [{ area: 'shoulder', kind: 'lingering_joint', cardioLimitation: false }],
      },
      HISTORY_MET,
    );

    expect(gaps.medicalClearanceRequired).toBe(false);
  });

  it('returns goal realism from a target alone, with a null goal', () => {
    const gaps = onboardingGaps({ ...BASE, target: 'a bodyweight pull-up by March' }, HISTORY_MET);

    expect(gaps.goalRealism?.goal).toBeNull();
    expect(gaps.goalRealism?.target).toBe('a bodyweight pull-up by March');
  });

  it('never reports a field the lifter answered', () => {
    const gaps = onboardingGaps(
      {
        ...BASE,
        goal: 'hypertrophy',
        daysAvailable: 5,
        daysReliable: 3,
        currentBaseline: 'three sessions a week for a year',
        effortTolerance: 'high',
        target: 'visibly bigger arms',
        declaredTier: 'intermediate',
        yearsTraining: 4,
        historyConsistent: true,
        everPlateaued: true,
        reportedSetsPerMuscle: 10,
        namedProgramHistory: '5/3/1',
        injuries: [],
      },
      HISTORY_MET,
    );

    expect(gaps.missing).toEqual([]);
  });
});

describe('the last-break question (VW-462)', () => {
  it('asks it of a declared intermediate whose logged history is still short', () => {
    const gaps = onboardingGaps({ ...BASE, declaredTier: 'intermediate' }, HISTORY_SHORT);

    expect(gaps.missing).toContain('lastBreakMonths');
    expect(gaps.lastBreakQuestion).toBe(LAST_BREAK_QUESTION);
  });

  it.each([
    ['a declared beginner', { ...BASE, declaredTier: 'beginner' }, HISTORY_SHORT],
    ['a lifter with no declared tier', BASE, HISTORY_SHORT],
    [
      'a declared intermediate whose history already vouches',
      { ...BASE, declaredTier: 'intermediate' },
      HISTORY_MET,
    ],
    [
      'a lifter who already answered',
      { ...BASE, declaredTier: 'advanced', lastBreakMonths: 0 },
      HISTORY_SHORT,
    ],
  ])('does not ask %s', (_name, profile, context) => {
    const gaps = onboardingGaps(profile, context);

    expect(gaps.missing).not.toContain('lastBreakMonths');
    expect(gaps.lastBreakQuestion).toBeNull();
  });
});
