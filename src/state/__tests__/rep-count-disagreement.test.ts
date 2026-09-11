import { describe, it, expect } from 'vitest';

import {
  deriveRepCountDisagreement,
  type RepCountDisagreement,
} from '../rep-count-disagreement.js';

/** The set that filed VMCP-02.59: one real set, four counts, three values. */
const TICKET_SET = {
  analytics_reps: 13,
  device_total: 14,
  device_set_summary: 12,
  device_summary: 12,
} as const;

function report(sources: Parameters<typeof deriveRepCountDisagreement>[0]): RepCountDisagreement {
  const out = deriveRepCountDisagreement(sources);
  if (out === undefined) throw new Error('expected a disagreement report');
  return out;
}

describe('deriveRepCountDisagreement — what it reports', () => {
  it('names every count that exists, including the pair that agree with each other', () => {
    expect(report(TICKET_SET).counts.map((c) => [c.source, c.count])).toEqual([
      ['analytics_reps', 13],
      ['device_total', 14],
      ['device_set_summary', 12],
      ['device_summary', 12],
    ]);
  });

  it('says where each count came from in words that name no internal field', () => {
    for (const reading of report(TICKET_SET).counts) {
      expect(reading.provenance.length).toBeGreaterThan(20);
      expect(reading.provenance).not.toContain(reading.source);
    }
  });

  it('reports every disagreeing pair and the size of the gap', () => {
    expect(report(TICKET_SET).deltas).toEqual([
      { between: ['analytics_reps', 'device_total'], difference: 1 },
      { between: ['analytics_reps', 'device_set_summary'], difference: 1 },
      { between: ['analytics_reps', 'device_summary'], difference: 1 },
      { between: ['device_total', 'device_set_summary'], difference: 2 },
      { between: ['device_total', 'device_summary'], difference: 2 },
    ]);
  });

  it('omits the pairs that agree rather than reporting them as a zero gap', () => {
    const deltas = report(TICKET_SET).deltas;
    expect(deltas.some((d) => d.difference === 0)).toBe(false);
    expect(
      deltas.some(
        (d) => d.between[0] === 'device_set_summary' && d.between[1] === 'device_summary',
      ),
    ).toBe(false);
  });

  it('reports the gap regardless of which side is larger', () => {
    const higherDerived = report({ analytics_reps: 14, device_total: 13 });
    const higherDevice = report({ analytics_reps: 13, device_total: 14 });
    expect(higherDerived.deltas).toEqual(higherDevice.deltas);
  });
});

describe('deriveRepCountDisagreement — when there is nothing to report', () => {
  it('returns no report when every count present agrees', () => {
    expect(
      deriveRepCountDisagreement({
        analytics_reps: 10,
        device_total: 10,
        device_set_summary: 10,
        device_summary: 10,
      }),
    ).toBeUndefined();
  });

  it('returns no report when only one count exists — one number cannot disagree', () => {
    expect(deriveRepCountDisagreement({ analytics_reps: 10 })).toBeUndefined();
  });

  it('returns no report when no count exists at all', () => {
    expect(deriveRepCountDisagreement({})).toBeUndefined();
  });
});

describe('deriveRepCountDisagreement — the exact-equality boundary', () => {
  it('reports a gap of exactly one', () => {
    expect(report({ analytics_reps: 12, device_total: 13 }).deltas).toEqual([
      { between: ['analytics_reps', 'device_total'], difference: 1 },
    ]);
  });

  it('reports nothing at a gap of exactly zero', () => {
    expect(deriveRepCountDisagreement({ analytics_reps: 12, device_total: 12 })).toBeUndefined();
  });

  it('does not suppress a one-rep gap as insignificant (VMCP-02.23 / VMCP-02.42)', () => {
    // The one-rep over-count on a cable-engagement rep is the case the ticket
    // exists for. A tolerance of any size would hide it.
    expect(report({ analytics_reps: 8, device_total: 9 }).deltas).toHaveLength(1);
  });
});

describe('deriveRepCountDisagreement — an absent source stays absent', () => {
  it('leaves a source out of counts entirely rather than entering it as zero', () => {
    const out = report({ analytics_reps: 13, device_total: 14 });
    expect(out.counts.map((c) => c.source)).toEqual(['analytics_reps', 'device_total']);
    expect(out.counts.some((c) => c.count === 0)).toBe(false);
  });

  it('never compares against a source that sent nothing', () => {
    const out = report({ analytics_reps: 13, device_total: 14 });
    expect(out.deltas.flatMap((d) => d.between)).not.toContain('device_set_summary');
    expect(out.deltas.flatMap((d) => d.between)).not.toContain('device_summary');
  });

  it('distinguishes an absent count from a device count of zero', () => {
    // A device that counted no reps is a real, reportable disagreement with a
    // derived array that found some. An absent count is not.
    const counted = report({ analytics_reps: 3, device_total: 0 });
    expect(counted.deltas).toEqual([
      { between: ['analytics_reps', 'device_total'], difference: 3 },
    ]);
    expect(deriveRepCountDisagreement({ analytics_reps: 3 })).toBeUndefined();
  });
});

describe('deriveRepCountDisagreement — the reconciliation guard', () => {
  // This suite is the regression that a well-meaning future simplification
  // would trip. Collapsing four counts into one "correct" number, max()ing
  // them, or averaging them all look like cleanups and all destroy the point
  // of the report: the device counts reps, this server only enriches them.

  it('preserves every count verbatim — no max, no average, no rounding to a winner', () => {
    const out = report(TICKET_SET);
    expect(out.counts.map((c) => c.count)).toEqual([13, 14, 12, 12]);
    const maxCount = Math.max(...out.counts.map((c) => c.count));
    expect(out.counts.filter((c) => c.count === maxCount)).toHaveLength(1);
  });

  it('never carries a single resolved count alongside the disagreeing ones', () => {
    const out = report(TICKET_SET) as unknown as Record<string, unknown>;
    for (const key of ['rep_count', 'repCount', 'resolved', 'reconciled', 'count', 'winner']) {
      expect(out).not.toHaveProperty(key);
    }
    expect(Object.keys(out).sort()).toEqual(['counts', 'deltas', 'verdict']);
  });

  it('leaves the verdict null however wide the gap is', () => {
    expect(report({ analytics_reps: 1, device_total: 40 }).verdict).toBeNull();
    expect(report({ analytics_reps: 12, device_total: 13 }).verdict).toBeNull();
  });

  it('recomputes from its inputs rather than caching a previous answer', () => {
    const first = deriveRepCountDisagreement({ analytics_reps: 13, device_total: 14 });
    const corrected = deriveRepCountDisagreement({ analytics_reps: 14, device_total: 14 });
    expect(first).toBeDefined();
    expect(corrected).toBeUndefined();
  });

  it('returns an independent report each call, so a mutated one cannot poison the next', () => {
    const a = report(TICKET_SET);
    a.counts.length = 0;
    a.deltas.length = 0;
    expect(report(TICKET_SET).counts).toHaveLength(4);
    expect(report(TICKET_SET).deltas).toHaveLength(5);
  });
});
