// Render test for the page-header region when no session is open (VMCP-03.08).
//
// Mounts the actual `ExerciseHeader` (`renderToStaticMarkup` under the
// react-native-web alias, same technique as `spa-exercise-header-title.test.ts`)
// so the assertion covers the real markup, not just the model the header reads.
// Also pins that a KNOWN disconnect still hides the header, unchanged.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExerciseHeader } from '../spa/live-page/LiveView.js';
import type { DashboardModel, SessionModel } from '../spa/live-page/model.js';

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
    ...over,
  };
}

function renderHeader(session: SessionModel, connected?: boolean): string {
  const model: DashboardModel = {
    live: null,
    session,
    restElapsedMs: null,
    ...(connected !== undefined ? { connection: { connected, label: '' } } : {}),
  };
  return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
}

// The wrapper's `class` attribute value, so tests can check the no-session case reuses
// the SAME wrapper (and therefore the same layout) rather than a differently-styled one.
// This is a stand-in for asserting height, which `renderToStaticMarkup` cannot measure.
function wrapperClass(html: string): string | null {
  const testIdIndex = html.indexOf('data-testid="exercise-header"');
  if (testIdIndex === -1) return null;
  const tagStart = html.lastIndexOf('<', testIdIndex);
  const tagEnd = html.indexOf('>', testIdIndex);
  const openingTag = html.slice(tagStart, tagEnd + 1);
  const match = /class="([^"]*)"/.exec(openingTag);
  return match ? match[1] : null;
}

describe('ExerciseHeader with no open session (VMCP-03.08)', () => {
  it('keeps the header region present, with neutral idle copy, when no session is open', () => {
    const html = renderHeader(sessionModel({ hasSession: false, exerciseName: 'Exercise 1' }));
    expect(html).toContain('data-testid="exercise-header"');
    expect(html).toContain('Waiting for a set');
    expect(html).not.toContain('Exercise 1');
    expect(html).not.toContain('—');
  });

  it('keeps the header region present with a real exercise name when a session is open', () => {
    const html = renderHeader(
      sessionModel({ hasSession: true, exerciseName: 'Cable Chest Press' }),
    );
    expect(html).toContain('data-testid="exercise-header"');
    expect(html).toContain('Cable Chest Press');
  });

  it('keeps the header region present with the neutral ordinal when a session has not named its exercise', () => {
    const html = renderHeader(sessionModel({ hasSession: true, exerciseName: 'Exercise 1' }));
    expect(html).toContain('data-testid="exercise-header"');
    expect(html).toContain('Exercise 1');
  });

  it('reuses the same wrapper (and therefore the same layout) with and without a session', () => {
    const withoutSession = renderHeader(sessionModel({ hasSession: false }));
    const withSession = renderHeader(sessionModel({ hasSession: true }));
    const noSessionClass = wrapperClass(withoutSession);
    const withSessionClass = wrapperClass(withSession);
    expect(noSessionClass).not.toBeNull();
    expect(noSessionClass).toBe(withSessionClass);
  });

  it('stays hidden on a known disconnect, unchanged from before VMCP-03.08', () => {
    const html = renderHeader(sessionModel({ hasSession: false }), false);
    expect(html).not.toContain('data-testid="exercise-header"');
  });
});
