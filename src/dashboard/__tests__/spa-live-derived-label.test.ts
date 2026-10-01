// The live page labels last time's numbers as last time's (VW-643, S3 of VW-442).
//
// A derived prescription (VW-642) fills the same header lockup and rest line a plan does, so
// without a label it reads as the coach's prescription. These run the real mapper and mount
// the real `ExerciseHeader` and `RestView` (`renderToStaticMarkup` under the react-native-web
// alias), because the label is only proven where it renders. Tests run in UTC, so a UTC
// instant's local date is its UTC date.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { initialAccumulatorState, type PrescriptionView, type Snapshot } from '../spa/adapter.js';
import { ExerciseHeader } from '../spa/live-page/ExerciseHeader.js';
import { RestView } from '../spa/live-page/RestView.js';
import type { DashboardModel } from '../spa/live-page/model.js';
import { mapStoreToDashboardModel } from '../spa/panels/live-view.js';

const LAST_TIME_STARTED_AT = '2026-09-24T18:30:00.000Z';

const ACTIVE_ROW = {
  exerciseId: 'ex-press',
  name: 'Cable Chest Press',
  order: 0,
  sets: 3,
  repsLow: 8,
  repsHigh: 10,
  weightLbs: 140,
  active: true,
};

const DERIVED: PrescriptionView = {
  source: 'derived',
  derivedFrom: { startedAt: LAST_TIME_STARTED_AT },
  sets: 3,
  repsLow: 8,
  repsHigh: 10,
  weightLbs: 140,
  exercises: [ACTIVE_ROW],
};

const PRESCRIBED: PrescriptionView = {
  source: 'prescribed',
  sets: 3,
  repsLow: 8,
  repsHigh: 10,
  weightLbs: 140,
  exercises: [ACTIVE_ROW],
};

function snapshot(): Snapshot {
  return {
    session: { sessionId: 's1', exerciseName: 'Cable Chest Press' },
    devices: [],
    sets: { active: null },
  };
}

function modelFor(prescription: PrescriptionView | null): DashboardModel {
  const model = mapStoreToDashboardModel({
    snapshot: snapshot(),
    accumulator: initialAccumulatorState(),
    live: null,
    prescription,
  });
  if (model === null) throw new Error('expected a model for an open session');
  return model;
}

/** The header with connection unknown: the fixture's empty device list reads as a disconnect. */
function renderHeader(model: DashboardModel): string {
  const { connection: _unknown, ...connected } = model;
  return renderToStaticMarkup(createElement(ExerciseHeader, { model: connected }));
}

/** The rest stage with a running countdown, so the next-set line renders under the ring. */
function renderRest(model: DashboardModel): string {
  const resting = { ...model, session: { ...model.session, restSec: 90 }, restElapsedMs: 0 };
  return renderToStaticMarkup(createElement(RestView, { model: resting }));
}

describe('live page label for derived targets (VW-643)', () => {
  it('marks last time’s targets with the local date beside the lockup', () => {
    const model = modelFor(DERIVED);

    expect(model.session.prescriptionSource).toBe('derived');
    expect(model.session.derivedFromAt).toBe(LAST_TIME_STARTED_AT);
    const html = renderHeader(model);
    expect(html).toContain('data-testid="derived-targets-caption"');
    expect(html).toContain('Last time · 2026-09-24');
  });

  it('suffixes the rest stage’s set line with (last time) when derived', () => {
    const html = renderRest(modelFor(DERIVED));

    expect(html).toContain('set 1 of 3 (last time)');
  });

  it('shows a plan’s targets with no caption and no suffix', () => {
    const model = modelFor(PRESCRIBED);

    expect(model.session.prescriptionSource).toBe('prescribed');
    expect(model.session.derivedFromAt).toBeNull();
    const header = renderHeader(model);
    expect(header).toContain('data-testid="exercise-header"');
    expect(header).not.toContain('Last time');
    const rest = renderRest(model);
    expect(rest).toContain('set 1 of 3');
    expect(rest).not.toContain('(last time)');
  });

  it('reads a prescription without a source as the plan’s', () => {
    const { source: _omitted, ...legacy } = PRESCRIBED;

    expect(modelFor(legacy).session.prescriptionSource).toBe('prescribed');
  });

  it('leaves both fields null and renders no label with no prescription', () => {
    const model = modelFor(null);

    expect(model.session.prescriptionSource).toBeNull();
    expect(model.session.derivedFromAt).toBeNull();
    const header = renderHeader(model);
    expect(header).toContain('data-testid="exercise-header"');
    expect(header).not.toContain('Last time');
    expect(renderRest(model)).not.toContain('(last time)');
  });
});
