// `learned_rest.context` carries no enumerated CHECK (OWNER, VW-525), so this predicate is
// the whole guard. Pinned here because the cost of it being wrong is a row the schema
// happily stores and no later reader can interpret.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEARNED_REST_CONTEXT,
  isLearnedRestContext,
  LEARNED_REST_CONTEXTS,
} from '../learned-rest-context.js';

describe('isLearnedRestContext', () => {
  it('admits every word the vocabulary names', () => {
    expect(LEARNED_REST_CONTEXTS.every(isLearnedRestContext)).toBe(true);
  });

  // A resistance family is exactly what this column is being kept open for, and exactly
  // what it must not accept before the build knows the word.
  it('refuses a word this build does not know', () => {
    expect(isLearnedRestContext('banded')).toBe(false);
    expect(isLearnedRestContext('')).toBe(false);
    expect(isLearnedRestContext('Straight')).toBe(false);
  });

  it('defaults to the context version 1 can actually produce', () => {
    expect(DEFAULT_LEARNED_REST_CONTEXT).toBe('straight');
    expect(isLearnedRestContext(DEFAULT_LEARNED_REST_CONTEXT)).toBe(true);
  });
});
