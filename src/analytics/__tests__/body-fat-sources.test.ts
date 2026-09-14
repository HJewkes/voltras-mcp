// Tests for the body-fat source table and the same-device delta (VW-364).
//
// The tier column is pinned as a LITERAL MAP rather than asserted structurally.
// That is what makes the mutation control bite: swapping the tiers of `dexa`
// and `consumer_bia` — a change no type, no lint rule and no schema would
// notice — fails this file, because the map says which source sits where.

import { describe, expect, it } from 'vitest';
import {
  BODY_FAT_SOURCES,
  BODY_FAT_SOURCE_TIERS,
  DELTA_REFUSAL_DIFFERENT_SOURCE,
  DELTA_REFUSAL_NO_CHANGE_ERROR,
  isBodyFatSource,
  sameDeviceDelta,
  type BodyFatReading,
  type BodyFatSource,
  type BodyFatTier,
} from '../body-fat-sources.js';

function reading(
  bodyFatPct: number,
  source: BodyFatSource,
  measuredAt = '2026-09-13T09:00:00.000Z',
): BodyFatReading {
  return { measuredAt, bodyFatPct, source };
}

/** The tier of every tabulated source, transcribed from VW-370. */
const EXPECTED_TIERS: Record<BodyFatSource, BodyFatTier> = {
  mri: 'reference',
  ct: 'reference',
  dexa: 'high',
  bodpod: 'moderate',
  hydrostatic_measured_rv: 'reference',
  hydrostatic_predicted_rv: 'moderate',
  mf_bia: 'moderate',
  consumer_bia: 'low',
  skinfold_7site: 'moderate',
  skinfold_3_4_site: 'low',
  navy_tape: 'low',
  scan_3d: 'low',
  ultrasound: 'low',
  other: 'low',
};

/** Which sources VW-370 §9 publishes a change SEE for, and what it is. */
const EXPECTED_CHANGE_SEE: Partial<Record<BodyFatSource, number>> = {
  dexa: 5.0,
  mf_bia: 2.6,
  consumer_bia: 2.6,
};

describe('BODY_FAT_SOURCE_TIERS', () => {
  it('has a row for every source in the enum, and no extra rows', () => {
    expect(Object.keys(BODY_FAT_SOURCE_TIERS).sort()).toEqual([...BODY_FAT_SOURCES].sort());
  });

  it('places every source in the tier VW-370 supports', () => {
    for (const source of BODY_FAT_SOURCES) {
      expect(BODY_FAT_SOURCE_TIERS[source].tier).toBe(EXPECTED_TIERS[source]);
    }
  });

  it('carries a change SEE only where VW-370 publishes one', () => {
    for (const source of BODY_FAT_SOURCES) {
      expect(BODY_FAT_SOURCE_TIERS[source].changeSeePctPoints).toBe(
        EXPECTED_CHANGE_SEE[source] ?? null,
      );
    }
  });

  it('cites at least one source for every row except `other`', () => {
    for (const source of BODY_FAT_SOURCES) {
      const row = BODY_FAT_SOURCE_TIERS[source];
      if (source === 'other') {
        expect(row.citationIds).toEqual([]);
      } else {
        expect(row.citationIds.length).toBeGreaterThan(0);
      }
      expect(row.note.length).toBeGreaterThan(0);
    }
  });

  it('labels every null figure in its note rather than leaving it bare', () => {
    for (const source of BODY_FAT_SOURCES) {
      const row = BODY_FAT_SOURCE_TIERS[source];
      const hasNull = row.changeSeePctPoints === null || row.absoluteSeePctPoints === null;
      if (hasNull) {
        expect(row.note).toMatch(/unsourced|no change SEE|no row in VW-370|no SEE/i);
      }
    }
  });

  it('keeps every stored figure positive and in percentage points', () => {
    for (const source of BODY_FAT_SOURCES) {
      const { changeSeePctPoints, absoluteSeePctPoints } = BODY_FAT_SOURCE_TIERS[source];
      if (changeSeePctPoints !== null) expect(changeSeePctPoints).toBeGreaterThan(0);
      if (absoluteSeePctPoints !== null) expect(absoluteSeePctPoints).toBeGreaterThan(0);
    }
  });

  it('recognises exactly the tabulated sources', () => {
    for (const source of BODY_FAT_SOURCES) expect(isBodyFatSource(source)).toBe(true);
    expect(isBodyFatSource('bia')).toBe(false);
    expect(isBodyFatSource('')).toBe(false);
  });
});

describe('sameDeviceDelta', () => {
  it('reads a movement inside the band as no measurable change, with no direction word', () => {
    const result = sameDeviceDelta([
      reading(34.0, 'consumer_bia', '2026-06-01T09:00:00.000Z'),
      reading(32.0, 'consumer_bia', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result.reason).toBeNull();
    expect(result.delta).toEqual({
      deltaPctPoints: -2.0,
      bandPctPoints: 2.6,
      verdict: 'no measurable change',
    });
  });

  // Endpoints chosen so the subtraction is exact in binary floating point;
  // the band edge is inclusive, and a fixture that lands a hair either side of
  // it would test the arithmetic rather than the rule.
  it('reads a movement exactly at the band edge as no measurable change', () => {
    const result = sameDeviceDelta([
      reading(35.0, 'dexa', '2026-06-01T09:00:00.000Z'),
      reading(30.0, 'dexa', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result.delta).toEqual({
      deltaPctPoints: -5.0,
      bandPctPoints: 5.0,
      verdict: 'no measurable change',
    });
  });

  it('reads a movement past the band as a decrease', () => {
    const result = sameDeviceDelta([
      reading(34.0, 'consumer_bia', '2026-06-01T09:00:00.000Z'),
      reading(30.0, 'consumer_bia', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result.delta?.verdict).toBe('decrease');
    expect(result.delta?.deltaPctPoints).toBeCloseTo(-4.0, 10);
  });

  it('reads a movement past the band as an increase', () => {
    const result = sameDeviceDelta([
      reading(30.0, 'mf_bia', '2026-06-01T09:00:00.000Z'),
      reading(34.0, 'mf_bia', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result.delta?.verdict).toBe('increase');
  });

  it('bands a DXA pair on the wider DXA change error, not the bioimpedance one', () => {
    const result = sameDeviceDelta([
      reading(34.0, 'dexa', '2026-06-01T09:00:00.000Z'),
      reading(30.0, 'dexa', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result.delta).toEqual({
      deltaPctPoints: -4.0,
      bandPctPoints: 5.0,
      verdict: 'no measurable change',
    });
  });

  it('refuses a cross-source pair and says why', () => {
    const result = sameDeviceDelta([
      reading(34.0, 'consumer_bia', '2026-06-01T09:00:00.000Z'),
      reading(29.0, 'dexa', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result).toEqual({ delta: null, reason: DELTA_REFUSAL_DIFFERENT_SOURCE });
  });

  it('refuses a same-source pair whose source publishes no change error', () => {
    const result = sameDeviceDelta([
      reading(34.0, 'navy_tape', '2026-06-01T09:00:00.000Z'),
      reading(28.0, 'navy_tape', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(result).toEqual({ delta: null, reason: DELTA_REFUSAL_NO_CHANGE_ERROR });
  });

  it('never returns a delta and a reason together', () => {
    for (const source of BODY_FAT_SOURCES) {
      const result = sameDeviceDelta([
        reading(34.0, source, '2026-06-01T09:00:00.000Z'),
        reading(28.0, source, '2026-09-01T09:00:00.000Z'),
      ]);
      expect(result.delta === null).toBe(result.reason !== null);
    }
  });
});
