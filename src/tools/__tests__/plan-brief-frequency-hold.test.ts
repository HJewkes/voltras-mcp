// The day-added hold reads minMesosBeforeSwitch, the one B45 hold for priority and frequency
// changes (VW-624), rather than a second constant of its own.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../goal-guardrails.js', () => ({
  GOAL_GUARDRAIL_THRESHOLDS: { minMesosBeforeSwitch: 3 },
}));

const { trainingDayAddAdvisory } = await import('../plan-brief-frequency.js');

const days = (...counts: number[]) =>
  counts.map((trainingDays, i) => ({ name: `Block ${i + 1}`, trainingDays }));

describe('day-added hold', () => {
  it('follows minMesosBeforeSwitch when it moves', () => {
    expect(trainingDayAddAdvisory(days(3, 3, 4))?.text).toContain('held for 2 blocks.');
    expect(trainingDayAddAdvisory(days(3, 3, 3, 4))).toBeNull();
  });
});
