// No audit summary may carry a field outside SUMMARY_FIELDS, or echo an
// argument nobody named (VW-891).
//
// Every write tool runs over its fixture plus an injected probe. A summariser
// that spreads, copies or iterates its arguments carries the probe through and
// fails here.

import { describe, expect, it } from 'vitest';

import {
  COMMAND_SUMMARIES,
  NAME_ONLY,
  SUMMARY_FIELDS,
  summariseCommand,
  type WriteToolName,
} from '../command-summary.js';

const PROBE = { __probe: 'x', raw: [1, 2] } as const;

/** Arguments a name-only tool is run over: plausible values for every field. */
const GENERIC_ARGS = { slot: 'left', weightLbs: 100, mode: 'WeightTraining', reps: 5 };

const FIXTURES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'session.start': { slot: 'left', exerciseId: 'bench-press', verboseIdleReps: true },
  'session.end': { slot: 'left', checkin: { energy: 'high' } },
  'session.set_exercise': { slot: 'left', exerciseName: 'Cable Row' },
  'session.mark_kind': { kind: 'test', day: '2026-10-01', dryRun: true },
  'set.start': { slot: 'left', setPurpose: 'working', lifter: 'Guest' },
  'set.end': { slot: 'right' },
  'plan.week.skip': { blockId: 'block-1', week: 3, reason: 'travel', mode: 'extend' },
  'plan.exercise.create': {
    workoutTemplateId: 'template-1',
    exerciseId: 'squat',
    orderIndex: 0,
    targetSets: 4,
    targetRepsLow: 6,
    targetRepsHigh: 8,
    targetWeightLbs: 135,
    notes: 'keep it smooth',
  },
  'truecoach.import_week': { from: '2026-10-05', to: '2026-10-11', mapping: { a: 'b' } },
  'profile.set_diet_phase': { phase: 'recomposition', recompMode: 'hold' },
  'profile.log_bodyweight': { bodyweightLbs: 182.4, note: 'after breakfast', waistIn: 33 },
  'profile.log_weekly_checkin': { weekOf: '2026-10-04', hunger: 'low' },
  'goal.declare_priorities': { items: [{ metric: 'a' }, { metric: 'b' }], horizonWeeks: 12 },
  'goal.propose_targets': { priorityId: 'priority-1' },
  'goal.accept_target': { targetId: 'target-1', committedValue: 200, acknowledgeStretch: true },
  'goal.retire': { targetId: 'target-2', outcome: 'met' },
  'goal.new_chapter': { targetId: 'target-3', at: '2026-10-01T00:00:00Z' },
  'goal.weekly_review': { weekOf: '2026-10-04', response: 'accept' },
};

const WRITE_TOOLS = Object.keys(COMMAND_SUMMARIES) as WriteToolName[];
const SUMMARISED = WRITE_TOOLS.filter((tool) => COMMAND_SUMMARIES[tool] !== NAME_ONLY);
const NAME_ONLY_TOOLS = WRITE_TOOLS.filter((tool) => COMMAND_SUMMARIES[tool] === NAME_ONLY);

function argsFor(tool: WriteToolName): Record<string, unknown> {
  return { ...(FIXTURES[tool] ?? GENERIC_ARGS), ...PROBE };
}

describe('the summary allowlist', () => {
  it('has a fixture for every summarised tool, and no fixture for anything else', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...SUMMARISED].sort());
  });

  it.each(SUMMARISED)('%s summarises its fixture to allowlisted keys only', (tool) => {
    const summary = summariseCommand(tool, argsFor(tool));

    expect(summary, `${tool} summarised nothing from its fixture`).not.toBeNull();
    const allowed = new Set<string>(SUMMARY_FIELDS);
    for (const key of Object.keys(summary ?? {})) {
      expect(allowed.has(key), `${tool} carries ${key}`).toBe(true);
    }
  });

  it.each(SUMMARISED)('%s never echoes the injected probe', (tool) => {
    const summary = summariseCommand(tool, argsFor(tool)) ?? {};

    for (const value of Object.values(summary)) {
      expect(value).not.toBe(PROBE.__probe);
      expect(typeof value === 'string' || typeof value === 'number').toBe(true);
    }
    expect(JSON.stringify(summary)).not.toContain('__probe');
  });

  it.each(NAME_ONLY_TOOLS)('%s yields null', (tool) => {
    expect(summariseCommand(tool, argsFor(tool))).toBeNull();
  });
});
