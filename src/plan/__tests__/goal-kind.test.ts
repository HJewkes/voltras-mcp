// The default-goal-kind rule (VW-448 amendment s.2 / VW-517). One function, four outcomes,
// and an order that matters: the same numbers must read the same way whether the caller is
// a plan tool, the dashboard, the TrueCoach import or the v38 backfill.

import { describe, expect, it } from 'vitest';

import { defaultGoalKind, isRestInvalid, validatePrescription } from '../goal-kind.js';

describe('defaultGoalKind', () => {
  it('reads a loss target as the goal', () => {
    expect(defaultGoalKind({ targetVelocityLossPct: 20 })).toBe('velocity_loss');
  });

  it('lets a loss target outrank both a rep range and an RPE on the same row', () => {
    expect(defaultGoalKind({ targetVelocityLossPct: 20, targetRepsLow: 8, targetRpe: 9 })).toBe(
      'velocity_loss',
    );
  });

  it('reads a rep range as the goal', () => {
    expect(defaultGoalKind({ targetRepsLow: 8 })).toBe('rep_range');
  });

  // The owner's ruling: "rep range, RPE as the cap". Not a target_rpe row.
  it('keeps a rep range as the goal when the row also carries an RPE', () => {
    expect(defaultGoalKind({ targetRepsLow: 8, targetRpe: 9 })).toBe('rep_range');
  });

  it('reads a lone RPE as the goal', () => {
    expect(defaultGoalKind({ targetRpe: 8 })).toBe('target_rpe');
  });

  // Null is a stated answer, not a placeholder for one.
  it('states no goal for a row carrying none of the three', () => {
    expect(defaultGoalKind({})).toBeNull();
  });

  it('treats an explicitly undefined field as absent', () => {
    expect(
      defaultGoalKind({ targetVelocityLossPct: undefined, targetRepsLow: undefined }),
    ).toBeNull();
  });

  // A zero RPE and a one-rep range are real prescriptions, not missing ones.
  it('does not read a falsy number as an absent field', () => {
    expect(defaultGoalKind({ targetRpe: 0 })).toBe('target_rpe');
    expect(defaultGoalKind({ targetRepsLow: 0 })).toBe('rep_range');
  });
});

// The one shape check the three write paths share (VW-537). Each refusal names its way out.
describe('validatePrescription', () => {
  it('accepts a rep range with an RPE as its cap', () => {
    expect(
      validatePrescription({ goalKind: 'rep_range', targetRepsLow: 8, targetRpe: 9 }),
    ).toBeNull();
  });

  it('accepts a row that states no goal', () => {
    expect(validatePrescription({})).toBeNull();
  });

  it.each([
    ['rep_range', { targetRpe: 8 }, 'Give a rep range, or choose another goalKind.'],
    ['target_rpe', { targetRepsLow: 8 }, 'Give an RPE, or choose another goalKind.'],
    ['velocity_loss', { targetRepsLow: 8 }, 'or give a trainingIntent'],
  ] as const)('refuses a %s goal without its required field', (goalKind, fields, wayOut) => {
    expect(validatePrescription({ goalKind, ...fields })).toContain(wayOut);
  });

  it('accepts a velocity_loss goal whose percent comes from the training intent', () => {
    expect(validatePrescription({ goalKind: 'velocity_loss', trainingIntent: 'power' })).toBeNull();
  });

  it('accepts a velocity_loss goal with a typed percent', () => {
    expect(
      validatePrescription({ goalKind: 'velocity_loss', targetVelocityLossPct: 20 }),
    ).toBeNull();
  });

  it('refuses a rep range whose high bound is below its low bound', () => {
    expect(
      validatePrescription({ goalKind: 'rep_range', targetRepsLow: 10, targetRepsHigh: 8 }),
    ).toBe('targetRepsHigh (8) must be at least targetRepsLow (10).');
  });

  it('refuses a loss percent under any other goal kind', () => {
    expect(
      validatePrescription({ goalKind: 'rep_range', targetRepsLow: 8, targetVelocityLossPct: 20 }),
    ).toContain('Set that goalKind, or leave the percent out.');
    expect(validatePrescription({ targetVelocityLossPct: 20 })).not.toBeNull();
  });

  it('refuses learning off with no rest, naming both ways out', () => {
    expect(validatePrescription({ restLearning: false })).toBe(
      'Rest learning is off, so the row needs a fixed rest. Give restSec, or turn restLearning on.',
    );
  });

  it('accepts every other rest pair', () => {
    expect(validatePrescription({ restLearning: false, restSec: 90 })).toBeNull();
    expect(validatePrescription({ restLearning: true })).toBeNull();
    expect(validatePrescription({ restSec: 90 })).toBeNull();
    expect(validatePrescription({ restLearning: false, restSec: 0 })).toBeNull();
  });
});

describe('validatePrescription on an edit', () => {
  const brokenBoth = { goalKind: 'target_rpe', restLearning: false } as const;

  it('checks only the groups it is given', () => {
    expect(validatePrescription(brokenBoth, [])).toBeNull();
    expect(validatePrescription(brokenBoth, ['rest'])).toContain('Give restSec');
    expect(validatePrescription(brokenBoth, ['goal'])).toContain('Give an RPE');
  });

  it('checks both groups when none are named', () => {
    expect(validatePrescription({ restLearning: false })).not.toBeNull();
    expect(validatePrescription({ goalKind: 'target_rpe' })).not.toBeNull();
  });
});

describe('isRestInvalid', () => {
  it('marks only learning off with no rest', () => {
    expect(isRestInvalid({ restLearning: false })).toBe(true);
    expect(isRestInvalid({ restLearning: false, restSec: 60 })).toBe(false);
    expect(isRestInvalid({ restLearning: true })).toBe(false);
    expect(isRestInvalid({})).toBe(false);
  });
});
