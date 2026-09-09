// Unit tests for the session-title read-model (VW-43).
//
// Pure shaping only — no store, no HTTP. Table test over the four input shapes
// `fetchSessionPlan` can hand it: template alone, template + block, template +
// focus, and neither (no template to title from).

import { describe, expect, it } from 'vitest';

import { composeSessionTitle } from '../read-models/session-title.js';

describe('composeSessionTitle', () => {
  it('titles from the template name alone when neither block nor focus resolves', () => {
    expect(composeSessionTitle({ templateName: 'Push A' })).toBe('Push A');
  });

  it('joins the template name and block name when no focus is set', () => {
    expect(composeSessionTitle({ templateName: 'Push A', blockName: 'Hypertrophy Block 1' })).toBe(
      'Push A · Hypertrophy Block 1',
    );
  });

  it('prefers the capitalized focus over the block name', () => {
    expect(
      composeSessionTitle({
        templateName: 'Push A',
        blockName: 'Hypertrophy Block 1',
        focus: 'hypertrophy',
      }),
    ).toBe('Push A · Hypertrophy');
  });

  it('returns null when there is no template name to title from', () => {
    expect(composeSessionTitle({})).toBeNull();
  });
});
