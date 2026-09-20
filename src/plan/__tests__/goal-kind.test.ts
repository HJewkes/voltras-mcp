// The default-goal-kind rule (VW-448 amendment s.2 / VW-517). One function, four outcomes,
// and an order that matters: the same numbers must read the same way whether the caller is
// a plan tool, the dashboard, the TrueCoach import or the v38 backfill.

import { describe, expect, it } from 'vitest';

import { defaultGoalKind } from '../goal-kind.js';

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
