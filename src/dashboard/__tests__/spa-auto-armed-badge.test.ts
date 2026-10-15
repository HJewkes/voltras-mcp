// Tests for the auto-armed badge (VW-265): the model helper, and that the live header
// renders it for an auto-created active set and not for a lifter-started one.
//
// The render assertion mounts the actual `ExerciseHeader` (`renderToStaticMarkup` under
// the react-native-web alias, same technique as `spa-exercise-header-title.test.ts`) so a
// broken wiring between the model and the JSX fails here, not just at the helper.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SnapshotActiveSet } from '../spa/adapter.js';
import { ExerciseHeader } from '../spa/live-page/ExerciseHeader.js';
import { armSourceLabel } from '../spa/live-page/live-copy.js';
import {
  autoArmedBadge,
  autoArmedTitle,
  type DashboardModel,
  type LiveModel,
  type SessionModel,
} from '../spa/live-page/model.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    lifter: null,
    weightLbs: 140,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    restBasis: null,
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
    sessionPace: null,
    ...over,
  };
}

function liveModel(over: Partial<LiveModel> = {}): LiveModel {
  return {
    fatigueStop: exerciseFatigueStop(undefined),
    velocity: 0.4,
    force: 100,
    phase: 'concentric',
    phaseElapsedMs: 0,
    lastRep: null,
    repVelocities: [0.4],
    velocityLossPct: null,
    peakForce: null,
    ...over,
  };
}

describe('autoArmedBadge', () => {
  it('names the guided-load mechanism', () => {
    expect(autoArmedBadge({ autoCreatedBy: 'guided_load' })).toBe('guided_load');
  });

  it('names the idle-rep mechanism', () => {
    expect(autoArmedBadge({ autoCreatedBy: 'idle_rep' })).toBe('idle_rep');
  });

  it('is null for a lifter-started set (no autoCreatedBy)', () => {
    expect(autoArmedBadge({})).toBeNull();
  });

  it('is null with no set at all', () => {
    expect(autoArmedBadge(null)).toBeNull();
    expect(autoArmedBadge(undefined)).toBeNull();
  });
});

describe('ExerciseHeader auto-armed badge (VW-265)', () => {
  function renderHeader(live: LiveModel | null): string {
    const model: DashboardModel = { live, session: sessionModel(), restElapsedMs: null };
    return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
  }

  it('shows the badge for an auto-armed active set', () => {
    const html = renderHeader(liveModel({ autoCreatedBy: 'idle_rep' }));
    expect(html).toContain('data-testid="auto-arm-badge"');
    expect(html).toContain('AUTO');
  });

  it('shows the badge for a guided-load auto-armed active set', () => {
    const html = renderHeader(liveModel({ autoCreatedBy: 'guided_load' }));
    expect(html).toContain('data-testid="auto-arm-badge"');
  });

  it('shows no badge for a lifter-started active set', () => {
    const html = renderHeader(liveModel({ autoCreatedBy: null }));
    expect(html).not.toContain('data-testid="auto-arm-badge"');
  });

  it('shows no badge when no set is active', () => {
    const html = renderHeader(null);
    expect(html).not.toContain('data-testid="auto-arm-badge"');
  });
});

// VW-720: the three ways an auto-armed set's stop can be sourced, as the wire carries them.
const PLAN_ROW_SET: SnapshotActiveSet = {
  autoCreatedBy: 'idle_rep',
  armDefaultsSource: 'plan_row',
  watch: {
    notifyOn: [
      {
        type: 'velocity_loss_exceeded',
        pct: 20,
        intent: 'strength',
        thresholdSource: 'plan_intent',
      },
    ],
  },
};
const DEFAULT_SET: SnapshotActiveSet = {
  autoCreatedBy: 'idle_rep',
  armDefaultsSource: 'default',
  watch: { notifyOn: [{ type: 'velocity_loss_exceeded', pct: 30, thresholdSource: 'default' }] },
};
const AGENT_UPGRADED_SET: SnapshotActiveSet = {
  autoCreatedBy: 'idle_rep',
  watch: { notifyOn: [{ type: 'velocity_loss_exceeded', pct: 15, thresholdSource: 'explicit' }] },
};

describe('armSourceLabel (VW-720)', () => {
  it('names the plan row, its intent and its stop', () => {
    expect(armSourceLabel(PLAN_ROW_SET)).toBe('Plan · strength · stop 20%');
  });

  it('marks the default stop as assumed', () => {
    expect(armSourceLabel(DEFAULT_SET)).toBe('Default · stop 30% (assumed)');
  });

  it('names a plan row that states its own loss target but no intent', () => {
    const set: SnapshotActiveSet = {
      armDefaultsSource: 'plan_row',
      watch: {
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25, thresholdSource: 'explicit' }],
      },
    };
    expect(armSourceLabel(set)).toBe('Plan · stop 25%');
  });

  it('is null once an agent watch has replaced the server one', () => {
    expect(armSourceLabel(AGENT_UPGRADED_SET)).toBeNull();
  });

  it('is null when the watch carries no loss threshold', () => {
    const set: SnapshotActiveSet = {
      armDefaultsSource: 'default',
      watch: { notifyOn: [{ type: 'rep_count_reached', value: 8 }] },
    };
    expect(armSourceLabel(set)).toBeNull();
  });
});

describe('ExerciseHeader auto-arm source line (VW-720)', () => {
  function renderFor(set: SnapshotActiveSet): string {
    const live = liveModel({ autoCreatedBy: 'idle_rep', armSource: armSourceLabel(set) });
    const model: DashboardModel = { live, session: sessionModel(), restElapsedMs: null };
    return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
  }

  it('shows the plan-row line beside the badge', () => {
    const html = renderFor(PLAN_ROW_SET);
    expect(html).toContain('data-testid="auto-arm-source"');
    expect(html).toContain('Plan · strength · stop 20%');
  });

  it('shows the default line marked assumed', () => {
    const html = renderFor(DEFAULT_SET);
    expect(html).toContain('Default · stop 30% (assumed)');
  });

  it('shows the badge but no source line for an agent-upgraded set', () => {
    const html = renderFor(AGENT_UPGRADED_SET);
    expect(html).toContain('data-testid="auto-arm-badge"');
    expect(html).not.toContain('data-testid="auto-arm-source"');
  });
});

describe('autoArmedTitle with a source (VW-720)', () => {
  it('appends the plan-row source to the mechanism', () => {
    expect(autoArmedTitle('idle_rep', armSourceLabel(PLAN_ROW_SET))).toBe(
      'Auto-armed · your reps · Plan · strength · stop 20%',
    );
  });

  it('appends the default source to the mechanism', () => {
    expect(autoArmedTitle('idle_rep', armSourceLabel(DEFAULT_SET))).toBe(
      'Auto-armed · your reps · Default · stop 30% (assumed)',
    );
  });

  it('names only the mechanism for an agent-upgraded set', () => {
    expect(autoArmedTitle('idle_rep', armSourceLabel(AGENT_UPGRADED_SET))).toBe(
      'Auto-armed · your reps',
    );
  });
});
