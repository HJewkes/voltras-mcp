// Unit tests for the coach-caption read-model (VW-289) — every rule that decides whether
// the wall is showing a spoken line lives in `deriveCoachLineCaption`, so it is all here.

import { describe, expect, it } from 'vitest';

import { COACH_LINE_DWELL_MS, deriveCoachLineCaption } from '../spa/live-page/coach-line-model.js';
import type { LiveCoachLineSignal } from '../../state/live-signal.js';

function line(over: Partial<LiveCoachLineSignal> = {}): LiveCoachLineSignal {
  return { text: 'two reps to go', source: 'speak', occurredAt: 1_000, ...over };
}

describe('deriveCoachLineCaption (VW-289)', () => {
  it('shows nothing before any line has been spoken', () => {
    expect(deriveCoachLineCaption({ line: null, nowMs: 5_000 })).toBeNull();
  });

  it('captions the line inside its dwell', () => {
    expect(deriveCoachLineCaption({ line: line(), nowMs: 5_000 })).toEqual({
      text: 'two reps to go',
      label: 'COACH',
    });
  });

  it('clears the caption once the dwell expires', () => {
    const nowMs = 1_000 + COACH_LINE_DWELL_MS;
    expect(deriveCoachLineCaption({ line: line(), nowMs })).toBeNull();
    expect(deriveCoachLineCaption({ line: line(), nowMs: nowMs - 1 })).not.toBeNull();
  });

  it('shows the latest line, restarting the dwell from it', () => {
    const stale = 1_000;
    const fresh = stale + COACH_LINE_DWELL_MS + 5_000;
    const nowMs = fresh + 100;
    expect(deriveCoachLineCaption({ line: line({ occurredAt: stale }), nowMs })).toBeNull();
    expect(
      deriveCoachLineCaption({ line: line({ text: 'rest is up', occurredAt: fresh }), nowMs }),
    ).toEqual({ text: 'rest is up', label: 'COACH' });
  });

  it('ignores an empty or whitespace-only line rather than captioning a blank box', () => {
    expect(deriveCoachLineCaption({ line: line({ text: '' }), nowMs: 1_000 })).toBeNull();
    expect(deriveCoachLineCaption({ line: line({ text: '   ' }), nowMs: 1_000 })).toBeNull();
  });

  it('names the cue category for a deterministic cue instead of claiming the coach spoke', () => {
    expect(deriveCoachLineCaption({ line: line({ source: 'set_intro' }), nowMs: 1_000 })).toEqual({
      text: 'two reps to go',
      label: 'SET INTRO',
    });
  });

  it('captions a line the 1 Hz clock has not caught up to yet', () => {
    expect(deriveCoachLineCaption({ line: line({ occurredAt: 9_000 }), nowMs: 0 })).not.toBeNull();
  });
});
