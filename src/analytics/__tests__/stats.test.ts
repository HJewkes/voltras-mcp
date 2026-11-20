import { describe, expect, it } from 'vitest';

import { median } from '../stats.js';
import { medianEligibleRom, readRomIntegrity } from '../rom-integrity.js';
import { repsToThresholdRange } from '../reps-to-threshold-range.js';
import { medianRomMetres } from '../setup-comparability.js';
import { plateauWindows } from '../../dashboard/read-models/history-lifts.js';
import { isOutlier } from '../../state/rep-eligibility.js';
import { measureSampleRateHz } from '../../state/set-capture.js';
import { medianConcentricPeakForce } from '../../state/weight-implied-watch.js';

describe('median', () => {
  it('is undefined for an empty list', () => {
    expect(median([])).toBeUndefined();
  });

  it('is the middle value of an odd-length list, whatever its order', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it('averages the two middle values of an even-length list', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('leaves its input in the order it was given', () => {
    const values = [3, 1, 2];

    median(values);

    expect(values).toEqual([3, 1, 2]);
  });
});

describe('median callers on empty input', () => {
  it('calls nothing an outlier against no comparators', () => {
    expect(isOutlier(5, [], 1.5)).toBe(false);
  });

  it('reads no eligible ROM from a set with no reps', () => {
    expect(medianEligibleRom([])).toBeNull();
    expect(readRomIntegrity([]).perRep).toEqual([]);
  });

  it('gives no setup ROM when no ROM is positive', () => {
    expect(medianRomMetres([])).toBeUndefined();
    expect(medianRomMetres([0, -0.2])).toBeUndefined();
  });

  it('gives no range, plateau, force median or sample rate from no data', () => {
    expect(repsToThresholdRange([])).toBeNull();
    expect(plateauWindows([])).toEqual([]);
    expect(medianConcentricPeakForce([])).toBeNull();
    expect(measureSampleRateHz([])).toBeUndefined();
  });
});
