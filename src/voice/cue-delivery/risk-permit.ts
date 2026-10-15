// The VW-152 intra-set permit behind VMCP_CUES_MIDSET (VW-614, plan section 5).
//
// Safety-adjacent, so every unknown denies: no reading, a reading for another set,
// any band but green, or a lookup that throws. The permit never reads the rep number.

import type { SetRiskReading } from '../../analytics/set-risk.js';
import type { IntraSetPermit } from './budget.js';

/** The reading pinned for `setId` on `slot`, or `undefined` unless that set is active and pinned. */
export type SetRiskReadingFor = (slot: string, setId: string) => SetRiskReading | undefined;

export function riskIntraSetPermit(readingFor: SetRiskReadingFor): IntraSetPermit {
  return ({ slot, setId, settings }) => {
    if (settings.midSetMode === 'on') return true;
    if (settings.midSetMode !== 'risk') return false;
    return greenReadingPermits(readingFor, slot, setId);
  };
}

function greenReadingPermits(readingFor: SetRiskReadingFor, slot: string, setId: string): boolean {
  try {
    const reading = readingFor(slot, setId);
    return reading?.band === 'green' && reading.permitsIntraSet === true;
  } catch {
    return false;
  }
}
