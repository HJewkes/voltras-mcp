// Prescribed sets x reps against what was reported, one block at a time.

import { countMissed, type TargetVerdict } from '../../../src/analytics/target-verdict.js';

import { isWorkRow } from './log-rules.js';
import { blockTarget, type PrescriptionTarget } from './prescription.js';
import type { Block, SetRecord } from './types.js';

/**
 * In a block with no warm-up divider, a row under this share of the prescribed load is read as
 * a warm-up, so a light ramp set cannot count toward the prescription or miss its rep floor.
 */
export const UNDIVIDED_WARMUP_LOAD_SHARE = 0.9;

export interface BlockVerdict {
  verdict: TargetVerdict;
  setsShort: boolean;
  repMisses: number;
  /** The heaviest matched set sits under the prescribed load. Reported, not part of the verdict. */
  loadShort: boolean;
  /** Reps were filled from the prescription by the parser, so the rep check cannot fail. */
  repsFromPrescription: boolean;
  target: PrescriptionTarget | null;
  /** Sets matched to the prescription, by the rows' `sets` field. */
  reportedSets: number;
  /** The lowest rep count among the matched sets; `null` when none. */
  minReps: number | null;
}

function matchedRows(block: Block, loadLbs: number | null, warmupShare: number): SetRecord[] {
  const work = block.rows.filter(isWorkRow);
  if (loadLbs === null) return work;
  const atLoad = work.filter(
    (row) => row.is_warmup === false || row.load === null || row.load >= loadLbs * warmupShare,
  );
  return atLoad.length > 0 ? atLoad : work;
}

const NO_TARGET: BlockVerdict = {
  verdict: 'no-target',
  setsShort: false,
  repMisses: 0,
  loadShort: false,
  repsFromPrescription: false,
  target: null,
  reportedSets: 0,
  minReps: null,
};

/** A block misses when it reports fewer sets than prescribed or any set under the rep floor. */
export function judgeBlock(
  block: Block,
  warmupShare: number = UNDIVIDED_WARMUP_LOAD_SHARE,
): BlockVerdict {
  const target = blockTarget(block.prescriptionLines);
  if (target === null) return NO_TARGET;
  const rows = matchedRows(block, target.loadLbs, warmupShare);
  if (rows.length === 0) return { ...NO_TARGET, target, verdict: 'miss', setsShort: true };
  const reported = rows.reduce((sum, row) => sum + row.sets, 0);
  const repCounts = rows.flatMap((row) => Array<number>(row.sets).fill(row.reps));
  const repMisses = target.repsLow === null ? 0 : (countMissed(repCounts, target.repsLow) ?? 0);
  const setsShort = reported < target.sets;
  const topLoad = Math.max(...rows.map((row) => row.load ?? 0));
  return {
    verdict: setsShort || repMisses > 0 ? 'miss' : 'hit',
    setsShort,
    repMisses,
    loadShort: target.loadLbs !== null && topLoad < target.loadLbs,
    repsFromPrescription: rows.some((row) => row.decided_by.includes('bare_load')),
    target,
    reportedSets: reported,
    minReps: Math.min(...repCounts),
  };
}
