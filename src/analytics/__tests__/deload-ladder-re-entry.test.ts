// VW-975: an active re-entry window keeps the deload ladder silent.

import { describe, expect, it } from 'vitest';

import { selectDeloadRung, type DeloadLadderInput } from '../deload-ladder.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function input(overrides: Partial<DeloadLadderInput> = {}): DeloadLadderInput {
  return {
    muscles: [
      {
        muscle: 'chest',
        state: 'confirmed',
        confirmedAt: '2026-06-14T12:00:00.000Z',
        evidence: [],
      },
      { muscle: 'back', state: 'confirmed', confirmedAt: '2026-06-13T12:00:00.000Z', evidence: [] },
    ],
    tier: { tier: 'intermediate', confidence: 'confident' },
    currentWeekIsDeload: false,
    priorDecisions: [],
    now: NOW,
    ...overrides,
  };
}

describe('selectDeloadRung during a re-entry window', () => {
  it('suppresses a rung two in-window confirmations would otherwise advise', () => {
    const advisory = selectDeloadRung(input({ reEntryActive: true }));

    expect(advisory.status).toBe('suppressed');
    expect(advisory.rung).toBeNull();
    expect(advisory.respondWith).toBeNull();
    expect(advisory.reasoning).toMatch(/re-entry window/);
  });

  it('still advises the same confirmations when no window is active', () => {
    const advisory = selectDeloadRung(input({ reEntryActive: false }));

    expect(advisory.status).toBe('advise');
    expect(advisory.rung).toBe('recovery_half_week');
  });

  it("reads an absent flag as no window, so today's callers see no change", () => {
    const advisory = selectDeloadRung(input());

    expect(advisory.status).toBe('advise');
  });
});
