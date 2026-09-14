// VW-369 (research VW-346 R6): fixtures for the recomposition re-ask.
//
// Every boundary fixture sits exactly on or beside `boundaryReAskIndex`, and
// every loss fixture on or beside a cited band floor, so mutating either
// constant moves a fixture across the gate and fails a named test (see the PR
// body for the mutation run).

import { describe, expect, it } from 'vitest';

import { classifyCumulativeLossPct, type CumulativeLossFacts } from '../cumulative-loss.js';
import {
  evaluateRecompDegradation,
  RECOMP_ADVISORY_LEVELS,
  RECOMP_DEGRADATION_CODE,
  RECOMP_DEGRADATION_CONSTANTS,
  recompAdvisoryLevelRank,
  type RecompDegradationInput,
  type RecompResponseRecord,
} from '../recomp-degradation.js';

const C = RECOMP_DEGRADATION_CONSTANTS;

/** Loss facts whose band comes from the shared module, never restated here. */
function lossFacts(pctLost: number): CumulativeLossFacts {
  return {
    pctLostSincePhaseStart: pctLost,
    band: classifyCumulativeLossPct(pctLost),
    bandFloorPct: null,
    weeksInPhase: 9,
    rateClass: 'reportable',
    weeklyDeltaLbs: -1,
    slopeClass: 'similar',
    meanSeries: [],
  };
}

function input(overrides: Partial<RecompDegradationInput> = {}): RecompDegradationInput {
  return {
    phase: 'recomposition',
    recompMode: 'hold',
    boundariesSincePhaseStart: 1,
    cumulativeLoss: lossFacts(0),
    responses: [],
    ...overrides,
  };
}

/** An answer filed against a proposal that carried the block-boundary ask. */
function answeredAtSecond(response: 'accepted' | 'declined'): RecompResponseRecord {
  return {
    level: 'boundary',
    boundaryCount: C.boundaryReAskIndex,
    response,
    triggerKinds: ['block-boundary'],
  };
}

describe('recomposition re-ask — silence', () => {
  it('says nothing when the declared phase is not a recomposition', () => {
    const result = evaluateRecompDegradation(input({ phase: 'fat-loss' }));
    expect(result.proposal).toBeNull();
    expect(result.silentReason).toContain('fat-loss');
  });

  it('says nothing at the first block boundary, below every other threshold', () => {
    const result = evaluateRecompDegradation(input({ boundariesSincePhaseStart: 1 }));
    expect(result.proposal).toBeNull();
    expect(result.silentReason).toContain('boundary 1 of 2');
  });

  it('says nothing at a later boundary once the block-boundary ask was answered', () => {
    const result = evaluateRecompDegradation(
      input({ boundariesSincePhaseStart: 3, responses: [answeredAtSecond('accepted')] }),
    );
    expect(result.proposal).toBeNull();
    expect(result.silentReason).toContain('already been answered');
  });

  it('says nothing on a loss one tenth below the noticeable floor', () => {
    const justUnder = C.noticeableBandFloorPct - 0.1;
    const result = evaluateRecompDegradation(input({ cumulativeLoss: lossFacts(justUnder) }));
    expect(result.proposal).toBeNull();
  });

  it('says nothing on one leanness reading, because a rung needs two', () => {
    const result = evaluateRecompDegradation(input({ currentLeannessBand: 'lean' }));
    expect(result.proposal).toBeNull();
  });

  it('says nothing when the leanness band has not moved', () => {
    const result = evaluateRecompDegradation(
      input({ phaseStartLeannessBand: 'moderate', currentLeannessBand: 'moderate' }),
    );
    expect(result.proposal).toBeNull();
  });

  it('says nothing with no bodyweight series logged at all', () => {
    const result = evaluateRecompDegradation(input({ cumulativeLoss: null }));
    expect(result.proposal).toBeNull();
  });
});

describe('recomposition re-ask — triggers', () => {
  it('fires at the second block boundary', () => {
    const result = evaluateRecompDegradation(input({ boundariesSincePhaseStart: 2 }));
    expect(result.proposal?.triggers.map((t) => t.kind)).toEqual(['block-boundary']);
    expect(result.proposal?.level).toBe('boundary');
    expect(result.proposal?.code).toBe(RECOMP_DEGRADATION_CODE);
  });

  it('fires on cumulative loss at the noticeable floor and asks the fat-loss question', () => {
    const result = evaluateRecompDegradation(
      input({ cumulativeLoss: lossFacts(C.noticeableBandFloorPct) }),
    );
    expect(result.proposal?.level).toBe('noticeable');
    expect(result.proposal?.triggers[0].detail).toContain('noticeable diet fatigue');
    expect(result.proposal?.triggers[0].detail).toContain('Is this a fat-loss phase now?');
    expect(result.proposal?.triggers[0].detail).not.toContain('significant');
  });

  it('fires on cumulative loss at the significant floor with the stronger wording', () => {
    const result = evaluateRecompDegradation(
      input({ cumulativeLoss: lossFacts(C.significantBandFloorPct) }),
    );
    expect(result.proposal?.level).toBe('significant');
    expect(result.proposal?.triggers[0].detail).toContain('significant diet fatigue');
    expect(result.proposal?.triggers[0].detail).not.toContain('Is this a fat-loss phase now?');
  });

  it('fires when the declared leanness band drops a rung', () => {
    const result = evaluateRecompDegradation(
      input({ phaseStartLeannessBand: 'moderate', currentLeannessBand: 'lean' }),
    );
    expect(result.proposal?.triggers.map((t) => t.kind)).toEqual(['leanness-rung']);
    expect(result.proposal?.triggers[0].detail).toContain(
      'rp:rp-s12-goal-magnitude-shrinks-each-phase',
    );
  });

  it('reports every trigger that fired and takes the strongest as the level', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 2,
        cumulativeLoss: lossFacts(C.significantBandFloorPct),
        phaseStartLeannessBand: 'high',
        currentLeannessBand: 'lean',
      }),
    );
    expect(result.proposal?.triggers).toHaveLength(3);
    expect(result.proposal?.level).toBe('significant');
  });

  it('cites a note id on every trigger', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 2,
        cumulativeLoss: lossFacts(C.significantBandFloorPct),
        phaseStartLeannessBand: 'high',
        currentLeannessBand: 'lean',
      }),
    );
    for (const trigger of result.proposal?.triggers ?? []) {
      expect(trigger.rpIds.length).toBeGreaterThan(0);
      for (const id of trigger.rpIds) expect(id.startsWith('rp:rp-s')).toBe(true);
    }
  });
});

describe('recomposition re-ask — the proposal', () => {
  const fired = evaluateRecompDegradation(input({ boundariesSincePhaseStart: 2 }));

  it('offers both declared directions and keeping the declared recomposition mode', () => {
    expect(fired.proposal?.options).toEqual([
      expect.objectContaining({ action: 'switch-phase', target: 'fat-loss' }),
      expect.objectContaining({ action: 'switch-phase', target: 'gain' }),
      expect.objectContaining({ action: 'keep-recomposition', target: 'hold' }),
    ]);
  });

  it('omits the keep option when no recomposition mode was ever declared', () => {
    const noMode = evaluateRecompDegradation({
      ...input({ boundariesSincePhaseStart: 2 }),
      recompMode: undefined,
    });
    expect(noMode.proposal?.options.map((o) => o.action)).toEqual(['switch-phase', 'switch-phase']);
  });

  it('says plainly that answering it changes nothing', () => {
    expect(fired.proposal?.message).toContain('Nothing is changed by this question');
  });

  it('carries the inputs it fired on and the thresholds in force', () => {
    expect(fired.proposal?.inputs).toMatchObject({
      boundariesSincePhaseStart: 2,
      triggerKinds: ['block-boundary'],
    });
    expect(fired.proposal?.thresholds).toEqual({ ...C });
  });
});

describe('recomposition re-ask — an unanswered ask comes back', () => {
  it('asks again at the third boundary when the second went unanswered', () => {
    const result = evaluateRecompDegradation(input({ boundariesSincePhaseStart: 3 }));
    expect(result.proposal?.triggers.map((t) => t.kind)).toEqual(['block-boundary']);
    expect(result.proposal?.triggers[0].detail).toContain('3 block boundaries');
  });

  it('asks again at the fourth boundary too, because silence is not an answer', () => {
    const result = evaluateRecompDegradation(input({ boundariesSincePhaseStart: 4 }));
    expect(result.proposal?.level).toBe('boundary');
  });

  it('goes quiet for good once the ask is accepted', () => {
    for (const boundary of [2, 3, 7]) {
      const result = evaluateRecompDegradation(
        input({
          boundariesSincePhaseStart: boundary,
          responses: [answeredAtSecond('accepted')],
        }),
      );
      expect(result.proposal).toBeNull();
    }
  });

  it('stays silent at the third boundary when the second was declined', () => {
    const result = evaluateRecompDegradation(
      input({ boundariesSincePhaseStart: 3, responses: [answeredAtSecond('declined')] }),
    );
    expect(result.proposal).toBeNull();
  });
});

describe('recomposition re-ask — decline persistence', () => {
  const declinedAtSecond = [answeredAtSecond('declined')];

  it('does not re-offer the same evidence at the boundary it was declined on', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 2,
        responses: [
          {
            level: 'noticeable',
            boundaryCount: 2,
            response: 'declined',
            triggerKinds: ['block-boundary', 'cumulative-loss'],
          },
        ],
        cumulativeLoss: lossFacts(C.noticeableBandFloorPct),
      }),
    );
    expect(result.proposal).toBeNull();
    expect(result.silentReason).toContain('declined');
  });

  it('re-offers a declined proposal once a later boundary carries a qualifying trigger', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 3,
        responses: declinedAtSecond,
        cumulativeLoss: lossFacts(C.noticeableBandFloorPct),
      }),
    );
    expect(result.proposal?.level).toBe('noticeable');
  });

  it('re-offers inside the same boundary when the band escalates above the declined one', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 2,
        responses: [
          { level: 'noticeable', boundaryCount: 2, response: 'declined', triggerKinds: [] },
        ],
        cumulativeLoss: lossFacts(C.significantBandFloorPct),
      }),
    );
    expect(result.proposal?.level).toBe('significant');
  });

  it('keeps a stronger decline holding against a weaker trigger', () => {
    const result = evaluateRecompDegradation(
      input({
        boundariesSincePhaseStart: 2,
        responses: [
          {
            level: 'significant',
            boundaryCount: 2,
            response: 'declined',
            triggerKinds: ['cumulative-loss'],
          },
        ],
      }),
    );
    expect(result.proposal).toBeNull();
  });
});

describe('recomposition re-ask — the level vocabulary', () => {
  it('ranks the two measured bands above the boundary and the self-reported rung', () => {
    expect([...RECOMP_ADVISORY_LEVELS]).toEqual([
      'boundary',
      'leanness-rung',
      'noticeable',
      'significant',
    ]);
    expect(recompAdvisoryLevelRank('significant')).toBeGreaterThan(
      recompAdvisoryLevelRank('leanness-rung'),
    );
  });

  it('reads its band floors off the shared cumulative-loss module', () => {
    expect(classifyCumulativeLossPct(C.noticeableBandFloorPct)).toBe('noticeable');
    expect(classifyCumulativeLossPct(C.significantBandFloorPct)).toBe('significant');
  });
});
