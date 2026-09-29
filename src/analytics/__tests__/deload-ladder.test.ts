// VW-591 (VW-139 S1): fixtures for the pure deload-ladder rung selector.
//
// Every confirmation age sits on or beside the rolling window, so moving
// `rollingWindowDays` moves a fixture across the gate and fails a named test.

import { describe, expect, it } from 'vitest';

import {
  DELOAD_LADDER_CONSTANTS,
  DELOAD_LADDER_VERSION,
  selectDeloadRung,
  type DeloadLadderInput,
  type DeloadMuscleSignal,
  type MusclePerformanceState,
  type PriorLadderDecision,
} from '../deload-ladder.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function evidence(exerciseId: string) {
  return [
    { exerciseId, sessionIds: ['s-1', 's-2', 's-3'] as const, reasoning: 'synthetic comparison' },
  ];
}

function confirmed(muscle: string, ageDays: number): DeloadMuscleSignal {
  return {
    muscle,
    state: 'confirmed',
    confirmedAt: daysAgo(ageDays),
    evidence: evidence(`ex-${muscle}`),
  };
}

function other(
  muscle: string,
  state: Exclude<MusclePerformanceState, 'confirmed'>,
): DeloadMuscleSignal {
  return { muscle, state, evidence: state === 'inconclusive' ? [] : evidence(`ex-${muscle}`) };
}

function input(overrides: Partial<DeloadLadderInput> = {}): DeloadLadderInput {
  return {
    muscles: [],
    tier: { tier: 'intermediate', confidence: 'confident' },
    currentWeekIsDeload: false,
    priorDecisions: [],
    now: NOW,
    ...overrides,
  };
}

describe('selectDeloadRung', () => {
  it('advises a recovery session when one muscle is confirmed', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [confirmed('quads', 1), other('chest', 'clear')] }),
    );

    expect(advisory.status).toBe('advise');
    expect(advisory.rung).toBe('recovery_session');
    expect(advisory.respondWith).toBe('plan.respond_deload_advisory');
    expect(advisory.userMessage).toContain('half the usual volume');
  });

  it('advises a recovery half-week when two muscles are confirmed within the rolling week', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [confirmed('quads', 0), confirmed('lats', 7)] }),
    );

    expect(advisory.status).toBe('advise');
    expect(advisory.rung).toBe('recovery_half_week');
    expect(advisory.reasoning).toContain('quads and lats');
  });

  it('advises only a recovery session when two confirmations are eight days apart', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [confirmed('quads', 0), confirmed('lats', 8)] }),
    );

    expect(advisory.status).toBe('advise');
    expect(advisory.rung).toBe('recovery_session');
    expect(advisory.reasoning).toContain('quads');
    expect(advisory.reasoning).not.toContain('lats');
  });

  it('watches without a rung when only provisional muscles are present', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [other('biceps', 'provisional'), other('chest', 'clear')] }),
    );

    expect(advisory.status).toBe('watching');
    expect(advisory.rung).toBeNull();
    expect(advisory.respondWith).toBeNull();
    expect(advisory.userMessage).toContain('One session is noise');
  });

  it('watches without a rung when the only confirmation is older than the window', () => {
    const advisory = selectDeloadRung(input({ muscles: [confirmed('glutes', 9)] }));

    expect(advisory.status).toBe('watching');
    expect(advisory.rung).toBeNull();
    expect(advisory.reasoning).toContain('glutes has a confirmation older than the rolling 7 days');
    expect(advisory.userMessage).toContain('more than 7 days ago');
    expect(advisory.userMessage).not.toContain('One session is noise');
  });

  it('does not count a future-dated confirmation toward the rung', () => {
    const muscles = [confirmed('quads', 1), confirmed('lats', -1)];

    const advisory = selectDeloadRung(input({ muscles }));

    expect(advisory.rung).toBe('recovery_session');
    expect(advisory.reasoning).not.toContain('lats');
  });

  it('does not count an unparseable confirmation toward the rung', () => {
    const unparseable: DeloadMuscleSignal = {
      muscle: 'lats',
      state: 'confirmed',
      confirmedAt: 'not-a-date',
      evidence: evidence('ex-lats'),
    };

    const advisory = selectDeloadRung(input({ muscles: [confirmed('quads', 1), unparseable] }));

    expect(advisory.rung).toBe('recovery_session');
    expect(advisory.reasoning).not.toContain('lats');
  });

  it('watches without a rung when the only confirmation is future-dated', () => {
    const advisory = selectDeloadRung(input({ muscles: [confirmed('lats', -1)] }));

    expect(advisory.status).toBe('watching');
    expect(advisory.rung).toBeNull();
    expect(advisory.reasoning).toContain('cannot be placed in the window');
  });

  it('reports inconclusive when every muscle is inconclusive', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [other('quads', 'inconclusive'), other('abs', 'inconclusive')] }),
    );

    expect(advisory.status).toBe('inconclusive');
    expect(advisory.rung).toBeNull();
    expect(advisory.reasoning).toContain('evaluable');
  });

  it('reports inconclusive when no muscle was trained', () => {
    const advisory = selectDeloadRung(input());

    expect(advisory.status).toBe('inconclusive');
    expect(advisory.reasoning).toContain('No muscle was trained');
  });

  it('reports clear when evaluable muscles show no misses', () => {
    const advisory = selectDeloadRung(
      input({ muscles: [other('chest', 'clear'), other('calves', 'inconclusive')] }),
    );

    expect(advisory.status).toBe('clear');
    expect(advisory.rung).toBeNull();
  });

  it('suppresses every rung during a planned deload week', () => {
    const muscles = [confirmed('quads', 1), confirmed('lats', 2)];

    const advisory = selectDeloadRung(input({ muscles, currentWeekIsDeload: true }));

    expect(advisory.status).toBe('suppressed');
    expect(advisory.rung).toBeNull();
    expect(advisory.respondWith).toBeNull();
    expect(advisory.muscles.map((entry) => entry.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('keeps the rung unchanged by prior decisions and tier in this slice', () => {
    const muscles = [confirmed('quads', 1)];
    const prior: PriorLadderDecision[] = [
      { rung: 'recovery_session', advisedAt: daysAgo(5), response: 'declined' },
    ];

    const advisory = selectDeloadRung(
      input({
        muscles,
        priorDecisions: prior,
        tier: { tier: 'beginner', confidence: 'provisional' },
      }),
    );

    expect(advisory.rung).toBe('recovery_session');
  });

  it('echoes muscles with evidence and reports thresholds and version', () => {
    const advisory = selectDeloadRung(input({ muscles: [confirmed('quads', 1)] }));

    expect(advisory.muscles).toEqual([
      { muscle: 'quads', state: 'confirmed', evidence: evidence('ex-quads') },
    ]);
    expect(advisory.thresholdsUsed).toEqual({
      rollingWindowDays: 7,
      halfWeekMinConfirmedMuscles: 2,
    });
    expect(advisory.algorithmVersion).toBe(DELOAD_LADDER_VERSION);
  });

  it('rejects soreness and self-report fields at the type level', () => {
    const muscle: DeloadMuscleSignal = {
      muscle: 'quads',
      state: 'clear',
      evidence: [],
      // @ts-expect-error the ladder input admits no per-muscle self-report
      soreness: 'high',
    };
    const base = input({ muscles: [muscle] });

    const advisory = selectDeloadRung({
      ...base,
      // @ts-expect-error the ladder input admits no soreness field
      soreness: 3,
    });
    const withMotivation: DeloadLadderInput = {
      ...base,
      // @ts-expect-error the ladder input admits no self-reported motivation
      motivation: 'low',
    };

    expect(advisory.status).toBe('clear');
    expect(withMotivation.muscles).toHaveLength(1);
  });
});

describe('selectDeloadRung across a generated spread of inputs', () => {
  const states: MusclePerformanceState[] = ['confirmed', 'provisional', 'inconclusive', 'clear'];
  const ages = [0, 3, DELOAD_LADDER_CONSTANTS.rollingWindowDays, 8, 30];

  function signal(muscle: string, state: MusclePerformanceState, age: number): DeloadMuscleSignal {
    return state === 'confirmed' ? confirmed(muscle, age) : other(muscle, state);
  }

  function spread(): DeloadLadderInput[] {
    const inputs: DeloadLadderInput[] = [];
    for (const first of states)
      for (const second of states)
        for (const age of ages)
          for (const currentWeekIsDeload of [false, true])
            inputs.push(
              input({
                muscles: [signal('quads', first, age), signal('lats', second, 1)],
                currentWeekIsDeload,
                priorDecisions: [
                  { rung: 'recovery_half_week', advisedAt: daysAgo(4), response: null },
                ],
              }),
            );
    return inputs;
  }

  it('never yields off_day or active_rest, and pairs a rung only with advise', () => {
    const advisories = spread().map(selectDeloadRung);

    for (const advisory of advisories) {
      expect([null, 'recovery_session', 'recovery_half_week']).toContain(advisory.rung);
      expect(advisory.rung !== null).toBe(advisory.status === 'advise');
      expect(advisory.respondWith !== null).toBe(advisory.status === 'advise');
      expect(advisory.reasoning.length).toBeGreaterThan(0);
      expect(JSON.stringify(advisory)).not.toMatch(/off_day|active_rest/);
    }
    expect(advisories).toHaveLength(states.length * states.length * ages.length * 2);
  });
});
