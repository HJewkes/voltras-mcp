// Tests for the auto-armed badge (VW-265): the model helper, and that the live header
// renders it for an auto-created active set and not for a lifter-started one.
//
// The render assertion mounts the actual `ExerciseHeader` (`renderToStaticMarkup` under
// the react-native-web alias, same technique as `spa-exercise-header-title.test.ts`) so a
// broken wiring between the model and the JSX fails here, not just at the helper.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExerciseHeader } from '../spa/live-page/LiveView.js';
import {
  autoArmedBadge,
  type DashboardModel,
  type LiveModel,
  type SessionModel,
} from '../spa/live-page/model.js';

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
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
    sessionPace: null,
    ...over,
  };
}

function liveModel(over: Partial<LiveModel> = {}): LiveModel {
  return {
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
