// VW-266: the velocity-loss threshold resolver.
//
// The precedence order is the whole behaviour, so each rung is pinned against
// a case where the rung below it would have produced a DIFFERENT number — a
// test where two rungs agree proves nothing about which one was read.

import { describe, expect, it } from 'vitest';

import {
  resolveVelocityLossSpec,
  VELOCITY_LOSS_DEFAULT_PCT,
  VELOCITY_LOSS_RANGE_PCT,
} from '../velocity-loss-intent.js';

const VL = { type: 'velocity_loss_exceeded' } as const;

describe('resolveVelocityLossSpec', () => {
  it('takes an explicit pct unchanged and marks it as such', () => {
    expect(resolveVelocityLossSpec({ ...VL, pct: 25 }, undefined)).toEqual({
      type: 'velocity_loss_exceeded',
      pct: 25,
      thresholdSource: 'explicit',
    });
  });

  it('a strength intent resolves to 20, the top of the 10-20% band', () => {
    expect(resolveVelocityLossSpec({ ...VL, intent: 'strength' }, undefined)).toEqual({
      type: 'velocity_loss_exceeded',
      pct: 20,
      intent: 'strength',
      thresholdSource: 'set_intent',
    });
  });

  it('a hypertrophy intent resolves to 30, inside the 25-40% band', () => {
    expect(resolveVelocityLossSpec({ ...VL, intent: 'hypertrophy' }, undefined)).toMatchObject({
      pct: 30,
      intent: 'hypertrophy',
      thresholdSource: 'set_intent',
    });
  });

  it('a power intent resolves to 10', () => {
    expect(resolveVelocityLossSpec({ ...VL, intent: 'power' }, undefined)).toMatchObject({
      pct: 10,
      intent: 'power',
      thresholdSource: 'set_intent',
    });
  });

  it('falls back to the plan when the spec states neither', () => {
    expect(resolveVelocityLossSpec(VL, 'hypertrophy')).toEqual({
      type: 'velocity_loss_exceeded',
      pct: 30,
      intent: 'hypertrophy',
      thresholdSource: 'plan_intent',
    });
  });

  // The two precedence cases that matter: each names an intent whose default
  // differs from the value the higher rung supplies, so the assertion can only
  // pass if the higher rung won.
  it("an explicit pct wins over an intent — the plan's number is what says otherwise", () => {
    const resolved = resolveVelocityLossSpec({ ...VL, pct: 15, intent: 'hypertrophy' }, 'power');
    expect(resolved).toMatchObject({ pct: 15, intent: 'hypertrophy', thresholdSource: 'explicit' });
  });

  it('a set intent wins over the plan intent', () => {
    const resolved = resolveVelocityLossSpec({ ...VL, intent: 'power' }, 'hypertrophy');
    expect(resolved).toMatchObject({ pct: 10, intent: 'power', thresholdSource: 'set_intent' });
  });

  it('resolves to nothing when no rung supplies a number', () => {
    expect(resolveVelocityLossSpec(VL, undefined)).toBeUndefined();
  });

  it('every default sits inside its own published band', () => {
    for (const [intent, pct] of Object.entries(VELOCITY_LOSS_DEFAULT_PCT)) {
      const [low, high] = VELOCITY_LOSS_RANGE_PCT[intent as keyof typeof VELOCITY_LOSS_RANGE_PCT];
      expect(pct).toBeGreaterThanOrEqual(low);
      expect(pct).toBeLessThanOrEqual(high);
    }
  });
});
