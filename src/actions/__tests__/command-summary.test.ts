// What an audit row may say about each write tool call (VW-891).

import { describe, expect, it } from 'vitest';

import {
  COMMAND_SUMMARIES,
  NAME_ONLY,
  OTHER_MODE,
  publicModeName,
  summariseCommand,
} from '../command-summary.js';
import { SELECTABLE_MODE_NAMES } from '../../schemas/device.js';
import { TOOL_ACCESS } from '../../tool-registry.js';

const writeTools = Object.entries(TOOL_ACCESS)
  .filter(([, access]) => access === 'write')
  .map(([name]) => name);

describe('which tools have an entry', () => {
  it('maps exactly the write-classified tools', () => {
    expect(Object.keys(COMMAND_SUMMARIES).sort()).toEqual(writeTools.sort());
  });

  it('keeps the raw send, debug, mock and lease tools name-only', () => {
    const byRule = Object.keys(COMMAND_SUMMARIES).filter(
      (tool) =>
        tool === 'device.send_raw' ||
        tool.startsWith('debug.') ||
        tool.startsWith('mock.') ||
        tool.startsWith('system.lease_'),
    );

    expect(byRule).toHaveLength(7);
    for (const tool of byRule) {
      expect(COMMAND_SUMMARIES[tool as keyof typeof COMMAND_SUMMARIES], tool).toBe(NAME_ONLY);
    }
  });

  it('keeps every device tool name-only while the device field list is open', () => {
    const device = Object.keys(COMMAND_SUMMARIES).filter(
      (tool) =>
        tool.startsWith('device.') ||
        tool.startsWith('bilateral.') ||
        tool.startsWith('slot.') ||
        tool.startsWith('isometric.'),
    );

    for (const tool of device) {
      expect(COMMAND_SUMMARIES[tool as keyof typeof COMMAND_SUMMARIES], tool).toBe(NAME_ONLY);
    }
  });
});

describe('summaries in fitness units', () => {
  it('records a bodyweight reading and nothing else from the weigh-in', () => {
    const summary = summariseCommand('profile.log_bodyweight', {
      bodyweightLbs: 182.4,
      note: 'after breakfast',
      bodyFatPct: 18,
    });

    expect(summary).toEqual({ bodyweightLbs: 182.4 });
  });

  it('records a planned exercise as exercise, reps, load and set count', () => {
    const summary = summariseCommand('plan.exercise.create', {
      workoutTemplateId: 'template-1',
      exerciseId: 'squat',
      orderIndex: 0,
      targetSets: 4,
      targetRepsLow: 6,
      targetRepsHigh: 8,
      targetWeightLbs: 135,
    });

    expect(summary).toEqual({ exercise: 'squat', reps: 8, loadLbs: 135, count: 4 });
  });

  it('names a goal by the target a retirement ends, else by its priority', () => {
    expect(summariseCommand('goal.retire', { targetId: 't-1', outcome: 'met' })).toEqual({
      goalId: 't-1',
    });
    expect(summariseCommand('goal.retire', { priorityId: 'p-1', outcome: 'missed' })).toEqual({
      goalId: 'p-1',
    });
  });

  it('counts declared priorities without recording them', () => {
    const summary = summariseCommand('goal.declare_priorities', {
      items: [{ metric: 'a' }, { metric: 'b' }, { metric: 'c' }],
    });

    expect(summary).toEqual({ count: 3 });
  });

  it('labels a skipped week by its calendar number', () => {
    expect(summariseCommand('plan.week.skip', { blockId: 'b-1', week: 2 })).toEqual({
      weekLabel: 'week 2',
    });
  });

  it('takes the exercise id over its free-text name', () => {
    const summary = summariseCommand('session.start', {
      slot: 'left',
      exerciseId: 'bench-press',
      exerciseName: 'Bench',
    });

    expect(summary).toEqual({ slot: 'left', exercise: 'bench-press' });
  });
});

describe('values that fail their check', () => {
  it('drops a diet phase that is not one of the declared phases', () => {
    expect(summariseCommand('profile.set_diet_phase', { phase: 'bulk' })).toBeNull();
  });

  it('drops a session kind outside training and test', () => {
    expect(summariseCommand('session.mark_kind', { kind: 'other', day: '2026-10-01' })).toBeNull();
  });

  it('drops a non-finite or non-numeric load', () => {
    expect(summariseCommand('profile.log_bodyweight', { bodyweightLbs: Infinity })).toBeNull();
    expect(summariseCommand('profile.log_bodyweight', { bodyweightLbs: '180' })).toBeNull();
  });

  it('drops text that is too long or not plain', () => {
    expect(summariseCommand('session.end', { slot: 'a'.repeat(81) })).toBeNull();
    expect(summariseCommand('session.end', { slot: '{"k":1}' })).toBeNull();
    expect(summariseCommand('session.end', { slot: ['left'] })).toBeNull();
  });

  it('drops a week that is not a calendar date', () => {
    expect(summariseCommand('goal.weekly_review', { weekOf: 'last week' })).toBeNull();
  });

  it('returns null for arguments that are not an object', () => {
    expect(summariseCommand('profile.log_bodyweight', undefined)).toBeNull();
    expect(summariseCommand('profile.log_bodyweight', [182])).toBeNull();
    expect(summariseCommand('profile.log_bodyweight', 'bodyweightLbs=182')).toBeNull();
  });
});

describe('the public mode name', () => {
  it('passes every selectable mode name through', () => {
    for (const name of SELECTABLE_MODE_NAMES) {
      expect(publicModeName(name)).toBe(name);
    }
  });

  it('turns an unknown name, a number or a missing value into other', () => {
    expect(publicModeName('NotAMode')).toBe(OTHER_MODE);
    expect(publicModeName(3)).toBe(OTHER_MODE);
    expect(publicModeName(undefined)).toBe(OTHER_MODE);
  });
});
