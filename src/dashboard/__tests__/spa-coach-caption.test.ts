// Render tests for the rest stage's coach caption (VW-289), same `renderToStaticMarkup`
// technique as `spa-isometric-verdict-card.test.ts`.
//
// The property worth mounting a component for is the RESERVED HEIGHT: the caption's box is
// in the layout whether or not the trainer has said anything, so the rest timer under it
// cannot be shoved down and back up mid-rest. No model assertion can see that.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CoachCaption, RestView } from '../spa/live-page/RestView.js';
import type { CoachLineCaption } from '../spa/live-page/coach-line-model.js';
import type { DashboardModel, SessionModel } from '../spa/live-page/model.js';

function render(caption: CoachLineCaption | null): string {
  return renderToStaticMarkup(createElement(CoachCaption, { caption }));
}

function sessionModel(): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    lifter: null,
    weightLbs: null,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
  };
}

/** The height the caption box holds open, whatever is in it. */
const RESERVED = 'height:72px';

describe('rest-stage coach caption (VW-289)', () => {
  it('captions the spoken line and its attribution', () => {
    const html = render({ text: 'two reps to go', label: 'COACH' });
    expect(html).toContain('data-testid="coach-caption"');
    expect(html).toContain('two reps to go');
    expect(html).toContain('COACH');
  });

  it('names a deterministic cue by its category instead', () => {
    expect(render({ text: 'target hit', label: 'TARGET HIT' })).toContain('TARGET HIT');
  });

  it('reserves the same height with nothing to caption', () => {
    const empty = render(null);
    expect(empty).not.toContain('data-testid="coach-caption"');
    expect(empty).toContain(RESERVED);
    expect(render({ text: 'two reps to go', label: 'COACH' })).toContain(RESERVED);
  });

  it('holds that height open inside the rest stage itself', () => {
    const model: DashboardModel = { live: null, session: sessionModel(), restElapsedMs: 4_000 };
    expect(renderToStaticMarkup(createElement(RestView, { model }))).toContain(RESERVED);
  });
});
