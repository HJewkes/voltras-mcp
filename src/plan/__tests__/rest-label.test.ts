import { describe, expect, it } from 'vitest';
import { isRestTemplate } from '../lint-plan.js';
import { hasOffWord, hasRestWord, isOffOnly } from '../rest-label.js';
import type { WeekShape } from '../../tools/plan-brief-cadence.js';
import { isFinalBeforeActiveRest } from '../../tools/plan-brief-specialization.js';

const train: WeekShape = { isDeload: false, templates: 3 };
const deloadBlock: WeekShape[] = [train, train, { isDeload: true, templates: 3 }];
const OFF_LABELS = ['Rest', 'Active rest', 'Day off', 'Off', 'Off day', 'Rest day'];
const TRAINING_LABELS = [
  'Rest/pause',
  'Rest-pause',
  'Rest–pause',
  'Rest—pause',
  'Rest, pause sets',
  'Rest pause',
  'Off-season',
  'Off season',
  'Back-off',
  'Back off',
  'Backoff',
];

describe('shared rest/off label matcher', () => {
  it.each(OFF_LABELS)('reads %s as off for the lint rule', (label) => {
    expect(isRestTemplate({ name: label })).toBe(true);
  });

  it.each(TRAINING_LABELS)('reads %s as training for the lint rule', (label) => {
    expect(isRestTemplate({ name: label })).toBe(false);
  });

  it.each(OFF_LABELS)('reads %s as a marker in the week rule', (label) => {
    expect(hasRestWord(label) || hasOffWord(label)).toBe(true);
  });

  it.each(TRAINING_LABELS)('does not read %s as a marker in the week rule', (label) => {
    expect(hasRestWord(label) || hasOffWord(label)).toBe(false);
  });

  it.each(OFF_LABELS.concat('off'))(
    'takes a week named %s as the week off in the brief',
    (name) => {
      const next: WeekShape = { isDeload: false, templates: 3, name };
      expect(isFinalBeforeActiveRest(deloadBlock, [next])).toBe(true);
    },
  );

  it.each(TRAINING_LABELS)('does not take a week named %s as the week off in the brief', (name) => {
    const next: WeekShape = { isDeload: false, templates: 3, name };
    expect(isFinalBeforeActiveRest(deloadBlock, [next])).toBe(false);
  });

  it('keeps the exact-match rule narrower than the word rule', () => {
    expect(isOffOnly(' Off day ')).toBe(true);
    expect(isOffOnly('Week off')).toBe(false);
    expect(hasOffWord('Week off')).toBe(true);
  });
});
