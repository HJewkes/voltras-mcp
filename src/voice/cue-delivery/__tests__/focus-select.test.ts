import type { Phase, Rep, WorkoutSample } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import { FOCUS_SELECT_MARGINS, readSetFaults, selectFocus } from '../focus-select.js';
import { CUE_FOCUS_IDS } from '../focus.js';

const PEAK = 0.8;
const SMOOTH_DRIVE = [0.3, 0.6, PEAK, 0.6, 0.3];
const STALLED_DRIVE = [0.3, PEAK, 0.2, PEAK, 0.3];
const POSITION_FRACTIONS = [0, 0.15, 0.5, 0.85, 1];

interface RepShape {
  rom?: number;
  drive?: readonly number[];
  bounce?: boolean;
}

function samples(rom: number, velocities: readonly number[]): WorkoutSample[] {
  return velocities.map((velocity, i) => ({
    sequence: i,
    timestamp: 1000 + i * 100,
    phase: 1 as WorkoutSample['phase'],
    position: POSITION_FRACTIONS[i]! * rom,
    velocity,
    force: 0,
  }));
}

function phase(overrides: Partial<Phase>): Phase {
  return {
    samples: [],
    startTime: 1000,
    endTime: 1500,
    startPosition: 0,
    endPosition: 0,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 5,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: 0,
    peakVelocity: PEAK,
    peakForce: 0,
    peakLoad: 0,
    ...overrides,
  };
}

function makeRep(repNumber: number, shape: RepShape = {}): Rep {
  const rom = shape.rom ?? 0.5;
  return {
    repNumber,
    concentric: phase({ samples: samples(rom, shape.drive ?? SMOOTH_DRIVE), endPosition: rom }),
    eccentric: phase({
      startPosition: rom,
      peakVelocity: shape.bounce === true ? 1.3 : 0.6,
      _totalHoldDuration: shape.bounce === true ? 0 : 500,
    }),
  };
}

const set = (shapes: readonly RepShape[]): Rep[] => shapes.map((s, i) => makeRep(i + 1, s));
const clean = (count: number): RepShape[] => Array.from({ length: count }, () => ({}));
const decaying = (): RepShape[] => [0.5, 0.48, 0.45, 0.42, 0.38].map((rom) => ({ rom }));

describe('selectFocus', () => {
  it('picks full_range when ROM shrinks across the set', () => {
    expect(selectFocus(set(decaying()))).toBe('full_range');
  });

  it('picks control_lowering when most reps drop fast with no pause at the bottom', () => {
    const shapes = [{}, { bounce: true }, { bounce: true }, { bounce: true }, {}];

    expect(selectFocus(set(shapes))).toBe('control_lowering');
  });

  it('picks smooth_drive when most reps stall in the middle of the lift', () => {
    const shapes = [{ drive: STALLED_DRIVE }, { drive: STALLED_DRIVE }, { drive: STALLED_DRIVE }];

    expect(selectFocus(set(shapes))).toBe('smooth_drive');
  });

  it('picks one focus by the fixed order when every fault reads', () => {
    const shapes = decaying().map((s) => ({ ...s, bounce: true, drive: STALLED_DRIVE }));

    expect(readSetFaults(set(shapes))).toEqual([...CUE_FOCUS_IDS]);
    expect(selectFocus(set(shapes))).toBe('full_range');
  });

  it('prefers control_lowering over smooth_drive when both read', () => {
    const shapes = clean(4).map(() => ({ bounce: true, drive: STALLED_DRIVE }));

    expect(selectFocus(set(shapes))).toBe('control_lowering');
  });

  it('picks no focus for a clean set', () => {
    expect(readSetFaults(set(clean(6)))).toEqual([]);
    expect(selectFocus(set(clean(6)))).toBeNull();
  });

  it('picks no focus when the readings carry nothing to judge', () => {
    const blank: Rep = {
      repNumber: 1,
      concentric: phase({ peakVelocity: 0, _movementSampleCount: 0 }),
      eccentric: phase({ peakVelocity: 0 }),
    };

    expect(selectFocus([blank, { ...blank, repNumber: 2 }, { ...blank, repNumber: 3 }])).toBeNull();
  });

  it('picks no focus for a one-rep set, however faulty the rep', () => {
    expect(selectFocus(set([{ rom: 0.2, bounce: true, drive: STALLED_DRIVE }]))).toBeNull();
    expect(selectFocus([])).toBeNull();
  });

  it('ignores a per-rep fault on fewer than half the reps', () => {
    const shapes = [{ bounce: true, drive: STALLED_DRIVE }, {}, {}, {}];

    expect(selectFocus(set(shapes))).toBeNull();
  });

  it('pins the engineering-default margins', () => {
    expect(FOCUS_SELECT_MARGINS).toEqual({
      bounceVelocityRatioMin: 1.5,
      bounceDwellMsMax: 100,
      hesitationTroughFractionMax: 1 / 3,
      setRepFractionMin: 0.5,
    });
  });

  it('honours injected margins', () => {
    const shapes = [{ bounce: true }, {}, {}, {}];
    const strict = { ...FOCUS_SELECT_MARGINS, setRepFractionMin: 0.25 };

    expect(selectFocus(set(shapes))).toBeNull();
    expect(selectFocus(set(shapes), strict)).toBe('control_lowering');
  });
});
