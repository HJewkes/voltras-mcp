import { describe, expect, it } from 'vitest';

import { judgeBlock } from '../missed-targets.js';

import { block } from './fixtures.js';

describe('judgeBlock', () => {
  it('hits when every prescribed set reached the rep floor', () => {
    const verdict = judgeBlock(block(['100 @ 3 x 5'], [{}, {}, {}]));
    expect(verdict).toMatchObject({ verdict: 'hit', setsShort: false, repMisses: 0 });
  });

  it('counts a multi-set row by its sets field, not as one set', () => {
    expect(judgeBlock(block(['100 @ 3 x 5'], [{ sets: 3 }])).verdict).toBe('hit');
  });

  it('misses when fewer sets were reported than prescribed', () => {
    expect(judgeBlock(block(['100 @ 3 x 5'], [{}, {}]))).toMatchObject({
      verdict: 'miss',
      setsShort: true,
    });
  });

  it('misses when a set fell under the rep floor', () => {
    const verdict = judgeBlock(block(['100 @ 3 x 5'], [{}, {}, { reps: 4 }]));
    expect(verdict).toMatchObject({ verdict: 'miss', setsShort: false, repMisses: 1 });
  });

  it('reads a light row in an undivided block as a warm-up, not a short set', () => {
    const rows = [
      { is_warmup: null, load: 60, reps: 3 },
      ...[1, 2, 3].map(() => ({ is_warmup: null })),
    ];
    expect(judgeBlock(block(['100 @ 3 x 5'], rows)).verdict).toBe('hit');
  });

  it('ignores rows above the divider', () => {
    const rows = [{ is_warmup: true, reps: 1 }, {}, {}, {}];
    expect(judgeBlock(block(['100 @ 3 x 5'], rows)).verdict).toBe('hit');
  });

  it('flags reps the parser filled from the prescription', () => {
    const rows = [1, 2, 3].map(() => ({ decided_by: 'bare_load_reps_from_prescription' }));
    expect(judgeBlock(block(['100 @ 3 x 5'], rows)).repsFromPrescription).toBe(true);
  });

  it('reports a light top set without calling it a miss', () => {
    const rows = [1, 2, 3].map(() => ({ is_warmup: false, load: 95 }));
    expect(judgeBlock(block(['100 @ 3 x 5'], rows))).toMatchObject({
      verdict: 'hit',
      loadShort: true,
    });
  });

  it('has no verdict without a fixed prescription', () => {
    expect(judgeBlock(block(['3 Sets:'], [{}])).verdict).toBe('no-target');
  });
});
