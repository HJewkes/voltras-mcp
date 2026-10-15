import { describe, expect, it } from 'vitest';

import {
  beginSet,
  EMPTY_FOCUS_STATE,
  focusForSet,
  recordSetOutcome,
  reinforcementForSet,
  REINFORCEMENT_SETS,
  type CueFocusId,
  type FocusState,
} from '../focus.js';
import {
  EMPTY_INTERVAL_STATE,
  intervalFor,
  trackInterval,
  type Interval,
  type IntervalState,
} from '../interval.js';

interface SetRun {
  state: FocusState;
  byInterval: Partial<Record<Interval, CueFocusId | null>>;
  reinforcement: CueFocusId | null;
}

function runSet(
  state: FocusState,
  setId: string,
  faults: readonly CueFocusId[],
  options: { exerciseId?: string; reinforcementSets?: number } = {},
): SetRun {
  const byInterval: SetRun['byInterval'] = {};
  let intervals: IntervalState = EMPTY_INTERVAL_STATE;
  const read = (): void => {
    const interval = intervalFor(intervals, 'primary')?.interval;
    if (interval !== undefined) byInterval[interval] = focusForSet(state, setId);
  };

  state = beginSet(state, { exerciseId: options.exerciseId ?? 'ex-row', setId });
  intervals = trackInterval(intervals, { kind: 'set_started', slot: 'primary', setId });
  read();
  intervals = trackInterval(intervals, { kind: 'rep_finalized', slot: 'primary', setId });
  read();
  intervals = trackInterval(intervals, { kind: 'set_ended', slot: 'primary', setId });
  state = recordSetOutcome(state, { setId, faults, reinforcementSets: options.reinforcementSets });
  read();
  return { state, byInterval, reinforcement: reinforcementForSet(state, setId) };
}

function runSets(
  faultsPerSet: readonly (readonly CueFocusId[])[],
  options: { reinforcementSets?: number } = {},
): SetRun[] {
  const runs: SetRun[] = [];
  let state = EMPTY_FOCUS_STATE;
  faultsPerSet.forEach((faults, index) => {
    const run = runSet(state, `set-${index + 1}`, faults, options);
    runs.push(run);
    state = run.state;
  });
  return runs;
}

describe('cue focus', () => {
  it('reads the same focus id in pre, intra and post across five sets of one exercise', () => {
    const runs = runSets([['full_range'], ['full_range'], ['full_range'], ['full_range'], []]);

    const laterSets = runs.slice(1).map((run) => run.byInterval);

    expect(laterSets).toEqual(
      Array.from({ length: 4 }, () => ({
        pre: 'full_range',
        intra: 'full_range',
        post: 'full_range',
      })),
    );
  });

  it('gives the first set of an exercise no focus', () => {
    const [first] = runSets([['full_range']]);

    expect(first?.byInterval).toEqual({ pre: null, intra: null, post: null });
  });

  it('picks range, then lowering control, then smooth drive when several faults read', () => {
    const runs = runSets([['smooth_drive', 'control_lowering'], []]);

    expect(focusForSet(runs[1]!.state, 'set-2')).toBe('control_lowering');
  });

  it('keeps the current focus when a higher-priority fault appears later', () => {
    const runs = runSets([['smooth_drive'], ['smooth_drive', 'full_range'], []]);

    expect(focusForSet(runs[2]!.state, 'set-3')).toBe('smooth_drive');
  });

  it.each([1, 2, REINFORCEMENT_SETS, 5])(
    'reinforces a resolved focus in exactly %i post-set debriefs',
    (reinforcementSets) => {
      const cleanSets = Array.from({ length: reinforcementSets + 3 }, () => []);
      const runs = runSets([['full_range'], ...cleanSets], { reinforcementSets });

      const reinforced = runs.map((run) => run.reinforcement).filter((id) => id !== null);

      expect(reinforced).toEqual(Array.from({ length: reinforcementSets }, () => 'full_range'));
      expect(runs[1]!.reinforcement).toBe('full_range');
    },
  );

  it('defaults to three reinforced sets', () => {
    const runs = runSets([['full_range'], [], [], [], [], []]);

    expect(runs.filter((run) => run.reinforcement !== null)).toHaveLength(3);
  });

  it('drops the focus from the next set once it reads clean', () => {
    const runs = runSets([['full_range'], [], []]);

    expect(focusForSet(runs[2]!.state, 'set-3')).toBeNull();
  });

  it('ends reinforcement and restores the focus when the fault returns', () => {
    const runs = runSets([['full_range'], [], ['full_range'], []]);

    expect(runs[2]!.reinforcement).toBeNull();
    expect(focusForSet(runs[3]!.state, 'set-4')).toBe('full_range');
  });

  it('starts the next focus while reinforcing the resolved one', () => {
    const runs = runSets([['full_range'], ['smooth_drive'], []]);

    expect(runs[1]!.reinforcement).toBe('full_range');
    expect(focusForSet(runs[2]!.state, 'set-3')).toBe('smooth_drive');
  });

  it('keeps each exercise focus separate within a session', () => {
    let state = runSet(EMPTY_FOCUS_STATE, 'row-1', ['full_range']).state;
    state = runSet(state, 'press-1', ['smooth_drive'], { exerciseId: 'ex-press' }).state;
    state = beginSet(state, { exerciseId: 'ex-row', setId: 'row-2' });
    state = beginSet(state, { exerciseId: 'ex-press', setId: 'press-2' });

    expect(focusForSet(state, 'row-2')).toBe('full_range');
    expect(focusForSet(state, 'press-2')).toBe('smooth_drive');
  });

  it('leaves the input state untouched', () => {
    const started = beginSet(EMPTY_FOCUS_STATE, { exerciseId: 'ex-row', setId: 'set-1' });

    recordSetOutcome(started, { setId: 'set-1', faults: ['full_range'] });

    expect(EMPTY_FOCUS_STATE.sets.size).toBe(0);
    expect(started.exercises.size).toBe(0);
  });

  it('ignores an outcome for a set that never started', () => {
    const outcome = recordSetOutcome(EMPTY_FOCUS_STATE, { setId: 'ghost', faults: ['full_range'] });

    expect(outcome).toBe(EMPTY_FOCUS_STATE);
    expect(focusForSet(outcome, 'ghost')).toBeNull();
  });
});
