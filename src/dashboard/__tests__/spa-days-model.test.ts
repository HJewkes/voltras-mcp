// The review-days flow model (VW-847 S3): pure rules, so nothing is mocked.

import { describe, expect, it } from 'vitest';

import { ActionRefusedError, IndeterminateWriteError } from '../spa/api-client.js';
import {
  createAttemptIds,
  createPreviewGate,
  daysErrorOf,
  daysReadErrorOf,
  settleFailure,
  daysInRange,
  errorCopy,
  expectSessions,
  flowStepOf,
  followUpOf,
  markInput,
  newFlowId,
  previewLines,
  rangeBounds,
  rederiveWarning,
  type MarkResult,
  type Selection,
} from '../spa/days/days-model.js';
import type { ReviewDay } from '../../analytics/session-review.js';

const result = (over: Partial<MarkResult> = {}): MarkResult => ({
  kind: 'training',
  dryRun: true,
  newlyClassified: ['a', 'b'],
  reclassified: [],
  skippedAlreadyMarked: ['c'],
  alreadyThisKind: ['d', 'e', 'f'],
  setsChanged: 7,
  days: ['2026-09-01', '2026-09-02'],
  rederiveFailed: [],
  ...over,
});

const range: Selection = { scope: 'range', from: '2026-09-01', to: '2026-09-02', kind: 'training' };
const day: Selection = { scope: 'day', day: '2026-09-01', kind: 'training', reclassify: false };

const refused = (code: string): ActionRefusedError =>
  new ActionRefusedError({ code, result: null, status: 400, actionId: 'x' });

describe('expectSessions', () => {
  it('sums all four lists, not newlyClassified alone', () => {
    expect(expectSessions(result({ reclassified: ['g'] }))).toBe(7);
  });
});

describe('markInput', () => {
  it('sends a range preview as a dry run with no count', () => {
    expect(markInput(range, 'preview')).toEqual({
      kind: 'training',
      from: '2026-09-01',
      to: '2026-09-02',
      dryRun: true,
    });
  });

  it('sends a range mark with the previewed count and never reclassify', () => {
    expect(markInput(range, 'mark', 6)).toEqual({
      kind: 'training',
      from: '2026-09-01',
      to: '2026-09-02',
      expectSessions: 6,
    });
  });

  it('sends reclassify only for a day that asks for it', () => {
    expect(markInput(day, 'mark', 1)).toEqual({ kind: 'training', day: '2026-09-01' });
    expect(markInput({ ...day, reclassify: true }, 'preview')).toEqual({
      kind: 'training',
      day: '2026-09-01',
      reclassify: true,
      dryRun: true,
    });
  });
});

describe('flow ids and steps', () => {
  it('names the flow and the four steps', () => {
    expect(newFlowId('ab12cd34')).toBe('days-ab12cd34');
    expect(flowStepOf(day, 'preview')).toBe('preview');
    expect(flowStepOf(day, 'mark')).toBe('mark');
    expect(flowStepOf(range, 'preview')).toBe('range_preview');
    expect(flowStepOf(range, 'mark')).toBe('range_mark');
  });
});

describe('range bounds', () => {
  const days = ['2026-09-03', '2026-09-02', '2026-09-01'].map((d) => ({ day: d }) as ReviewDay);

  it('orders the bounds whichever was tapped first', () => {
    expect(rangeBounds('2026-09-03', '2026-09-01')).toEqual({
      from: '2026-09-01',
      to: '2026-09-03',
    });
  });

  it('highlights the listed days between the bounds', () => {
    expect(daysInRange(days, '2026-09-03', '2026-09-02')).toEqual(['2026-09-03', '2026-09-02']);
  });
});

describe('preview gate', () => {
  it('confirms only a selection that was previewed', () => {
    const gate = createPreviewGate();
    expect(gate.canConfirm(range)).toBe(false);
    gate.record(range, result());
    expect(gate.canConfirm(range)).toBe(true);
  });

  it('stales the preview when the selection is edited', () => {
    const gate = createPreviewGate();
    gate.record(range, result());
    expect(gate.canConfirm({ ...range, kind: 'test' })).toBe(false);
    expect(gate.canConfirm({ ...range, to: '2026-09-03' })).toBe(false);
    expect(gate.previewFor(range)).not.toBeNull();
  });

  it('forgets the preview on clear', () => {
    const gate = createPreviewGate();
    gate.record(day, result());
    gate.clear();
    expect(gate.canConfirm(day)).toBe(false);
  });
});

describe('attempt ids', () => {
  const counter = () => {
    let n = 0;
    return () => `id-${String(++n)}`;
  };

  it('keeps the id on Retry with unchanged input', () => {
    const ids = createAttemptIds(counter());
    const input = markInput(range, 'preview');
    expect(ids.idFor('range_preview', input)).toBe(ids.idFor('range_preview', { ...input }));
  });

  it('mints a new id when the input is edited', () => {
    const ids = createAttemptIds(counter());
    const first = ids.idFor('range_preview', markInput(range, 'preview'));
    const edited = ids.idFor('range_preview', markInput({ ...range, kind: 'test' }, 'preview'));
    expect(edited).not.toBe(first);
  });

  it('holds one id per step', () => {
    const ids = createAttemptIds(counter());
    const input = markInput(day, 'mark', 1);
    expect(ids.idFor('mark', input)).not.toBe(ids.idFor('preview', input));
  });
});

describe('error to state and follow-up', () => {
  it('re-previews on a mismatch and never confirms', () => {
    const error = daysErrorOf(refused('EXPECTED_SESSIONS_MISMATCH'));
    expect(error).toEqual({ kind: 'range_changed' });
    expect(followUpOf(error)).toBe('preview');
    expect(errorCopy(error)).toBe('The range changed since the preview');
  });

  it('refetches on NOT_FOUND', () => {
    expect(followUpOf(daysErrorOf(refused('NOT_FOUND')))).toBe('refetch');
  });

  it('refetches on an indeterminate write', () => {
    const error = daysErrorOf(new IndeterminateWriteError('unsure', 'x'));
    expect(followUpOf(error)).toBe('refetch');
  });

  it('shows invalid_input inline and does nothing else', () => {
    const error = daysErrorOf(
      new ActionRefusedError({
        code: 'invalid_input',
        message: 'bad day',
        result: null,
        status: 400,
        actionId: 'x',
      }),
    );
    expect(error).toEqual({ kind: 'invalid_input', message: 'bad day' });
    expect(followUpOf(error)).toBe('none');
  });

  it('calls a failed fetch not saved, keeping the selection', () => {
    const error = daysErrorOf(new TypeError('fetch failed'));
    expect(error).toEqual({ kind: 'not_saved' });
    expect(errorCopy(error)).toBe('Not saved: the dashboard server did not answer');
    expect(followUpOf(error)).toBe('none');
  });

  it('names an unknown refusal by its code', () => {
    expect(errorCopy(daysErrorOf(refused('SOMETHING')))).toBe(
      'The dashboard refused that (SOMETHING)',
    );
  });
});

describe('preview copy', () => {
  it('covers newly, skipped, already-this-kind and the days', () => {
    expect(previewLines(result())).toEqual([
      'Mark 2 sessions on 2 days as training',
      '7 sets change',
      '1 already marked test stays as it is',
      '3 already training',
      '2026-09-01, 2026-09-02',
    ]);
  });

  it('omits the lines for lists that are empty and names a flip', () => {
    const lines = previewLines(
      result({ kind: 'test', skippedAlreadyMarked: [], alreadyThisKind: [], reclassified: ['g'] }),
    );
    expect(lines).toContain('1 session will be flipped');
    expect(lines.some((l) => l.includes('already'))).toBe(false);
  });

  it('names the exercises whose baselines were not refreshed, not their ids', () => {
    const days = [
      { exercises: [{ name: 'Squat', exerciseId: 'ex-1' }, { name: 'Press' }] },
    ] as unknown as ReviewDay[];
    expect(rederiveWarning(result({ rederiveFailed: ['ex-1'] }), days)).toBe(
      'Saved. The baselines for Squat were not refreshed',
    );
    expect(rederiveWarning(result({ rederiveFailed: ['ex-1', 'ex-9'] }), days)).toBe(
      'Saved. The baselines for Squat, 1 other exercise were not refreshed',
    );
  });

  it('says so when nothing new is marked', () => {
    expect(previewLines(result({ newlyClassified: [] }))[0]).toBe(
      'No new sessions to mark as training',
    );
  });
});

describe('error copy', () => {
  it('reads the handler refusal as invalid input with its own text', () => {
    const error = daysErrorOf(
      new ActionRefusedError({
        code: 'INVALID_INPUT',
        result: { message: 'from must not be after to' },
        status: 400,
        actionId: 'x',
      }),
    );
    expect(error).toEqual({ kind: 'invalid_input', message: 'from must not be after to' });
  });

  it('treats a server-side refusal as not saved', () => {
    expect(daysErrorOf(refused500())).toEqual({ kind: 'not_saved' });
  });

  it('never calls a failed read "not saved"', () => {
    expect(errorCopy(daysReadErrorOf())).not.toMatch(/not saved/i);
  });
});

describe('settleFailure', () => {
  const held = () => {
    let n = 0;
    const ids = createAttemptIds(() => `id-${String(++n)}`);
    const gate = createPreviewGate();
    gate.record(range, result());
    return { ids, gate };
  };

  it('drops the preview and the step id after a mismatch', () => {
    const { ids, gate } = held();
    const input = markInput(range, 'preview');
    const first = ids.idFor('range_preview', input);
    settleFailure(refused('EXPECTED_SESSIONS_MISMATCH'), 'range_preview', ids, gate);
    expect(gate.canConfirm(range)).toBe(false);
    expect(ids.idFor('range_preview', input)).not.toBe(first);
  });

  it('keeps the id and the preview after a transport failure', () => {
    const { ids, gate } = held();
    const input = markInput(range, 'preview');
    const first = ids.idFor('range_preview', input);
    settleFailure(new TypeError('fetch failed'), 'range_preview', ids, gate);
    expect(gate.canConfirm(range)).toBe(true);
    expect(ids.idFor('range_preview', input)).toBe(first);
  });

  it('keeps the id but drops the preview on an indeterminate write', () => {
    const { ids, gate } = held();
    const input = markInput(range, 'mark', 4);
    const first = ids.idFor('range_mark', input);
    settleFailure(new IndeterminateWriteError('unsure', first), 'range_mark', ids, gate);
    expect(gate.canConfirm(range)).toBe(false);
    expect(ids.idFor('range_mark', input)).toBe(first);
  });
});

function refused500(): ActionRefusedError {
  return new ActionRefusedError({
    code: 'action_unavailable',
    result: null,
    status: 500,
    actionId: 'x',
  });
}
